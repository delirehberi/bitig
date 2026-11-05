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

  it.each(["local", "cloudflare"] as const)("accepts STORAGE_MODE %s", (mode) => {
    expect(parseConfig({ STORAGE_MODE: mode }).STORAGE_MODE).toBe(mode);
  });

  it("rejects an unknown STORAGE_MODE", () => {
    expect(() => parseConfig({ STORAGE_MODE: "bogus" })).toThrow(ConfigError);
    expect(() => parseConfig({ STORAGE_MODE: "nostr" })).toThrow(ConfigError);
  });

  it("normalizes and validates the Nostr login allowlist", () => {
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    expect(parseConfig({ NOSTR_AUTH_PUBKEYS: ` ${first.toUpperCase()}, ${second} ` }).NOSTR_AUTH_PUBKEYS).toEqual([
      first,
      second,
    ]);
    expect(() => parseConfig({ NOSTR_AUTH_PUBKEYS: "npub-invalid" })).toThrow(ConfigError);
  });

  it("leaves sessions off when SESSION_SECRET is empty", () => {
    expect(parseConfig({}).SESSION_SECRET).toBe("");
  });

  it("rejects a SESSION_SECRET shorter than 32 characters", () => {
    expect(() => parseConfig({ SESSION_SECRET: "too-short" })).toThrow(ConfigError);
    expect(parseConfig({ SESSION_SECRET: "x".repeat(32) }).SESSION_SECRET).toHaveLength(32);
  });

  it("leaves T3_ENCRYPTION_KEY empty when unset and rejects values shorter than 32 characters", () => {
    expect(parseConfig({}).T3_ENCRYPTION_KEY).toBe("");
    expect(() => parseConfig({ T3_ENCRYPTION_KEY: "too-short" })).toThrow(ConfigError);
    expect(parseConfig({ T3_ENCRYPTION_KEY: "k".repeat(32) }).T3_ENCRYPTION_KEY).toHaveLength(32);
  });

  it("defaults and trims T3_CF_ACCESS_CLIENT_ID and T3_CF_ACCESS_CLIENT_SECRET", () => {
    expect(parseConfig({}).T3_CF_ACCESS_CLIENT_ID).toBe("");
    expect(parseConfig({}).T3_CF_ACCESS_CLIENT_SECRET).toBe("");
    const parsed = parseConfig({
      T3_CF_ACCESS_CLIENT_ID: "  cf-id.access  ",
      T3_CF_ACCESS_CLIENT_SECRET: "  cf-secret-val  ",
    });
    expect(parsed.T3_CF_ACCESS_CLIENT_ID).toBe("cf-id.access");
    expect(parsed.T3_CF_ACCESS_CLIENT_SECRET).toBe("cf-secret-val");
  });

  it("normalizes and validates RESEND_API_KEY, MAIL_FROM, and BOOTSTRAP_ADMIN_EMAIL", () => {
    expect(parseConfig({}).RESEND_API_KEY).toBe("");
    expect(parseConfig({}).MAIL_FROM).toBe("");
    expect(parseConfig({}).BOOTSTRAP_ADMIN_EMAIL).toBe("");
    const parsed = parseConfig({
      RESEND_API_KEY: "  re_123  ",
      MAIL_FROM: "  Bitig <noreply@bitig.test>  ",
      BOOTSTRAP_ADMIN_EMAIL: "  Admin@Example.com  ",
    });
    expect(parsed.RESEND_API_KEY).toBe("re_123");
    expect(parsed.MAIL_FROM).toBe("Bitig <noreply@bitig.test>");
    expect(parsed.BOOTSTRAP_ADMIN_EMAIL).toBe("admin@example.com");
    expect(() => parseConfig({ BOOTSTRAP_ADMIN_EMAIL: "not-an-email" })).toThrow(ConfigError);
  });
});
