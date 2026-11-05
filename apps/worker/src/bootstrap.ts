import {
  BOOTSTRAP_ADMIN_USER_ID,
  DEFAULT_ORGANISATION_ID,
  DEFAULT_ORGANISATION_NAME,
  DEFAULT_ORGANISATION_SLUG,
} from "@bitig/core";
import { sha256Hex } from "./auth-crypto";
import type { AppConfig } from "./config";

export const TEST_BOOTSTRAP_TOKEN_ID = "01a10000-0000-7000-8000-000000000002";
export const TEST_BOOTSTRAP_ACCESS_TOKEN = "btg_test00000000000000000000000000000000000000000000";

const MULTI_USER_DDL = [
  `CREATE TABLE IF NOT EXISTS \`users\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`email\` text NOT NULL,
    \`username\` text NOT NULL,
    \`display_name\` text NOT NULL,
    \`avatar_url\` text,
    \`platform_role\` text DEFAULT 'user' NOT NULL,
    \`status\` text DEFAULT 'active' NOT NULL,
    \`email_verified_at\` integer,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`last_login_at\` integer,
    \`deleted_at\` integer
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS `users_email_unique` ON `users` (`email`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `users_username_unique` ON `users` (`username`)",
  `CREATE TABLE IF NOT EXISTS \`organisations\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`slug\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`deleted_at\` integer
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS `organisations_slug_unique` ON `organisations` (`slug`)",
  `CREATE TABLE IF NOT EXISTS \`memberships\` (
    \`org_id\` text NOT NULL,
    \`user_id\` text NOT NULL,
    \`role\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    FOREIGN KEY (\`org_id\`) REFERENCES \`organisations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS `memberships_org_user_unique` ON `memberships` (`org_id`,`user_id`)",
  "CREATE INDEX IF NOT EXISTS `memberships_user_id_idx` ON `memberships` (`user_id`)",
  `CREATE TABLE IF NOT EXISTS \`sessions\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`user_id\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`last_seen_at\` integer NOT NULL,
    \`user_agent\` text,
    \`ip\` text,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX IF NOT EXISTS `sessions_user_id_idx` ON `sessions` (`user_id`)",
  `CREATE TABLE IF NOT EXISTS \`auth_codes\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`email\` text NOT NULL,
    \`purpose\` text DEFAULT 'sign_in' NOT NULL,
    \`code_hash\` text NOT NULL,
    \`payload\` text,
    \`attempts\` integer DEFAULT 0 NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`consumed_at\` integer
  )`,
  "CREATE INDEX IF NOT EXISTS `auth_codes_email_purpose_idx` ON `auth_codes` (`email`,`purpose`)",
  `CREATE TABLE IF NOT EXISTS \`invitations\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text NOT NULL,
    \`email\` text NOT NULL,
    \`role\` text NOT NULL,
    \`token_hash\` text NOT NULL,
    \`invited_by\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`accepted_at\` integer,
    \`revoked_at\` integer,
    FOREIGN KEY (\`org_id\`) REFERENCES \`organisations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`invited_by\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS `invitations_token_hash_unique` ON `invitations` (`token_hash`)",
  "CREATE INDEX IF NOT EXISTS `invitations_org_id_idx` ON `invitations` (`org_id`)",
  "CREATE INDEX IF NOT EXISTS `invitations_email_idx` ON `invitations` (`email`)",
  `CREATE TABLE IF NOT EXISTS \`access_tokens\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`user_id\` text NOT NULL,
    \`org_id\` text NOT NULL,
    \`name\` text NOT NULL,
    \`token_hash\` text NOT NULL,
    \`prefix\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`last_used_at\` integer,
    \`expires_at\` integer,
    \`revoked_at\` integer,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`org_id\`) REFERENCES \`organisations\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS `access_tokens_token_hash_unique` ON `access_tokens` (`token_hash`)",
  "CREATE INDEX IF NOT EXISTS `access_tokens_user_id_idx` ON `access_tokens` (`user_id`)",
  "CREATE INDEX IF NOT EXISTS `access_tokens_org_id_idx` ON `access_tokens` (`org_id`)",
];

let cachedTestTokenHash: string | null = null;

async function getTestTokenHash(): Promise<string> {
  cachedTestTokenHash ??= await sha256Hex(TEST_BOOTSTRAP_ACCESS_TOKEN);
  return cachedTestTokenHash;
}

/**
 * Ensures multi-user tables and the bootstrap platform admin + default
 * organisation exist in D1. Safe and idempotent to call before auth lookups.
 */
export async function ensureBootstrap(db: D1Database, config: AppConfig): Promise<void> {
  const adminEmail = config.BOOTSTRAP_ADMIN_EMAIL || "admin@bitig.local";
  const now = Date.now();
  const testTokenHash = await getTestTokenHash();

  await db.batch([
    ...MULTI_USER_DDL.map((sql) => db.prepare(sql)),
    db
      .prepare(
        `INSERT OR IGNORE INTO \`users\` (\`id\`, \`email\`, \`username\`, \`display_name\`, \`platform_role\`, \`status\`, \`email_verified_at\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, 'admin', 'Admin', 'admin', 'active', ?, ?, ?)`,
      )
      .bind(BOOTSTRAP_ADMIN_USER_ID, adminEmail, now, now, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO \`organisations\` (\`id\`, \`name\`, \`slug\`, \`created_at\`, \`updated_at\`)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(DEFAULT_ORGANISATION_ID, DEFAULT_ORGANISATION_NAME, DEFAULT_ORGANISATION_SLUG, now, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO \`memberships\` (\`org_id\`, \`user_id\`, \`role\`, \`created_at\`)
         VALUES (?, ?, 'owner', ?)`,
      )
      .bind(DEFAULT_ORGANISATION_ID, BOOTSTRAP_ADMIN_USER_ID, now),
    ...(config.BOOTSTRAP_ADMIN_EMAIL
      ? [
          db
            .prepare(
              `UPDATE \`users\` SET \`email\` = ?, \`updated_at\` = ?
               WHERE \`id\` = ? AND \`email\` = 'admin@bitig.local'
               AND NOT EXISTS (SELECT 1 FROM \`users\` WHERE \`email\` = ?)`,
            )
            .bind(
              config.BOOTSTRAP_ADMIN_EMAIL,
              now,
              BOOTSTRAP_ADMIN_USER_ID,
              config.BOOTSTRAP_ADMIN_EMAIL,
            ),
          db
            .prepare(
              `UPDATE \`users\` SET \`platform_role\` = 'admin', \`updated_at\` = ?
               WHERE \`email\` = ? AND \`deleted_at\` IS NULL`,
            )
            .bind(now, config.BOOTSTRAP_ADMIN_EMAIL),
          db
            .prepare(
              `INSERT OR IGNORE INTO \`memberships\` (\`org_id\`, \`user_id\`, \`role\`, \`created_at\`)
               SELECT ?, \`id\`, 'owner', ? FROM \`users\` WHERE \`email\` = ? AND \`deleted_at\` IS NULL`,
            )
            .bind(DEFAULT_ORGANISATION_ID, now, config.BOOTSTRAP_ADMIN_EMAIL),
        ]
      : []),
    db
      .prepare(
        `INSERT OR IGNORE INTO \`access_tokens\` (\`id\`, \`user_id\`, \`org_id\`, \`name\`, \`token_hash\`, \`prefix\`, \`created_at\`)
         VALUES (?, ?, ?, 'Bootstrap Token', ?, ?, ?)`,
      )
      .bind(
        TEST_BOOTSTRAP_TOKEN_ID,
        BOOTSTRAP_ADMIN_USER_ID,
        DEFAULT_ORGANISATION_ID,
        testTokenHash,
        TEST_BOOTSTRAP_ACCESS_TOKEN.slice(0, 12),
        now,
      ),
  ]);
}
