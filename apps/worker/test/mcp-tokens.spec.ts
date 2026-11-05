import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreatedMcpTokenSchema, McpTokenListSchema, MCP_TOKEN_ACTIVE_LIMIT } from "@bitig/core";
import { TEST_AUTH_HEADER, TEST_BOOTSTRAP_EMAIL, TEST_MCP_AUTH_HEADER } from "./constants";
import { digestMcpToken } from "../src/mcp-token-crypto";
import { createApp } from "../src/index";
import { parseConfig } from "../src/config";
import { FakeMailer } from "../src/mailer";

const BASE_URL = "https://bitig.test/api/mcp-tokens";
const VALID_INPUT = { label: "My MCP client", transport: "bearer", expiresAt: null };
const CREATE_SQL = `CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY, org_id TEXT DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
  label TEXT NOT NULL, transport TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
)`;

function request(path = "", method = "GET", body?: unknown, headers?: Record<string, string>): Promise<Response> {
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

describe("MCP token management API", () => {
  beforeEach(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS mcp_tokens").run();
    await env.DB.prepare(CREATE_SQL).run();
  });

  it("creates independent random tokens, stores only their digest, and lists safe metadata", async () => {
    const first = await request("", "POST", VALID_INPUT);
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const created = CreatedMcpTokenSchema.parse(await first.json());
    const second = CreatedMcpTokenSchema.parse(await (await request("", "POST", VALID_INPUT)).json());
    expect(created.token).not.toBe(second.token);
    const stored = await env.DB.prepare("SELECT digest FROM mcp_tokens WHERE id = ?")
      .bind(created.credential.id).first<{ digest: string }>();
    expect(stored?.digest).toBe(await digestMcpToken(created.token));
    const listing = await request();
    expect(listing.headers.get("cache-control")).toBe("no-store");
    const text = await listing.text();
    expect(McpTokenListSchema.parse(JSON.parse(text))).toHaveLength(2);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain(stored?.digest);
  });

  it("revokes only the selected credential, idempotently", async () => {
    const first = CreatedMcpTokenSchema.parse(await (await request("", "POST", VALID_INPUT)).json());
    const second = CreatedMcpTokenSchema.parse(await (await request("", "POST", VALID_INPUT)).json());
    expect((await request(`/${first.credential.id}`, "DELETE")).status).toBe(200);
    expect((await request(`/${first.credential.id}`, "DELETE")).status).toBe(200);
    const list = McpTokenListSchema.parse(await (await request()).json());
    expect(list.find((row) => row.id === first.credential.id)?.revokedAt).not.toBeNull();
    expect(list.find((row) => row.id === second.credential.id)?.revokedAt).toBeNull();
    expect((await request(`/${crypto.randomUUID()}`, "DELETE")).status).toBe(404);
    expect((await request("/legacy", "DELETE")).status).toBe(400);
  });

  it("rejects unauthenticated and MCP-authenticated management, and cross-site writes", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const url = method === "DELETE" ? `${BASE_URL}/${crypto.randomUUID()}` : BASE_URL;
      expect((await exports.default.fetch(new Request(url, { method }))).status).toBe(401);
    }
    expect((await request("", "POST", VALID_INPUT, { Authorization: TEST_MCP_AUTH_HEADER })).status).toBe(401);
    expect((await request("", "POST", VALID_INPUT, { Origin: "https://evil.test" })).status).toBe(403);
  });

  it("accepts a dashboard session without Bearer credentials", async () => {
    const mailer = new FakeMailer();
    const app = createApp({ mailer });
    const sendCode = await app.request("https://bitig.test/api/auth/code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL }),
    }, env);
    expect(sendCode.status).toBe(200);
    const code = mailer.extractLastCode(TEST_BOOTSTRAP_EMAIL);
    expect(code).toBeDefined();
    const verify = await app.request("https://bitig.test/api/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_BOOTSTRAP_EMAIL, code }),
    }, env);
    expect(verify.status).toBe(200);
    const cookie = verify.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("Verify did not provide a session cookie");
    const response = await app.request(BASE_URL, { headers: { Cookie: cookie } }, env);
    expect(response.status).toBe(200);
  });

  it("rejects unsupported local storage mode without creating credentials", async () => {
    const app = createApp({ config: parseConfig({ ...env, STORAGE_MODE: "local" }) });
    const response = await app.request(BASE_URL, { headers: { Authorization: TEST_AUTH_HEADER } }, env);
    expect(response.status).toBe(409);
    expect(await request().then((result) => result.json())).toEqual([]);
  });

  it("sanitizes malformed JSON and normalizes expiry timestamps", async () => {
    const response = await exports.default.fetch(new Request(BASE_URL, {
      method: "POST", headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json" }, body: "{",
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_token_input" });
    const created = CreatedMcpTokenSchema.parse(await (await request("", "POST", {
      ...VALID_INPUT, expiresAt: "2099-01-01T00:00:00Z",
    })).json());
    expect(created.credential.expiresAt).toBe("2099-01-01T00:00:00.000Z");
  });

  it.each([
    { ...VALID_INPUT, label: " " }, { ...VALID_INPUT, transport: "other" },
    { ...VALID_INPUT, expiresAt: "2020-01-01T00:00:00Z" },
    { ...VALID_INPUT, expiresAt: "invalid" }, { ...VALID_INPUT, extra: true },
  ])("rejects invalid input %j", async (input) => {
    expect((await request("", "POST", input)).status).toBe(400);
  });

  it("bounds request size and active token creation", async () => {
    expect((await request("", "POST", { ...VALID_INPUT, label: "x".repeat(3000) })).status).toBe(413);
    const now = new Date().toISOString();
    await env.DB.batch(Array.from({ length: MCP_TOKEN_ACTIVE_LIMIT }, (_, index) =>
      env.DB.prepare("INSERT INTO mcp_tokens (id, label, transport, digest, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), "Existing", "bearer", String(index), now)));
    expect((await request("", "POST", VALID_INPUT)).status).toBe(409);
  });

  it("returns safe unavailable errors without logging database contents", async () => {
    const logger = vi.spyOn(console, "error");
    await env.DB.prepare("DROP TABLE mcp_tokens").run();
    const response = await request();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("SQLITE");
    expect(logger).not.toHaveBeenCalled();
  });
});
