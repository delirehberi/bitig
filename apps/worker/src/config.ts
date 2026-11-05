import { STORAGE_MODES } from "@bitig/core";
import { z } from "zod";

const ORIGIN_SEPARATOR = ",";
const MIN_SESSION_SECRET_LENGTH = 32;
const NOSTR_PUBKEY_PATTERN = /^[0-9a-f]{64}$/;

const configSchema = z.object({
  ALLOWED_ORIGINS: z
    .string()
    .default("")
    .transform((raw) =>
      raw
        .split(ORIGIN_SEPARATOR)
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .pipe(z.array(z.url({ protocol: /^https?$/ }))),
  RESEND_API_KEY: z
    .string()
    .default("")
    .transform((val) => val.trim()),
  MAIL_FROM: z
    .string()
    .default("")
    .transform((val) => val.trim()),
  BOOTSTRAP_ADMIN_EMAIL: z
    .string()
    .default("")
    .transform((val) => val.trim().toLowerCase())
    .refine((val) => val.length === 0 || z.email().safeParse(val).success, {
      message: "must be a valid email address when set",
    }),
  MCP_AUTH_TOKEN: z.string().default(""),
  // Accepted as /mcp?token= for clients that cannot send headers. Empty disables it.
  MCP_URL_TOKEN: z.string().default(""),
  // HMAC key for dashboard session cookies. Empty disables both dashboard sign-in methods.
  SESSION_SECRET: z
    .string()
    .default("")
    .refine((secret) => secret.length === 0 || secret.length >= MIN_SESSION_SECRET_LENGTH, {
      message: `must be at least ${String(MIN_SESSION_SECRET_LENGTH)} characters`,
    }),
  // AES-256-GCM key material for encrypting T3 OAuth tokens at rest in D1. Empty disables T3 connection.
  T3_ENCRYPTION_KEY: z
    .string()
    .default("")
    .refine((secret) => secret.length === 0 || secret.length >= MIN_SESSION_SECRET_LENGTH, {
      message: `must be at least ${String(MIN_SESSION_SECRET_LENGTH)} characters`,
    }),
  // Optional Cloudflare Access Service Token headers sent on Worker-to-T3 requests.
  T3_CF_ACCESS_CLIENT_ID: z
    .string()
    .default("")
    .transform((val) => val.trim()),
  T3_CF_ACCESS_CLIENT_SECRET: z
    .string()
    .default("")
    .transform((val) => val.trim()),
  NOSTR_AUTH_PUBKEYS: z
    .string()
    .default("")
    .transform((raw) => raw.split(ORIGIN_SEPARATOR).map((key) => key.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().regex(NOSTR_PUBKEY_PATTERN))),
  // Chosen per deployment; the dashboard reads it from /health instead of offering a switch.
  STORAGE_MODE: z.enum(STORAGE_MODES).default("cloudflare"),
});

export type AppConfig = z.infer<typeof configSchema>;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/**
 * Validates Worker bindings once per request. Workers have no process-level
 * startup hook, so parsing here is the earliest point env is available.
 */
export function parseConfig(env: unknown): AppConfig {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`invalid worker configuration: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

