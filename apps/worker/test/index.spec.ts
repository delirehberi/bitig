import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { HealthResponse } from "../src/index";
import { TEST_ALLOWED_ORIGIN, TEST_AUTH_HEADER } from "./constants";
import pkg from "../package.json" with { type: "json" };

const BASE_URL = "https://bitig.test";

function request(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, init));
}

describe("GET /health", () => {
  it("reports status, version and storage mode", async () => {
    const res = await request("/health");

    expect(res.status).toBe(200);
    expect(await res.json<HealthResponse>()).toEqual({
      status: "ok",
      version: pkg.version,
      storageMode: "cloudflare",
    });
  });

  it("sets security headers", async () => {
    const res = await request("/health");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("CORS on /api/*", () => {
  it("echoes an allowlisted origin", async () => {
    const res = await request("/api/anything", { headers: { Origin: TEST_ALLOWED_ORIGIN } });

    expect(res.headers.get("access-control-allow-origin")).toBe(TEST_ALLOWED_ORIGIN);
  });

  it("does not allow an unknown origin", async () => {
    const res = await request("/api/anything", { headers: { Origin: "https://evil.test" } });

    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("unknown API routes", () => {
  it("return a JSON 401 when unauthenticated", async () => {
    const res = await request("/api/missing");

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("return a JSON 404 when authenticated", async () => {
    const res = await request("/api/missing", {
      headers: { Authorization: TEST_AUTH_HEADER },
    });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
