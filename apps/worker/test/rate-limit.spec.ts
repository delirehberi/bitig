import { env, exports } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { API_POLICY, AUTH_FAIL_POLICY, MCP_POLICY, type RateLimitPolicy } from "../src/rate-limit";
import type { RateLimiter } from "../src/rate-limiter-do";
import { TEST_AUTH_HEADER, TEST_MCP_AUTH_HEADER } from "./constants";

const BASE_URL = "https://bitig.test";
const WRONG_BASIC_AUTH = `Basic ${btoa("admin:wrong-password")}`;
const WRONG_BEARER_AUTH = "Bearer wrong-token";
/** An authenticated request to an unknown route is a 404, which needs no D1 setup. */
const AUTHENTICATED_PATH = "/api/missing";

let ipCounter = 0;

/** Every test gets its own client IP, so counters never leak between tests. */
function uniqueIp(): string {
  ipCounter += 1;
  return `203.0.113.${String(ipCounter)}`;
}

function request(path: string, ip: string, authorization?: string, method = "GET"): Promise<Response> {
  const headers = new Headers({ "cf-connecting-ip": ip });
  if (authorization !== undefined) headers.set("Authorization", authorization);
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, { method, headers }));
}

async function exhaustAuthBudget(ip: string): Promise<void> {
  for (let attempt = 0; attempt < AUTH_FAIL_POLICY.max; attempt += 1) {
    const res = await request(AUTHENTICATED_PATH, ip, WRONG_BASIC_AUTH);
    expect(res.status).toBe(401);
  }
}

function limiter(name: string): DurableObjectStub<RateLimiter> {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
}

describe("failed authentication rate limit", () => {
  it("returns 429 with Retry-After after too many bad Basic Auth attempts", async () => {
    const ip = uniqueIp();
    await exhaustAuthBudget(ip);

    const res = await request(AUTHENTICATED_PATH, ip, WRONG_BASIC_AUTH);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(await res.json()).toMatchObject({ error: "too_many_requests" });
  });

  it("blocks valid credentials from the limited client", async () => {
    const ip = uniqueIp();
    await exhaustAuthBudget(ip);

    const res = await request(AUTHENTICATED_PATH, ip, TEST_AUTH_HEADER);

    expect(res.status).toBe(429);
  });

  it("does not block a successful login from another client", async () => {
    await exhaustAuthBudget(uniqueIp());

    const res = await request(AUTHENTICATED_PATH, uniqueIp(), TEST_AUTH_HEADER);

    expect(res.status).toBe(404);
  });

  it("counts bad Bearer tokens on /mcp toward the same budget", async () => {
    const ip = uniqueIp();
    for (let attempt = 0; attempt < AUTH_FAIL_POLICY.max; attempt += 1) {
      const res = await request("/mcp", ip, WRONG_BEARER_AUTH, "POST");
      expect(res.status).toBe(401);
    }

    const mcpRes = await request("/mcp", ip, TEST_MCP_AUTH_HEADER, "POST");
    const apiRes = await request(AUTHENTICATED_PATH, ip, TEST_AUTH_HEADER);

    expect(mcpRes.status).toBe(429);
    expect(apiRes.status).toBe(429);
  });

  it("does not count requests that carry no credentials", async () => {
    const ip = uniqueIp();
    const bareRequests = AUTH_FAIL_POLICY.max + 5;
    for (let attempt = 0; attempt < bareRequests; attempt += 1) {
      const res = await request(AUTHENTICATED_PATH, ip);
      expect(res.status).toBe(401);
    }

    const res = await request(AUTHENTICATED_PATH, ip, TEST_AUTH_HEADER);

    expect(res.status).toBe(404);
  });

  it("sets RateLimit headers from the shared limiter", async () => {
    const res = await request(AUTHENTICATED_PATH, uniqueIp(), TEST_AUTH_HEADER);

    expect(res.headers.get("ratelimit-limit")).toBe("1000");
    expect(res.headers.get("ratelimit-remaining")).toBe("999");
  });
});

describe("request rate limit", () => {
  /** Fills a client's window from inside the Durable Object, avoiding `max` round trips. */
  async function exhaustPolicy(policy: RateLimitPolicy, ip: string): Promise<void> {
    await runInDurableObject(limiter(`${policy.name}:${ip}`), async (instance: RateLimiter) => {
      for (let i = 0; i < policy.max; i += 1) await instance.record(policy.windowMs);
    });
  }

  it("returns 429 with Retry-After once /api/* requests exceed the limit", async () => {
    const ip = uniqueIp();
    await exhaustPolicy(API_POLICY, ip);

    const res = await request(AUTHENTICATED_PATH, ip, TEST_AUTH_HEADER);

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("ratelimit-remaining")).toBe("0");
    expect(await res.json()).toMatchObject({ error: "too_many_requests" });
  });

  it("returns 429 once /mcp requests exceed the limit", async () => {
    const ip = uniqueIp();
    await exhaustPolicy(MCP_POLICY, ip);

    const res = await request("/mcp", ip, TEST_MCP_AUTH_HEADER, "POST");

    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });

  it("does not limit other clients", async () => {
    await exhaustPolicy(API_POLICY, uniqueIp());

    const res = await request(AUTHENTICATED_PATH, uniqueIp(), TEST_AUTH_HEADER);

    expect(res.status).toBe(404);
  });
});

describe("RateLimiter Durable Object", () => {
  const MAX = 3;
  const WINDOW_MS = 10_000;
  // Real time: the cleanup alarm is scheduled at `now + window`, and a past alarm fires at once.
  const START = Date.now();

  it("limits once max hits fall inside the window", async () => {
    const stub = limiter(`unit:${uniqueIp()}`);
    for (let i = 0; i < MAX; i += 1) {
      const result = await stub.hit(MAX, WINDOW_MS, START + i);
      expect(result).toMatchObject({ limited: false, remaining: MAX - i - 1 });
    }

    const result = await stub.hit(MAX, WINDOW_MS, START + MAX);

    expect(result).toEqual({ limited: true, limit: MAX, remaining: 0, resetSeconds: 10 });
  });

  it("allows hits again once old entries leave the window", async () => {
    const stub = limiter(`unit:${uniqueIp()}`);
    for (let i = 0; i < MAX; i += 1) await stub.hit(MAX, WINDOW_MS, START);

    const result = await stub.hit(MAX, WINDOW_MS, START + WINDOW_MS);

    expect(result.limited).toBe(false);
  });

  it("does not count peeks", async () => {
    const stub = limiter(`unit:${uniqueIp()}`);
    for (let i = 0; i < MAX + 2; i += 1) await stub.peek(MAX, WINDOW_MS, START);

    const result = await stub.peek(MAX, WINDOW_MS, START);

    expect(result).toMatchObject({ limited: false, remaining: MAX });
  });

  it("limits after enough recorded events", async () => {
    const stub = limiter(`unit:${uniqueIp()}`);
    for (let i = 0; i < MAX; i += 1) await stub.record(WINDOW_MS, START);

    const result = await stub.peek(MAX, WINDOW_MS, START + 1);

    expect(result.limited).toBe(true);
  });

  it("clears its storage when the cleanup alarm fires", async () => {
    const stub = limiter(`unit:${uniqueIp()}`);
    await stub.record(WINDOW_MS);

    const ran = await runDurableObjectAlarm(stub);

    expect(ran).toBe(true);
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'hits'").toArray(),
    );
    expect(tables).toHaveLength(0);
    expect((await stub.peek(MAX, WINDOW_MS)).remaining).toBe(MAX);
  });
});
