CREATE TABLE IF NOT EXISTS `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`platform_role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`email_verified_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_login_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `organisations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `organisations_slug_unique` ON `organisations` (`slug`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `memberships` (
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `memberships_org_user_unique` ON `memberships` (`org_id`,`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `memberships_user_id_idx` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`user_agent` text,
	`ip` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `sessions_user_id_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `auth_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`purpose` text DEFAULT 'sign_in' NOT NULL,
	`code_hash` text NOT NULL,
	`payload` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `auth_codes_email_purpose_idx` ON `auth_codes` (`email`,`purpose`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text NOT NULL,
	`token_hash` text NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`accepted_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invitations_org_id_idx` ON `invitations` (`org_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `invitations_email_idx` ON `invitations` (`email`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `access_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `access_tokens_token_hash_unique` ON `access_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `access_tokens_user_id_idx` ON `access_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `access_tokens_org_id_idx` ON `access_tokens` (`org_id`);--> statement-breakpoint
INSERT OR IGNORE INTO `users` (`id`, `email`, `username`, `display_name`, `platform_role`, `status`, `created_at`, `updated_at`) VALUES ('01a10000-0000-7000-8000-000000000000', 'admin@bitig.local', 'admin', 'Admin', 'admin', 'active', 1791723553130, 1791723553130);--> statement-breakpoint
INSERT OR IGNORE INTO `organisations` (`id`, `name`, `slug`, `created_at`, `updated_at`) VALUES ('01a10000-0000-7000-8000-000000000001', 'Default Organisation', 'default', 1791723553130, 1791723553130);--> statement-breakpoint
INSERT OR IGNORE INTO `memberships` (`org_id`, `user_id`, `role`, `created_at`) VALUES ('01a10000-0000-7000-8000-000000000001', '01a10000-0000-7000-8000-000000000000', 'owner', 1791723553130);--> statement-breakpoint
ALTER TABLE `projects` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `projects_org_id_idx` ON `projects` (`org_id`);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `projects_org_key_unique` ON `projects` (`org_id`,`key`);--> statement-breakpoint
ALTER TABLE `comments` ADD `author_id` text;--> statement-breakpoint
ALTER TABLE `comments` ADD `author_avatar_url` text;--> statement-breakpoint
ALTER TABLE `t3_connections` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `t3_connections_org_id_unique` ON `t3_connections` (`org_id`);--> statement-breakpoint
ALTER TABLE `t3_oauth_states` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcp_tokens` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `mcp_tokens_org_id_idx` ON `mcp_tokens` (`org_id`);

