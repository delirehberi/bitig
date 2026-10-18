import { STORAGE_MODES } from "@bitig/core";
import { z } from "zod";

const ORIGIN_SEPARATOR = ",";

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

