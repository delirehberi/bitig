import { describe, expect, it } from "vitest";
import { ConfigError, parseConfig } from "../src/config";

describe("parseConfig", () => {
  it("treats a missing or empty ALLOWED_ORIGINS as same-origin only", () => {
    expect(parseConfig({}).ALLOWED_ORIGINS).toEqual([]);
    expect(parseConfig({ ALLOWED_ORIGINS: "" }).ALLOWED_ORIGINS).toEqual([]);
  });

  it("splits and trims a comma-separated list", () => {
    const config = parseConfig({ ALLOWED_ORIGINS: " https://a.test , http://localhost:5173 ," });

    expect(config.ALLOWED_ORIGINS).toEqual(["https://a.test", "http://localhost:5173"]);
  });

  it("rejects non-http origins", () => {
    expect(() => parseConfig({ ALLOWED_ORIGINS: "javascript:alert(1)" })).toThrow(ConfigError);
  });

  it("rejects a non-string value", () => {
    expect(() => parseConfig({ ALLOWED_ORIGINS: 42 })).toThrow(ConfigError);
  });

  it("defaults STORAGE_MODE to cloudflare", () => {
    expect(parseConfig({}).STORAGE_MODE).toBe("cloudflare");
  });

  it.each(["local", "cloudflare", "nostr"] as const)("accepts STORAGE_MODE %s", (mode) => {
    expect(parseConfig({ STORAGE_MODE: mode }).STORAGE_MODE).toBe(mode);
  });

  it("rejects an unknown STORAGE_MODE", () => {
    expect(() => parseConfig({ STORAGE_MODE: "bogus" })).toThrow(ConfigError);
  });
});
