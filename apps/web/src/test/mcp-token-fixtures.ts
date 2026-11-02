import type { CreatedMcpToken, McpTokenMetadata } from "@bitig/core";

export const TOKEN_METADATA: McpTokenMetadata = {
  id: "01940000-0000-7000-8000-000000000001",
  label: "Laptop client", transport: "bearer",
  createdAt: "2026-01-01T00:00:00.000Z", expiresAt: null, revokedAt: null,
};

export const CREATED_TOKEN: CreatedMcpToken = {
  credential: TOKEN_METADATA,
  token: `bitig_mcp_${"a".repeat(64)}`,
};
