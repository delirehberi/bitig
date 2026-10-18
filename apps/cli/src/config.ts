/**
 * Configuration file loading and schema validation.
 */
import { parseOrThrow, StorageError } from "@bitig/core";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const BitigConfigSchema = z.strictObject({
  data_dir: z.string().min(1).optional(),
});

export type BitigConfig = z.output<typeof BitigConfigSchema>;

export function expandHome(filePath: string, homedir: string): string {
  if (filePath === "~") return homedir;
  if (filePath.startsWith("~/")) return path.join(homedir, filePath.slice(2));
  return filePath;
}

export function parseConfigFile(content: string, location: string): BitigConfig {
  try {
    const raw: unknown = parseYaml(content);
    const mapping = raw ?? {};
    return parseOrThrow(BitigConfigSchema, mapping, "config file");
  } catch (err) {
    throw new StorageError("corrupt", err instanceof Error ? err.message : String(err), {
      location,
      cause: err,
    });
  }
}
