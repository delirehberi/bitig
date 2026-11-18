import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { HealthResponse, VersionResponse } from "../src/index";
import { BUILD_INFO } from "../src/build-info.generated";
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
      hierarchyMode: "explicit",
    });
  });

  it("sets security headers", async () => {
    const res = await request("/health");

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toContain("max-age=");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("GET /api/version", () => {
  const BUILD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("returns the build identity without authentication", async () => {
    const res = await request("/api/version");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json<VersionResponse>()).toEqual({
      version: BUILD_INFO.version,
      commit: BUILD_INFO.commit,
      dirty: BUILD_INFO.dirty,
      buildId: BUILD_INFO.buildId,
      builtAt: BUILD_INFO.builtAt,
    });
  });

  it("encodes the package version, commit and a unique build ID in the version string", () => {
    expect(BUILD_INFO.version.startsWith(`${pkg.version}+`)).toBe(true);
    expect(BUILD_INFO.version).toContain(BUILD_INFO.buildId);
    expect(BUILD_INFO.buildId).toMatch(BUILD_ID_PATTERN);
    expect(Number.isNaN(Date.parse(BUILD_INFO.builtAt))).toBe(false);
  });

  it("is exposed under /api/* but keeps CORS allowlisting", async () => {
    const res = await request("/api/version", { headers: { Origin: TEST_ALLOWED_ORIGIN } });

    expect(res.headers.get("access-control-allow-origin")).toBe(TEST_ALLOWED_ORIGIN);
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
