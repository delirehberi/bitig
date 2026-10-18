/**
 * Precedence resolution for Bitig configuration and data directories.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { expandHome, parseConfigFile, type BitigConfig } from "../config";
import { resolveXdgPaths } from "./xdg";

export type PathSource = "flag" | "env" | "config" | "default";

export interface ResolvePathsInput {
  readonly flags?: {
    readonly dataDir?: string | undefined;
    readonly config?: string | undefined;
  } | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
  readonly readFileSync: (filePath: string) => string | null;
}

export interface ResolvedBitigPaths {
  readonly dataDir: string;
  readonly dataDirSource: PathSource;
  readonly configFile: string;
  readonly configSource: PathSource;
  readonly lockFile: string;
  readonly config: BitigConfig;
}

export function resolveBitigPaths(opts: ResolvePathsInput): ResolvedBitigPaths {
  const xdg = resolveXdgPaths({ env: opts.env, homedir: opts.homedir });

  // 1. Resolve Config File
  let configFile: string;
  let configSource: PathSource;

  if (opts.flags?.config !== undefined && opts.flags.config.trim() !== "") {
    configFile = path.resolve(expandHome(opts.flags.config, opts.homedir));
    configSource = "flag";
  } else if (opts.env.BITIG_CONFIG !== undefined && opts.env.BITIG_CONFIG.trim() !== "") {
    configFile = path.resolve(expandHome(opts.env.BITIG_CONFIG, opts.homedir));
    configSource = "env";
  } else {
    configFile = path.join(xdg.configHome, "bitig", "config.yaml");
    configSource = "default";
  }

  // Read config file if present
  let config: BitigConfig = {};
  const configContent = opts.readFileSync(configFile);
  if (configContent !== null) {
    config = parseConfigFile(configContent, configFile);
  } else if (configSource !== "default") {
    throw new Error(`Explicit config file not found: ${configFile}`);
  }

  // 2. Resolve Data Dir
  let dataDir: string;
  let dataDirSource: PathSource;

  if (opts.flags?.dataDir !== undefined && opts.flags.dataDir.trim() !== "") {
    dataDir = path.resolve(expandHome(opts.flags.dataDir, opts.homedir));
    dataDirSource = "flag";
  } else if (opts.env.BITIG_DATA_DIR !== undefined && opts.env.BITIG_DATA_DIR.trim() !== "") {
    dataDir = path.resolve(expandHome(opts.env.BITIG_DATA_DIR, opts.homedir));
    dataDirSource = "env";
  } else if (config.data_dir !== undefined && config.data_dir.trim() !== "") {
    dataDir = path.resolve(expandHome(config.data_dir, opts.homedir));
    dataDirSource = "config";
  } else {
    dataDir = path.join(xdg.dataHome, "bitig");
    dataDirSource = "default";
  }

  // 3. Resolve Lock File
  let lockFile: string;
  const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  if (xdg.runtimeDir !== undefined) {
    lockFile = path.join(xdg.runtimeDir, "bitig", `${hash}.lock`);
  } else {
    lockFile = path.join(dataDir, ".bitig.lock");
  }

  return {
    dataDir,
    dataDirSource,
    configFile,
    configSource,
    lockFile,
    config,
  };
}
