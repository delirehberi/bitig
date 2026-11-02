CREATE TABLE `mcp_tokens` (
  `id` text PRIMARY KEY NOT NULL,
  `label` text NOT NULL,
  `transport` text NOT NULL,
  `digest` text NOT NULL,
  `created_at` text NOT NULL,
  `expires_at` text,
  `revoked_at` text,
  CONSTRAINT `mcp_tokens_transport_check` CHECK (`mcp_tokens`.`transport` IN ('bearer', 'query'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_tokens_digest_unique` ON `mcp_tokens` (`digest`);
