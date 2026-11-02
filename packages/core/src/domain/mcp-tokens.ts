import { z } from "zod";

export const MCP_TOKEN_LABEL_MAX_LENGTH = 80;
export const MCP_TOKEN_ACTIVE_LIMIT = 100;
export const MCP_TOKEN_LIST_LIMIT = 200;
export const MCP_TOKEN_TRANSPORTS = ["bearer", "query"] as const;
export const McpTokenTransportSchema = z.enum(MCP_TOKEN_TRANSPORTS);
export type McpTokenTransport = z.output<typeof McpTokenTransportSchema>;

export const CreateMcpTokenSchema = z.strictObject({
  label: z.string().trim().min(1).max(MCP_TOKEN_LABEL_MAX_LENGTH),
  transport: McpTokenTransportSchema,
  expiresAt: z.iso.datetime().nullable(),
});
export type CreateMcpTokenInput = z.output<typeof CreateMcpTokenSchema>;

export const McpTokenMetadataSchema = CreateMcpTokenSchema.extend({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type McpTokenMetadata = z.output<typeof McpTokenMetadataSchema>;
export const McpTokenListSchema = z.array(McpTokenMetadataSchema).max(MCP_TOKEN_LIST_LIMIT);
export const CreatedMcpTokenSchema = z.strictObject({
  credential: McpTokenMetadataSchema,
  token: z.string().regex(/^bitig_mcp_[0-9a-f]{64}$/),
});
export type CreatedMcpToken = z.output<typeof CreatedMcpTokenSchema>;
