import { env, exports } from "cloudflare:workers";
import { generateSignedCookie } from "hono/cookie";
import { finalizeEvent, getPublicKey, type EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORGANISATION_ID } from "@bitig/core";
import { D1SessionStore, D1UserStore } from "@bitig/storage-d1";
import { sha256Hex } from "../src/auth-crypto";
import { parseConfig } from "../src/config";
import { createApp } from "../src/index";
import { FakeMailer } from "../src/mailer";
import { AUTH_FAIL_POLICY } from "../src/rate-limit";
import { NOSTR_REGISTER_RATE_MAX } from "../src/routes/session";
import type { NostrProfileFetcher } from "../src/nostr-profile";
import { NOSTR_SYNC_RATE_MAX } from "../src/routes/me";
import { SESSION_COOKIE } from "../src/session";
import {
  TEST_AUTH_USER,
  TEST_BOOTSTRAP_EMAIL,
  TEST_NOSTR_PUBKEY,
  TEST_NOSTR_SECRET_KEY,
  TEST_SESSION_SECRET,
} from "./constants";

const BASE_URL = "https://bitig.test";
const COOKIE_NAME = `__Host-${SESSION_COOKIE}`;
const AUTHENTICATED_PATH = "/api/missing";
const OTHER_SECRET_KEY = new Uint8Array(32).fill(2);
let ipCounter = 0;

function uniqueIp(): string {
  ipCounter += 1;
  return `198.51.100.${String(ipCounter)}`;
}

function request(path: string, init: RequestInit & { ip?: string; cookie?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", init.ip ?? uniqueIp());
  if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }));
}

async function signedLoginEvent(secretKey: Uint8Array = TEST_NOSTR_SECRET_KEY) {
  const challenge = await request("/api/auth/challenge", {
    method: "POST",
    headers: { Origin: BASE_URL, "X-Bitig-Request": "true" },
  });
  expect(challenge.status).toBe(200);
  const body = await challenge.json<{ event: EventTemplate }>();
  return finalizeEvent(body.event, secretKey);
}

function submitLogin(event: unknown): Promise<Response> {
  return request("/api/auth/nostr", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
    body: JSON.stringify(event),
  });
}

function cookiePair(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

async function signedCookie(rawToken: string, secret = TEST_SESSION_SECRET): Promise<string> {
  const header = await generateSignedCookie(SESSION_COOKIE, rawToken, secret, {
    prefix: "host",
    secure: true,
    path: "/",
  });
  return header.split(";")[0] ?? "";
}

describe("NIP-07 dashboard login", () => {
  it("sets a hardened session cookie for an authorized signature", async () => {
    const res = await submitLogin(await signedLoginEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: TEST_NOSTR_PUBKEY });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
  });

  it("rejects forged signatures, malformed events, and foreign origins", async () => {
    const event = await signedLoginEvent(OTHER_SECRET_KEY);
    expect((await submitLogin({ ...event, pubkey: TEST_NOSTR_PUBKEY })).status).toBe(401);
    expect((await submitLogin({ kind: 22242 })).status).toBe(400);
    const own = await signedLoginEvent();
    const foreign = await request("/api/auth/nostr", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: JSON.stringify(own),
    });
    expect(foreign.status).toBe(403);
  });

  it("registers a non-allowlisted key as an ordinary user who must onboard", async () => {
    const secretKey = new Uint8Array(32).fill(3);
    const pubkey = getPublicKey(secretKey);
    const res = await submitLogin(await signedLoginEvent(secretKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: pubkey });

    const me = await request("/api/auth/me", { cookie: cookiePair(res) });
    const body = await me.json<{
      user: { platformRole: string; displayName: string; username: string };
      memberships: unknown[];
      needsOnboarding: boolean;
    }>();
    expect(body.user.platformRole).toBe("user");
    expect(body.user.displayName).toBe(`Nostr (${pubkey.slice(0, 8)})`);
    expect(body.user.username).toBe(`nostr-${pubkey.slice(0, 16)}`);
    expect(body.memberships).toEqual([]);
    expect(body.needsOnboarding).toBe(true);

    // A second sign-in reuses the same account without promoting it.
    const again = await submitLogin(await signedLoginEvent(secretKey));
    expect(again.status).toBe(200);
    const stored = await new D1UserStore(env.DB).getByEmail(`${pubkey}@nostr.local`);
    expect(stored?.platformRole).toBe("user");
  });

  it("makes an allowlisted key a platform admin and default organisation owner", async () => {
    const res = await submitLogin(await signedLoginEvent());
    const me = await request("/api/auth/me", { cookie: cookiePair(res) });
    const body = await me.json<{
      user: { platformRole: string };
      memberships: { organisation: { id: string }; role: string }[];
      needsOnboarding: boolean;
    }>();
    expect(body.user.platformRole).toBe("admin");
    expect(body.memberships).toContainEqual(
      expect.objectContaining({ organisation: expect.objectContaining({ id: DEFAULT_ORGANISATION_ID }) as unknown, role: "owner" }),
    );
    expect(body.needsOnboarding).toBe(false);
  });

  it("rate limits new Nostr registrations per IP", async () => {
    const ip = uniqueIp();
    for (let index = 0; index < NOSTR_REGISTER_RATE_MAX; index += 1) {
      const secretKey = new Uint8Array(32).fill(0x40 + index);
      const event = await signedLoginEvent(secretKey);
      const res = await request("/api/auth/nostr", {
        ip,
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify(event),
      });
      expect(res.status).toBe(200);
    }
    const blocked = await request("/api/auth/nostr", {
      ip,
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify(await signedLoginEvent(new Uint8Array(32).fill(0x7f))),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
  });

  it("consumes a challenge exactly once", async () => {
    const event = await signedLoginEvent();
    expect((await submitLogin(event)).status).toBe(200);
    expect((await submitLogin(event)).status).toBe(401);
  });

  it("rejects a changed timestamp and an expired challenge", async () => {
    const event = await signedLoginEvent();
    expect(
      (await submitLogin(finalizeEvent({ ...event, created_at: event.created_at + 1 }, TEST_NOSTR_SECRET_KEY))).status,
    ).toBe(401);

    const nonce = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000) - 60;
    const stub = env.LOGIN_CHALLENGE.get(env.LOGIN_CHALLENGE.idFromName(nonce));
    await stub.issue({ origin: BASE_URL, createdAt, expiresAt: Date.now() - 1 });
    const expired = finalizeEvent(
      {
        kind: 22242,
        created_at: createdAt,
        content: "Sign in to Bitig",
        tags: [
          ["challenge", nonce],
          ["origin", BASE_URL],
          ["action", "login"],
        ],
      },
      TEST_NOSTR_SECRET_KEY,
    );
    expect((await submitLogin(expired)).status).toBe(401);
  });
});

describe("Nostr profile fill on sign-in", () => {
  function createProfileApp(fetcher: NostrProfileFetcher) {
    const app = createApp({ nostrProfileFetcher: fetcher });
    // No execution context here, so the background sync is awaited before the response returns.
    return (path: string, init: RequestInit & { cookie?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", uniqueIp());
      if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
      return Promise.resolve(app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env));
    };
  }

  async function signIn(appReq: ReturnType<typeof createProfileApp>, secretKey: Uint8Array) {
    const challenge = await appReq("/api/auth/challenge", {
      method: "POST",
      headers: { Origin: BASE_URL, "X-Bitig-Request": "true" },
    });
    const { event } = await challenge.json<{ event: EventTemplate }>();
    return appReq("/api/auth/nostr", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify(finalizeEvent(event, secretKey)),
    });
  }

  it("fills the placeholder name, avatar, and verified NIP-05 of a new account", async () => {
    const secretKey = new Uint8Array(32).fill(0x21);
    const pubkey = getPublicKey(secretKey);
    const appReq = createProfileApp({
      fetchProfile: (key) =>
        Promise.resolve(
          key === pubkey
            ? { displayName: "Dana", avatarUrl: "https://cdn.test/dana.png", nip05: "dana@example.com" }
            : null,
        ),
    });
    const res = await signIn(appReq, secretKey);
    expect(res.status).toBe(200);
    const stored = await new D1UserStore(env.DB).getByEmail(`${pubkey}@nostr.local`);
    expect(stored).toMatchObject({
      displayName: "Dana",
      avatarUrl: "https://cdn.test/dana.png",
      nip05: "dana@example.com",
    });
  });

  it("keeps fields the user already set and still signs in when the lookup fails", async () => {
    const secretKey = new Uint8Array(32).fill(0x22);
    const pubkey = getPublicKey(secretKey);
    const first = await signIn(createProfileApp({ fetchProfile: () => Promise.resolve(null) }), secretKey);
    expect(first.status).toBe(200);
    const store = new D1UserStore(env.DB);
    const created = await store.getByEmail(`${pubkey}@nostr.local`);
    if (!created) throw new Error("expected the Nostr account to exist");
    await store.update(created.id, { displayName: "Picked By Me" });

    const failing = await signIn(
      createProfileApp({ fetchProfile: () => Promise.reject(new Error("relays down")) }),
      secretKey,
    );
    expect(failing.status).toBe(200);

    await signIn(
      createProfileApp({
        fetchProfile: () => Promise.resolve({ displayName: "Relay Name", avatarUrl: "https://cdn.test/e.png" }),
      }),
      secretKey,
    );
    expect(await store.getById(created.id)).toMatchObject({
      displayName: "Picked By Me",
      avatarUrl: "https://cdn.test/e.png",
    });
  });
});

describe("POST /api/me/nostr/sync", () => {
  const SCRIPT_HEADERS = { Origin: BASE_URL, "X-Bitig-Request": "true" };

  function appFor(fetcher: NostrProfileFetcher) {
    const app = createApp({ nostrProfileFetcher: fetcher });
    return (path: string, init: RequestInit & { cookie?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", uniqueIp());
      if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
      return Promise.resolve(app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env));
    };
  }

  async function nostrCookie(secretKey: Uint8Array): Promise<string> {
    const appReq = appFor({ fetchProfile: () => Promise.resolve(null) });
    const challenge = await appReq("/api/auth/challenge", { method: "POST", headers: SCRIPT_HEADERS });
    const { event } = await challenge.json<{ event: EventTemplate }>();
    const res = await appReq("/api/auth/nostr", {
      method: "POST",
      headers: { ...SCRIPT_HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(finalizeEvent(event, secretKey)),
    });
    expect(res.status).toBe(200);
    return cookiePair(res);
  }

  it("fills empty fields and reports which ones changed", async () => {
    const cookie = await nostrCookie(new Uint8Array(32).fill(0x31));
    const appReq = appFor({
      fetchProfile: () => Promise.resolve({ displayName: "Erin", nip05: "erin@example.com" }),
    });
    const res = await appReq("/api/me/nostr/sync", { method: "POST", headers: SCRIPT_HEADERS, cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ user: { displayName: string; nip05?: string }; found: boolean; updated: string[] }>();
    expect(body.found).toBe(true);
    expect(body.updated).toEqual(["displayName", "nip05"]);
    expect(body.user).toMatchObject({ displayName: "Erin", nip05: "erin@example.com" });

    const again = await appReq("/api/me/nostr/sync", { method: "POST", headers: SCRIPT_HEADERS, cookie });
    expect(await again.json()).toMatchObject({ found: true, updated: [] });
  });

  it("reports when no profile was found", async () => {
    const cookie = await nostrCookie(new Uint8Array(32).fill(0x32));
    const res = await appFor({ fetchProfile: () => Promise.resolve(null) })("/api/me/nostr/sync", {
      method: "POST",
      headers: SCRIPT_HEADERS,
      cookie,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: false, updated: [] });
  });

  it("rejects signed-out callers and non-Nostr accounts", async () => {
    const appReq = appFor({ fetchProfile: () => Promise.resolve(null) });
    expect((await appReq("/api/me/nostr/sync", { method: "POST", headers: SCRIPT_HEADERS })).status).toBe(401);

    const user = await new D1UserStore(env.DB).create({
      email: "frank@example.com",
      username: "frank",
      displayName: "Frank",
    });
    const sessionId = crypto.randomUUID();
    await new D1SessionStore(env.DB).create({
      id: await sha256Hex(sessionId),
      userId: user.id,
      expiresAt: Date.now() + 60_000,
    });
    const res = await appReq("/api/me/nostr/sync", {
      method: "POST",
      headers: SCRIPT_HEADERS,
      cookie: await signedCookie(sessionId),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "not_nostr_account" });
  });

  it("rate limits repeated syncs per account", async () => {
    const cookie = await nostrCookie(new Uint8Array(32).fill(0x33));
    const appReq = appFor({ fetchProfile: () => Promise.resolve(null) });
    for (let attempt = 0; attempt < NOSTR_SYNC_RATE_MAX; attempt += 1) {
      expect((await appReq("/api/me/nostr/sync", { method: "POST", headers: SCRIPT_HEADERS, cookie })).status).toBe(200);
    }
    const blocked = await appReq("/api/me/nostr/sync", { method: "POST", headers: SCRIPT_HEADERS, cookie });
    expect(blocked.status).toBe(429);
  });
});

describe("one-time email code sign-in and registration", () => {
  function createMailerApp() {
    const mailer = new FakeMailer();
    const app = createApp({ mailer });
    const appReq = (path: string, init: RequestInit & { ip?: string; cookie?: string } = {}) => {
      const headers = new Headers(init.headers);
      headers.set("cf-connecting-ip", init.ip ?? uniqueIp());
      if (init.cookie !== undefined) headers.set("Cookie", init.cookie);
      return Promise.resolve(app.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }), env));
    };
    return { mailer, appReq };
  }

  it("signs in the bootstrap admin with a 6-digit code and sets a server-side session cookie", async () => {
    const { mailer, appReq } = createMailerApp();
    const codeRes = await appReq("/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL }),
    });
    expect(codeRes.status).toBe(200);
    expect(await codeRes.json()).toEqual({ status: "sent" });

    const code = mailer.extractLastCode(TEST_BOOTSTRAP_EMAIL);
    expect(code).toMatch(/^\d{6}$/);

    const verifyRes = await appReq("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code }),
    });
    expect(verifyRes.status).toBe(200);
    const payload = await verifyRes.json<{
      user: string;
      profile: { email: string; platformRole: string };
      needsOnboarding: boolean;
    }>();
    expect(payload.user).toBe(TEST_AUTH_USER);
    expect(payload.profile.email).toBe(TEST_BOOTSTRAP_EMAIL);
    expect(payload.profile.platformRole).toBe("admin");
    expect(payload.needsOnboarding).toBe(false);

    // Code is single-use
    const replayRes = await appReq("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code }),
    });
    expect(replayRes.status).toBe(401);
  });

  it("returns 200 without sending email when requesting a code for an unknown address", async () => {
    const { mailer, appReq } = createMailerApp();
    const res = await appReq("/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: "nobody@bitig.test" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent" });
    expect(mailer.sent).toHaveLength(0);
  });

  it("burns the code after 5 wrong verification guesses", async () => {
    const { mailer, appReq } = createMailerApp();
    await appReq("/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL }),
    });
    const realCode = mailer.extractLastCode(TEST_BOOTSTRAP_EMAIL) ?? "000000";
    const wrongCode = realCode === "999999" ? "888888" : "999999";

    for (let i = 0; i < 5; i += 1) {
      const wrongRes = await appReq("/api/auth/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code: wrongCode }),
      });
      expect(wrongRes.status).toBe(401);
    }

    // Even the real code now fails because attempts >= 5
    const afterLockout = await appReq("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code: realCode }),
    });
    expect(afterLockout.status).toBe(401);
  });

  it("registers a new user and flags needsOnboarding when no organisation exists yet", async () => {
    const { mailer, appReq } = createMailerApp();
    const suffix = crypto.randomUUID().slice(0, 6);
    const email = `newuser-${suffix}@bitig.test`;
    const username = `newuser-${suffix}`;

    const regRes = await appReq("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({
        email,
        username,
        displayName: "New Person",
      }),
    });
    expect(regRes.status).toBe(200);

    const code = mailer.extractLastCode(email);
    expect(code).toMatch(/^\d{6}$/);

    const verifyRes = await appReq("/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email, code }),
    });
    expect(verifyRes.status).toBe(200);
    const body = await verifyRes.json<{
      user: string;
      memberships: unknown[];
      needsOnboarding: boolean;
    }>();
    expect(body.user).toBe(username);
    expect(body.memberships).toHaveLength(0);
    expect(body.needsOnboarding).toBe(true);
  });
});

describe("session cookie", () => {
  it("authenticates API requests and reports the Nostr public key", async () => {
    const cookie = cookiePair(await submitLogin(await signedLoginEvent()));
    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(404);
    expect(await (await request("/api/auth/session", { cookie })).json()).toEqual({ user: TEST_NOSTR_PUBKEY });
  });

  it("authenticates an email-code session and reports the user profile on /api/auth/me", async () => {
    const mailer = new FakeMailer();
    const app = createApp({ mailer });
    await app.request(
      `${BASE_URL}/api/auth/code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL }),
      },
      env,
    );
    const code = mailer.extractLastCode(TEST_BOOTSTRAP_EMAIL);
    const verifyRes = await app.request(
      `${BASE_URL}/api/auth/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code }),
      },
      env,
    );
    const cookie = cookiePair(verifyRes);
    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(404);
    expect(await (await request("/api/auth/session", { cookie })).json()).toEqual({ user: TEST_AUTH_USER });
    const meRes = await request("/api/auth/me", { cookie });
    expect(meRes.status).toBe(200);
    const me = await meRes.json<{ user: { email: string }; memberships: unknown[] }>();
    expect(me.user.email).toBe(TEST_BOOTSTRAP_EMAIL);
    expect(me.memberships.length).toBeGreaterThanOrEqual(1);
  });

  it("rejects another signature, tampering, and unknown session tokens", async () => {
    const anotherSecret = "another-secret-0123456789abcdef!!";
    expect(
      (await request(AUTHENTICATED_PATH, { cookie: await signedCookie("unknown-token", anotherSecret) })).status,
    ).toBe(401);
    const valid = cookiePair(await submitLogin(await signedLoginEvent()));
    expect((await request(AUTHENTICATED_PATH, { cookie: `${valid}x` })).status).toBe(401);
    expect((await request(AUTHENTICATED_PATH, { cookie: await signedCookie("nonexistent-session-token") })).status).toBe(
      401,
    );
  });
});

describe("session routes", () => {
  it("answers 401 without a session", async () => {
    expect((await request("/api/auth/session")).status).toBe(401);
  });

  it("clears the session cookie and deletes the server-side session on logout", async () => {
    const loginRes = await submitLogin(await signedLoginEvent());
    const cookie = cookiePair(loginRes);
    expect((await request("/api/auth/session", { cookie })).status).toBe(200);

    const res = await request("/api/auth/logout", {
      method: "POST",
      headers: { Origin: BASE_URL },
      cookie,
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toMatch(new RegExp(`^${COOKIE_NAME}=;`));
    expect((await request("/api/auth/session", { cookie })).status).toBe(401);
  });
});

describe("stale and revoked sessions", () => {
  it("rejects a session when the user is disabled", async () => {
    const mailer = new FakeMailer();
    const app = createApp({ mailer });
    const suffix = crypto.randomUUID().slice(0, 6);
    const email = `disable-${suffix}@bitig.test`;
    const username = `disable-${suffix}`;

    await app.request(
      `${BASE_URL}/api/auth/register`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ email, username, displayName: "Disable Me" }),
      },
      env,
    );
    const code = mailer.extractLastCode(email);
    const verifyRes = await app.request(
      `${BASE_URL}/api/auth/verify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ email, code, organisationName: "Disable Org" }),
      },
      env,
    );
    const cookie = cookiePair(verifyRes);
    expect((await request("/api/auth/session", { cookie })).status).toBe(200);

    const userStore = new D1UserStore(env.DB);
    const user = await userStore.getByEmail(email);
    expect(user).not.toBeNull();
    await userStore.update(user?.id ?? "", { status: "disabled" });

    expect((await request("/api/auth/session", { cookie })).status).toBe(401);
  });

  it("does not count a stale session toward the failed-login budget", async () => {
    const ip = uniqueIp();
    const cookie = await signedCookie("expired-session-token");
    for (let attempt = 0; attempt <= AUTH_FAIL_POLICY.max; attempt += 1) {
      expect((await request(AUTHENTICATED_PATH, { cookie, ip })).status).toBe(401);
    }
  });
});

describe("failed-login rate limit", () => {
  it("answers 429 after repeated bad verification codes", async () => {
    const ip = uniqueIp();
    for (let attempt = 0; attempt < AUTH_FAIL_POLICY.max; attempt += 1) {
      const res = await request("/api/auth/verify", {
        ip,
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code: "000000" }),
      });
      expect(res.status).toBe(401);
    }
    const blocked = await request("/api/auth/verify", {
      ip,
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code: "000000" }),
    });
    expect(blocked.status).toBe(429);
  });

  it("answers 429 after repeated forged Nostr signatures", async () => {
    const ip = uniqueIp();
    for (let attempt = 0; attempt < AUTH_FAIL_POLICY.max; attempt += 1) {
      const event = await signedLoginEvent(OTHER_SECRET_KEY);
      const res = await request("/api/auth/nostr", {
        ip,
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
        body: JSON.stringify({ ...event, pubkey: TEST_NOSTR_PUBKEY }),
      });
      expect(res.status).toBe(401);
    }
    const blocked = await request("/api/auth/nostr", {
      ip,
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL, "X-Bitig-Request": "true" },
      body: JSON.stringify(await signedLoginEvent()),
    });
    expect(blocked.status).toBe(429);
  });
});

describe("unconfigured sign-in", () => {
  const baseEnv = {
    ALLOWED_ORIGINS: "",
    BOOTSTRAP_ADMIN_EMAIL: TEST_BOOTSTRAP_EMAIL,
    NOSTR_AUTH_PUBKEYS: TEST_NOSTR_PUBKEY,
    SESSION_SECRET: TEST_SESSION_SECRET,
  };

  function appRequest(config: Record<string, string>, path: string, body?: unknown): Promise<Response> {
    const app = createApp({ config: parseConfig({ ...baseEnv, ...config }) });
    return Promise.resolve(
      app.fetch(
        new Request(`${BASE_URL}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: BASE_URL,
            "X-Bitig-Request": "true",
            "cf-connecting-ip": uniqueIp(),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        env,
      ),
    );
  }

  it("explains a missing SESSION_SECRET on email code request", async () => {
    const res = await appRequest({ SESSION_SECRET: "" }, "/api/auth/code", { email: TEST_BOOTSTRAP_EMAIL });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "sessions_not_configured",
      message: expect.stringContaining("SESSION_SECRET") as unknown,
    });
  });

  it("issues a Nostr challenge without an allowlist", async () => {
    const res = await appRequest({ NOSTR_AUTH_PUBKEYS: "" }, "/api/auth/challenge");
    expect(res.status).toBe(200);
  });

  it("explains a missing SESSION_SECRET on Nostr challenge", async () => {
    const res = await appRequest({ SESSION_SECRET: "" }, "/api/auth/challenge");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "sessions_not_configured",
      message: expect.stringContaining("SESSION_SECRET") as unknown,
    });
  });
});
