import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TEST_ALLOWED_ORIGIN, TEST_AUTH_HEADER } from "./constants";

const BASE_URL = "https://bitig.test";
const FOREIGN_ORIGIN = "https://evil.example";
/** An authenticated request to an unknown route is a 404, which needs no D1 setup. */
const AUTHENTICATED_PATH = "/api/missing";
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

let ipCounter = 0;

/** Every test gets its own client IP, so rate limit counters never leak between tests. */
function uniqueIp(): string {
  ipCounter += 1;
  return `198.51.100.${String(ipCounter)}`;
}

function request(method: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  const headers = new Headers({
    Authorization: TEST_AUTH_HEADER,
    "cf-connecting-ip": uniqueIp(),
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  const body = method === "GET" ? null : "{}";
  return exports.default.fetch(new Request(`${BASE_URL}${AUTHENTICATED_PATH}`, { method, headers, body }));
}

describe("CSRF protection on /api/*", () => {
  it("blocks a mutating request from a foreign Origin", async () => {
    const res = await request("POST", { Origin: FOREIGN_ORIGIN });

    expect(res.status).toBe(HTTP_FORBIDDEN);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("allows a mutating request from the same Origin", async () => {
    const res = await request("POST", { Origin: BASE_URL });

    expect(res.status).toBe(HTTP_NOT_FOUND);
  });

  it("allows a mutating request from an allowlisted Origin", async () => {
    const res = await request("PATCH", { Origin: TEST_ALLOWED_ORIGIN });

    expect(res.status).toBe(HTTP_NOT_FOUND);
  });

  it("allows a JSON request without Origin or Referer (non-browser clients)", async () => {
    const res = await request("DELETE");

    expect(res.status).toBe(HTTP_NOT_FOUND);
  });

  it("blocks a foreign Referer when Origin is absent", async () => {
    const res = await request("POST", { Referer: `${FOREIGN_ORIGIN}/page` });

    expect(res.status).toBe(HTTP_FORBIDDEN);
  });

  it("allows a same-site Referer when Origin is absent", async () => {
    const res = await request("POST", { Referer: `${BASE_URL}/projects` });

    expect(res.status).toBe(HTTP_NOT_FOUND);
  });

  it("blocks an unparsable Referer", async () => {
    const res = await request("POST", { Referer: "not a url" });

    expect(res.status).toBe(HTTP_FORBIDDEN);
  });

  it("blocks a cross-site fetch without Origin or Referer", async () => {
    const res = await request("POST", { "Sec-Fetch-Site": "cross-site" });

    expect(res.status).toBe(HTTP_FORBIDDEN);
  });

  it("blocks a form-encoded request without Origin or Referer", async () => {
    const res = await request("POST", { "Content-Type": "application/x-www-form-urlencoded" });

    expect(res.status).toBe(HTTP_FORBIDDEN);
  });

  it("does not check safe methods", async () => {
    const res = await request("GET", { Origin: FOREIGN_ORIGIN });

    expect(res.status).toBe(HTTP_NOT_FOUND);
  });
});
