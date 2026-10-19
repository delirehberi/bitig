import { env, exports } from "cloudflare:workers";
import { generateSignedCookie } from "hono/cookie";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/index";
import { parseConfig } from "../src/config";
import { SESSION_COOKIE, sessionValue } from "../src/session";
import { TEST_AUTH_PASS, TEST_AUTH_USER, TEST_SESSION_SECRET } from "./constants";

const BASE_URL = "https://bitig.test";
const COOKIE_NAME = `__Host-${SESSION_COOKIE}`;
/** An authenticated request to an unknown route is a 404, which needs no D1 setup. */
const AUTHENTICATED_PATH = "/api/missing";
const HOUR_SECONDS = 60 * 60;

let ipCounter = 0;

/** Every test gets its own client IP, so failed-login counters never leak between tests. */
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

function login(username: string, password: string, ip?: string): Promise<Response> {
  return request("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: BASE_URL },
    body: JSON.stringify({ username, password }),
    ...(ip === undefined ? {} : { ip }),
  });
}

/** The `name=value` pair from a Set-Cookie header, ready to send back as a Cookie header. */
function cookiePair(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0] ?? "";
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

describe("POST /api/auth/login", () => {
  it("sets a hardened session cookie for valid credentials", async () => {
    const res = await login(TEST_AUTH_USER, TEST_AUTH_PASS);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: TEST_AUTH_USER });
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=`));
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toMatch(/Max-Age=\d+/);
  });

  it("rejects wrong credentials without setting a cookie", async () => {
    const res = await login(TEST_AUTH_USER, "wrong-password");

    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("www-authenticate")).toBeNull();
  });

  it("counts failed logins toward the failed-login budget", async () => {
    const ip = uniqueIp();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(TEST_AUTH_USER, "wrong-password", ip)).status).toBe(401);
    }

    expect((await login(TEST_AUTH_USER, TEST_AUTH_PASS, ip)).status).toBe(429);
  });

  it("rejects a malformed body", async () => {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: BASE_URL },
      body: JSON.stringify({ username: TEST_AUTH_USER }),
    });

    expect(res.status).toBe(400);
  });

  it("is blocked from a foreign origin", async () => {
    const res = await request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://evil.test" },
      body: JSON.stringify({ username: TEST_AUTH_USER, password: TEST_AUTH_PASS }),
    });

    expect(res.status).toBe(403);
  });

  it("answers 503 when no SESSION_SECRET is configured", async () => {
    const app = createApp({
      config: parseConfig({ BASIC_AUTH_USER: TEST_AUTH_USER, BASIC_AUTH_PASS: TEST_AUTH_PASS }),
    });
    const res = await app.request(
      "/api/auth/login",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": uniqueIp() },
        body: JSON.stringify({ username: TEST_AUTH_USER, password: TEST_AUTH_PASS }),
      },
      env,
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "sessions_not_configured" });
  });
});

describe("session cookie", () => {
  it("authenticates /api/* requests", async () => {
    const cookie = cookiePair(await login(TEST_AUTH_USER, TEST_AUTH_PASS));

    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(404);
    const session = await request("/api/auth/session", { cookie });
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({ user: TEST_AUTH_USER });
  });

  it("is rejected when signed with another secret", async () => {
    const cookie = await signedCookie(TEST_AUTH_USER, nowSeconds() + HOUR_SECONDS, "another-secret-0123456789abcdef!!");

    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(401);
    expect((await request("/api/auth/session", { cookie })).status).toBe(401);
  });

  it("is rejected when its value was edited", async () => {
    const valid = await signedCookie(TEST_AUTH_USER, nowSeconds() + HOUR_SECONDS);
    const tampered = valid.replace(encodeURIComponent(`:${TEST_AUTH_USER}`), encodeURIComponent(":root"));

    expect(tampered).not.toBe(valid);
    expect((await request(AUTHENTICATED_PATH, { cookie: tampered })).status).toBe(401);
  });

  it("is rejected once expired", async () => {
    const cookie = await signedCookie(TEST_AUTH_USER, nowSeconds() - 1);

    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(401);
  });

  it("is rejected for a user other than BASIC_AUTH_USER", async () => {
    const cookie = await signedCookie("someone-else", nowSeconds() + HOUR_SECONDS);

    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(401);
  });

  it("is not read without the __Host- prefix", async () => {
    const prefixed = await signedCookie(TEST_AUTH_USER, nowSeconds() + HOUR_SECONDS);
    const cookie = prefixed.replace(/^__Host-/, "");

    expect((await request(AUTHENTICATED_PATH, { cookie })).status).toBe(401);
  });
});

describe("GET /api/auth/session", () => {
  it("answers 401 without a session", async () => {
    const res = await request("/api/auth/session");

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const res = await request("/api/auth/logout", { method: "POST", headers: { Origin: BASE_URL } });

    expect(res.status).toBe(204);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(new RegExp(`^${COOKIE_NAME}=;`));
    expect(setCookie).toContain("Max-Age=0");
  });
});
