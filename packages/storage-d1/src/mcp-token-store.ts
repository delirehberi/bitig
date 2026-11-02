import {
  MCP_TOKEN_ACTIVE_LIMIT,
  MCP_TOKEN_LIST_LIMIT,
  McpTokenMetadataSchema,
  type McpTokenMetadata,
  type McpTokenTransport,
} from "@bitig/core";

const METADATA_COLUMNS = `id, label, transport, created_at AS createdAt,
  expires_at AS expiresAt, revoked_at AS revokedAt`;
const ACTIVE_PREDICATE = "revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)";

export class McpTokenStore {
  constructor(private readonly db: D1Database) {}

  async list(now: string): Promise<McpTokenMetadata[]> {
    const rows = await this.db.prepare(
      `SELECT ${METADATA_COLUMNS} FROM mcp_tokens
       ORDER BY (${ACTIVE_PREDICATE}) DESC, created_at DESC, id DESC LIMIT ?`,
    ).bind(now, MCP_TOKEN_LIST_LIMIT).all<McpTokenMetadata>();
    return rows.results.map((row) => McpTokenMetadataSchema.parse(row));
  }

  async create(credential: McpTokenMetadata, digest: string): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO mcp_tokens (id, label, transport, digest, created_at, expires_at, revoked_at)
       SELECT ?, ?, ?, ?, ?, ?, NULL
       WHERE (SELECT COUNT(*) FROM mcp_tokens WHERE ${ACTIVE_PREDICATE}) < ?`,
    ).bind(
      credential.id, credential.label, credential.transport, digest,
      credential.createdAt, credential.expiresAt, credential.createdAt, MCP_TOKEN_ACTIVE_LIMIT,
    ).run();
    return result.meta.changes > 0;
  }

  async revoke(id: string, now: string): Promise<McpTokenMetadata | null> {
    const row = await this.db.prepare(
      `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? RETURNING ${METADATA_COLUMNS}`,
    ).bind(now, id).first<McpTokenMetadata>();
    return row === null ? null : McpTokenMetadataSchema.parse(row);
  }

  async accepts(digest: string, transport: McpTokenTransport, now: string): Promise<boolean> {
    const row = await this.db.prepare(
      `SELECT id FROM mcp_tokens WHERE digest = ? AND transport = ? AND ${ACTIVE_PREDICATE}`,
    ).bind(digest, transport, now).first<{ id: string }>();
    return row !== null;
  }
}
