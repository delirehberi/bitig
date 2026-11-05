import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpTokenStore } from "@bitig/storage-d1";
import { CreatedMcpTokenSchema, type McpTokenMetadata, type McpTokenTransport } from "@bitig/core";
import { bearerAuth } from "../src/auth";
import { parseConfig } from "../src/config";
import type { AppEnv } from "../src/index";
import { digestMcpToken, generateMcpToken } from "../src/mcp-token-crypto";
import { TEST_AUTH_HEADER, TEST_MCP_TOKEN, TEST_MCP_URL_TOKEN } from "./constants";
import { AUTH_FAIL_POLICY } from "../src/rate-limit";

const BASE_URL = "https://bitig.test";
const CREATE_SQL = `CREATE TABLE mcp_tokens (
  id TEXT PRIMARY KEY, org_id TEXT DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
  label TEXT NOT NULL, transport TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, expires_at TEXT, revoked_at TEXT
)`;

function authApp(legacyEnabled = true): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("config", parseConfig({ ...env, ...(!legacyEnabled ? { MCP_AUTH_TOKEN: "", MCP_URL_TOKEN: "" } : {}) }));
    return next();
  });
  app.use("*", bearerAuth());
  app.all("*", (context) => context.json({ authenticated: true }));
  return app;
}

async function managed(transport: McpTokenTransport, expiresAt: string | null = null) {
  const token = generateMcpToken();
  const metadata: McpTokenMetadata = {
    id: crypto.randomUUID(), label: "Client", transport,
    createdAt: new Date().toISOString(), expiresAt, revokedAt: null,
  };
  await new McpTokenStore(env.DB).create(metadata, await digestMcpToken(token));
  return { token, metadata };
}

function authenticate(token: string, transport: McpTokenTransport, legacyEnabled = true, headers = {}) {
  return authApp(legacyEnabled).request(
    `${BASE_URL}/mcp${transport === "query" ? `?token=${token}` : ""}`,
    { headers: { ...(transport === "bearer" ? { Authorization: `Bearer ${token}` } : {}), ...headers } }, env,
  );
}

describe("Managed MCP authentication", () => {
  beforeEach(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS mcp_tokens").run();
    await env.DB.prepare(CREATE_SQL).run();
  });

  it.each(["bearer", "query"] as const)("accepts %s credentials without configured legacy secrets", async (transport) => {
    const { token } = await managed(transport);
    expect((await authenticate(token, transport, false)).status).toBe(200);
    expect((await authenticate(token, transport === "bearer" ? "query" : "bearer")).status).toBe(401);
  });

  it("preserves header precedence, including empty/malformed headers", async () => {
    const { token } = await managed("query");
    for (const Authorization of ["Bearer wrong", "Bearer ", "Basic invalid", ""]) {
      expect((await authenticate(token, "query", true, { Authorization })).status).toBe(401);
    }
  });

  it("revokes only one credential and rejects expiry and unknown digests", async () => {
    const first = await managed("bearer");
    const second = await managed("bearer");
    await new McpTokenStore(env.DB).revoke(first.metadata.id, new Date().toISOString());
    expect((await authenticate(first.token, "bearer")).status).toBe(401);
    expect((await authenticate(second.token, "bearer")).status).toBe(200);
    const expired = await managed("bearer", "2020-01-01T00:00:00.000Z");
    expect((await authenticate(expired.token, "bearer")).status).toBe(401);
    expect((await authenticate(generateMcpToken(), "bearer")).status).toBe(401);
  });

  it("keeps both legacy secrets working before and after create/revoke and without the new table", async () => {
    for (const stage of ["before", "revoked", "table-missing"]) {
      if (stage === "revoked") {
        const { metadata } = await managed("bearer");
        await new McpTokenStore(env.DB).revoke(metadata.id, new Date().toISOString());
      }
      if (stage === "table-missing") await env.DB.prepare("DROP TABLE mcp_tokens").run();
      expect((await authenticate(TEST_MCP_TOKEN, "bearer")).status).toBe(200);
      expect((await authenticate(TEST_MCP_URL_TOKEN, "query")).status).toBe(200);
    }
  });

  it("fails closed with a sanitized response on managed-token storage errors", async () => {
    const logger = vi.spyOn(console, "error");
    await env.DB.prepare("DROP TABLE mcp_tokens").run();
    const token = generateMcpToken();
    for (const transport of ["bearer", "query"] as const) {
      const response = await authenticate(token, transport);
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(token);
    }
    expect(logger).not.toHaveBeenCalled();
  });

  it("counts managed failures toward the shared failed-login budget", async () => {
    const ip = "203.0.113.190";
    for (let attempt = 0; attempt < AUTH_FAIL_POLICY.max; attempt += 1) {
      const response = await exports.default.fetch(new Request(`${BASE_URL}/mcp`, {
        method: "POST", headers: { Authorization: `Bearer ${generateMcpToken()}`, "cf-connecting-ip": ip },
      }));
      expect(response.status).toBe(401);
    }
    const response = await exports.default.fetch(new Request(`${BASE_URL}/mcp`, {
      method: "POST", headers: { Authorization: `Bearer ${TEST_MCP_TOKEN}`, "cf-connecting-ip": ip },
    }));
    expect(response.status).toBe(429);
  });

  it.each(["bearer", "query"] as const)("connects a real MCP client using a generated %s credential", async (transport) => {
    const response = await exports.default.fetch(new Request(`${BASE_URL}/api/mcp-tokens`, {
      method: "POST", headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "Integration client", transport, expiresAt: null }),
    }));
    const { token } = CreatedMcpTokenSchema.parse(await response.json());
    const client = new Client({ name: "managed-client", version: "1.0.0" });
    const clientTransport = new StreamableHTTPClientTransport(new URL(
      `${BASE_URL}/mcp${transport === "query" ? `/client?token=${token}` : ""}`,
    ), {
      fetch: (input, init) => exports.default.fetch(new Request(input, init)),
      ...(transport === "bearer" ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {}),
    });
    try {
      await client.connect({
        start: () => clientTransport.start(),
        send: (message, options) => clientTransport.send(message, options),
        close: () => clientTransport.close(),
        set onclose(handler: NonNullable<Transport["onclose"]>) { clientTransport.onclose = handler; },
        set onerror(handler: NonNullable<Transport["onerror"]>) { clientTransport.onerror = handler; },
        set onmessage(handler: NonNullable<Transport["onmessage"]>) { clientTransport.onmessage = handler; },
      });
      expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
