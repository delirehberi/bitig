import {
  DEFAULT_ORGANISATION_ID,
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
  private readonly orgId: string;

  constructor(
    private readonly db: D1Database,
    orgId = DEFAULT_ORGANISATION_ID,
  ) {
    this.orgId = orgId;
  }

  async list(now: string): Promise<McpTokenMetadata[]> {
    const rows = await this.db.prepare(
      `SELECT ${METADATA_COLUMNS} FROM mcp_tokens
       WHERE org_id = ?
       ORDER BY (${ACTIVE_PREDICATE}) DESC, created_at DESC, id DESC LIMIT ?`,
    ).bind(this.orgId, now, MCP_TOKEN_LIST_LIMIT).all<McpTokenMetadata>();
    return rows.results.map((row) => McpTokenMetadataSchema.parse(row));
  }

  async create(credential: McpTokenMetadata, digest: string): Promise<boolean> {
    const result = await this.db.prepare(
      `INSERT INTO mcp_tokens (id, org_id, label, transport, digest, created_at, expires_at, revoked_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, NULL
       WHERE (SELECT COUNT(*) FROM mcp_tokens WHERE org_id = ? AND ${ACTIVE_PREDICATE}) < ?`,
    ).bind(
      credential.id,
      this.orgId,
      credential.label,
      credential.transport,
      digest,
      credential.createdAt,
      credential.expiresAt,
      this.orgId,
      credential.createdAt,
      MCP_TOKEN_ACTIVE_LIMIT,
    ).run();
    return result.meta.changes > 0;
  }

  async revoke(id: string, now: string): Promise<McpTokenMetadata | null> {
    const row = await this.db.prepare(
      `UPDATE mcp_tokens SET revoked_at = COALESCE(revoked_at, ?)
       WHERE id = ? AND org_id = ? RETURNING ${METADATA_COLUMNS}`,
    ).bind(now, id, this.orgId).first<McpTokenMetadata>();
    return row === null ? null : McpTokenMetadataSchema.parse(row);
  }

  async resolveOrgId(digest: string, transport: McpTokenTransport, now: string): Promise<string | null> {
    const row = await this.db.prepare(
      `SELECT org_id AS orgId FROM mcp_tokens WHERE digest = ? AND transport = ? AND ${ACTIVE_PREDICATE}`,
    ).bind(digest, transport, now).first<{ orgId?: string | null }>();
    if (row === null) return null;
    return row.orgId ?? DEFAULT_ORGANISATION_ID;
  }

  async accepts(digest: string, transport: McpTokenTransport, now: string): Promise<boolean> {
    return (await this.resolveOrgId(digest, transport, now)) !== null;
  }
}

