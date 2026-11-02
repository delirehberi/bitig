import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { MCP_TOKEN_ACTIVE_LIMIT, MCP_TOKEN_LIST_LIMIT, type McpTokenMetadata } from "@bitig/core";
import migration from "../migrations/0017_mcp_tokens.sql?raw";
import { McpTokenStore } from "./mcp-token-store";

const NOW = "2026-11-02T00:00:00.000Z";
const LATER = "2026-11-03T00:00:00.000Z";
const DIGEST = "a".repeat(64);
const credential = (): McpTokenMetadata => ({
  id: crypto.randomUUID(), label: "Test client", transport: "bearer",
  createdAt: NOW, expiresAt: null, revokedAt: null,
});

describe("McpTokenStore", () => {
  beforeEach(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS mcp_tokens").run();
    for (const statement of migration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
  });

  it("stores only digests and never lists them", async () => {
    const store = new McpTokenStore(env.DB);
    const metadata = credential();
    expect(await store.create(metadata, DIGEST)).toBe(true);
    expect(await store.list(NOW)).toEqual([metadata]);
    expect(await store.accepts(DIGEST, "bearer", NOW)).toBe(true);
    expect(await store.accepts(DIGEST, "query", NOW)).toBe(false);
    expect(await store.accepts("unknown", "bearer", NOW)).toBe(false);
  });

  it("expires at the exact boundary and revokes idempotently", async () => {
    const store = new McpTokenStore(env.DB);
    const metadata = { ...credential(), expiresAt: LATER };
    await store.create(metadata, DIGEST);
    expect(await store.accepts(DIGEST, "bearer", LATER)).toBe(false);
    expect(await store.revoke(metadata.id, NOW)).toEqual({ ...metadata, revokedAt: NOW });
    expect(await store.revoke(metadata.id, LATER)).toEqual({ ...metadata, revokedAt: NOW });
    expect(await store.accepts(DIGEST, "bearer", NOW)).toBe(false);
    expect(await store.revoke(crypto.randomUUID(), NOW)).toBeNull();
  });

  it("atomically limits active credentials and frees capacity on revoke", async () => {
    const store = new McpTokenStore(env.DB);
    const first = credential();
    const credentials = [first, ...Array.from({ length: MCP_TOKEN_ACTIVE_LIMIT - 1 }, credential)];
    await env.DB.batch(credentials.map((metadata, index) => env.DB.prepare(
      "INSERT INTO mcp_tokens (id, label, transport, digest, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(metadata.id, metadata.label, metadata.transport, String(index), NOW)));
    const extra = credential();
    expect(await store.create(extra, DIGEST)).toBe(false);
    await store.revoke(first.id, NOW);
    expect(await store.create(extra, DIGEST)).toBe(true);
  });

  it("bounds history but never hides an active credential behind inactive records", async () => {
    const store = new McpTokenStore(env.DB);
    const active = credential();
    await store.create(active, DIGEST);
    await env.DB.batch(Array.from({ length: MCP_TOKEN_LIST_LIMIT }, (_value, index) => env.DB.prepare(
      "INSERT INTO mcp_tokens (id, label, transport, digest, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), "Inactive", "bearer", String(index), LATER, LATER)));
    const list = await store.list(LATER);
    expect(list).toHaveLength(MCP_TOKEN_LIST_LIMIT);
    expect(list[0]).toEqual(active);
  });

  it("frees capacity for expired credentials and enforces transport constraints", async () => {
    const store = new McpTokenStore(env.DB);
    await env.DB.batch(Array.from({ length: MCP_TOKEN_ACTIVE_LIMIT }, (_value, index) => env.DB.prepare(
      "INSERT INTO mcp_tokens (id, label, transport, digest, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), "Expired", "bearer", String(index), NOW, NOW)));
    expect(await store.create(credential(), DIGEST)).toBe(true);
    await expect(env.DB.prepare(
      "INSERT INTO mcp_tokens (id, label, transport, digest, created_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(crypto.randomUUID(), "Invalid", "invalid", "invalid", NOW).run()).rejects.toThrow(/CHECK constraint/);
  });
});
