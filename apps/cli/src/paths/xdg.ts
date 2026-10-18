/**
 * Pure XDG Base Directory resolution.
 */
import * as path from "node:path";

export interface XdgEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homedir: string;
}

export interface XdgPaths {
  readonly configHome: string;
  readonly dataHome: string;
  readonly runtimeDir: string | undefined;
}

function getValidDir(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === "" || !path.isAbsolute(value)) {
    return undefined;
  }
  return path.normalize(value);
}

export function resolveXdgPaths(opts: XdgEnvironment): XdgPaths {
  const configHome = getValidDir(opts.env.XDG_CONFIG_HOME) ?? path.join(opts.homedir, ".config");
  const dataHome = getValidDir(opts.env.XDG_DATA_HOME) ?? path.join(opts.homedir, ".local", "share");
  const runtimeDir = getValidDir(opts.env.XDG_RUNTIME_DIR);

  return {
    configHome,
    dataHome,
    runtimeDir,
  };
}

