import { STORAGE_MODES } from "@bitig/core";
import { z } from "zod";

const ORIGIN_SEPARATOR = ",";
const MIN_SESSION_SECRET_LENGTH = 32;

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
  BASIC_AUTH_USER: z.string().default("admin"),
  BASIC_AUTH_PASS: z.string().default(""),
  MCP_AUTH_TOKEN: z.string().default(""),
  // Accepted as /mcp?token= for clients that cannot send headers. Empty disables it.
  MCP_URL_TOKEN: z.string().default(""),
  // HMAC key for dashboard session cookies. Empty disables /api/auth/login.
  SESSION_SECRET: z
    .string()
    .default("")
    .refine((secret) => secret.length === 0 || secret.length >= MIN_SESSION_SECRET_LENGTH, {
      message: `must be at least ${String(MIN_SESSION_SECRET_LENGTH)} characters`,
    }),
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

