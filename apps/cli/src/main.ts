import { isBitigError } from "@bitig/core";
import { MarkdownStorage } from "@bitig/storage-markdown";
import { FileLock, NodeFileSystem } from "@bitig/storage-markdown/node";
import { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerInitCommand } from "./commands/init";
import { registerInteropCommands } from "./commands/interop";
import { registerMcpCommand } from "./commands/mcp";
import { registerPathsCommand } from "./commands/paths";
import { registerProjectsCommands } from "./commands/projects";
import { registerTasksCommands } from "./commands/tasks";
import { EXIT_FAILURE, EXIT_OK } from "./exit-codes";
import { resolveBitigPaths, type ResolvedBitigPaths } from "./paths/resolve";
import type { StorageFactoryOptions } from "./storage-factory";

const DATA_DIR_MODE = 0o700;
const CREATE_DATA_DIR_HINT = "Run `bitig init`, `bitig import` or `bitig restore` with this path to create it.";

export async function runCli(argv: string[] = process.argv): Promise<number> {
  const program = new Command();
  program
    .name("bitig")
    .description("Bitig — flexible, edge-ready task and project manager")
    .version("0.1.0")
    .option("--data-dir <path>", "Data directory location (overrides BITIG_DATA_DIR)")
    .option("--config <path>", "Configuration file location (overrides BITIG_CONFIG)")
    .option("-q, --quiet", "Suppress non-essential output");

  const homedir = os.homedir();
  const envSnapshot = { ...process.env };

  const getPaths = (): ResolvedBitigPaths => {
    const opts = program.opts<{ dataDir?: string; config?: string }>();
    return resolveBitigPaths({
      flags: {
        dataDir: opts.dataDir,
        config: opts.config,
      },
      env: envSnapshot,
      homedir,
      readFileSync: (p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
    });
  };

  let storageInstance: MarkdownStorage | null = null;
  const getStorage = (options?: StorageFactoryOptions): Promise<MarkdownStorage> => {
    if (storageInstance !== null) return Promise.resolve(storageInstance);

    const paths = getPaths();

    if (paths.dataDirSource === "default") {
      mkdirSync(paths.dataDir, { recursive: true, mode: DATA_DIR_MODE });
    } else if (!existsSync(paths.dataDir)) {
      if (options?.createDataDir !== true) {
        throw new Error(`Data directory does not exist: ${paths.dataDir}. ${CREATE_DATA_DIR_HINT}`);
      }
      mkdirSync(paths.dataDir, { recursive: true, mode: DATA_DIR_MODE });
      // stderr, so JSON output on stdout stays parseable.
      if (program.opts<{ quiet?: boolean }>().quiet !== true) {
        console.error(`Created data directory: ${paths.dataDir}`);
      }
    } else {
      const stat = statSync(paths.dataDir);
      if (!stat.isDirectory()) {
        throw new Error(`Data directory path is not a directory: ${paths.dataDir}`);
      }
    }

    const nodeFs = new NodeFileSystem({ rootDir: paths.dataDir });
    const fileLock = new FileLock({
      lockPath: paths.lockFile,
      fallbackLockPath: path.join(paths.dataDir, ".bitig.lock"),
    });

    storageInstance = new MarkdownStorage({
      fs: nodeFs,
      lock: fileLock,
    });

    return Promise.resolve(storageInstance);
  };

  registerPathsCommand(program, getPaths);
  registerInitCommand(program, getStorage);
  registerProjectsCommands(program, getStorage);
  registerTasksCommands(program, getStorage, homedir);
  registerInteropCommands(program, getStorage);
  registerMcpCommand(program, getStorage);

  try {
    await program.parseAsync(argv);
    return EXIT_OK;
  } catch (err: unknown) {
    if (isBitigError(err)) {
      console.error(`[${err.code}] ${err.message}`);
    } else {
      console.error(err instanceof Error ? err.message : String(err));
    }
    return EXIT_FAILURE;
  }
}

// If invoked directly as main module
if (import.meta.url.startsWith("file:") && process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    process.exit(EXIT_FAILURE);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    process.exit(EXIT_FAILURE);
  });
  // Handle EPIPE quietly (e.g. `bitig tasks list | head`). Registered once per process
  // rather than in runCli: `bitig mcp` keeps writing to stdout after runCli resolves.
  process.stdout.on("error", (err: unknown) => {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPIPE") {
      process.exit(EXIT_OK);
    }
  });

  runCli().then((code) => {
    if (code !== EXIT_OK) process.exit(code);
  }).catch(() => {
    process.exit(EXIT_FAILURE);
  });
}
