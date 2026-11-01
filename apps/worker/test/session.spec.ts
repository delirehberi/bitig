import { env, exports } from "cloudflare:workers";
import { generateSignedCookie } from "hono/cookie";
import { finalizeEvent, type EventTemplate } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE, sessionValue } from "../src/session";
import { TEST_NOSTR_PUBKEY, TEST_NOSTR_SECRET_KEY, TEST_SESSION_SECRET } from "./constants";

const BASE_URL = "https://bitig.test";
const COOKIE_NAME = `__Host-${SESSION_COOKIE}`;
const AUTHENTICATED_PATH = "/api/missing";
const HOUR_SECONDS = 60 * 60;
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

async function signedCookie(user: string, expiresAtSeconds: number, secret = TEST_SESSION_SECRET): Promise<string> {
  const header = await generateSignedCookie(SESSION_COOKIE, sessionValue(user, expiresAtSeconds), secret, {
    prefix: "host",
    secure: true,
    path: "/",
  });
  return header.split(";")[0] ?? "";
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
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

  it("rejects unauthorized keys, malformed events, and foreign origins", async () => {
    expect((await submitLogin(await signedLoginEvent(OTHER_SECRET_KEY))).status).toBe(401);
    expect((await submitLogin({ kind: 22242 })).status).toBe(400);
    const event = await signedLoginEvent();
    const foreign = await request("/api/auth/nostr", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: JSON.stringify(event),
    });
    expect(foreign.status).toBe(403);
  });

  it("consumes a challenge exactly once", async () => {
    const event = await signedLoginEvent();
    expect((await submitLogin(event)).status).toBe(200);
    expect((await submitLogin(event)).status).toBe(401);
  });

  it("rejects a changed timestamp and an expired challenge", async () => {
    const event = await signedLoginEvent();
    expect((await submitLogin(finalizeEvent({ ...event, created_at: event.created_at + 1 }, TEST_NOSTR_SECRET_KEY))).status).toBe(401);

    const nonce = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1000) - 60;
    const stub = env.LOGIN_CHALLENGE.get(env.LOGIN_CHALLENGE.idFromName(nonce));
    await stub.issue({ origin: BASE_URL, createdAt, expiresAt: Date.now() - 1 });
    const expired = finalizeEvent({
      kind: 22242,
      created_at: createdAt,
      content: "Sign in to Bitig",
      tags: [["challenge", nonce], ["origin", BASE_URL], ["action", "login"]],
    }, TEST_NOSTR_SECRET_KEY);
    expect((await submitLogin(expired)).status).toBe(401);
  });
});

describe("session cookie", () => {
  it("authenticates API requests and reports the Nostr public key", async () => {
    const cookie = cookiePair(await submitLogin(await signedLoginEvent()));
    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(404);
    expect(await (await request("/api/auth/session", { cookie })).json()).toEqual({ user: TEST_NOSTR_PUBKEY });
  });

  it("rejects another signature, tampering, expiry, and a non-allowlisted user", async () => {
    const anotherSecret = "another-secret-0123456789abcdef!!";
    expect((await request(AUTHENTICATED_PATH, { cookie: await signedCookie(TEST_NOSTR_PUBKEY, nowSeconds() + HOUR_SECONDS, anotherSecret) })).status).toBe(401);
    const valid = await signedCookie(TEST_NOSTR_PUBKEY, nowSeconds() + HOUR_SECONDS);
    expect((await request(AUTHENTICATED_PATH, { cookie: `${valid}x` })).status).toBe(401);
    expect((await request(AUTHENTICATED_PATH, { cookie: await signedCookie(TEST_NOSTR_PUBKEY, nowSeconds() - 1) })).status).toBe(401);
    expect((await request(AUTHENTICATED_PATH, { cookie: await signedCookie("0".repeat(64), nowSeconds() + HOUR_SECONDS) })).status).toBe(401);
  });
});

describe("session routes", () => {
  it("answers 401 without a session", async () => {
    expect((await request("/api/auth/session")).status).toBe(401);
  });

  it("clears the session cookie", async () => {
    const res = await request("/api/auth/logout", { method: "POST", headers: { Origin: BASE_URL } });
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie") ?? "").toMatch(new RegExp(`^${COOKIE_NAME}=;`));
  });
});
