/**
 * Node.js filesystem implementation of FileSystemPort.
 *
 * Enforces:
 * - Root path containment check (no directory traversal).
 * - Directory mode 0700, file mode 0600.
 * - Atomic write via temporary sibling file + rename.
 * - Max read bytes guard.
 * - Handling and conversion of Node IO errors to StorageError.
 */
import { StorageError, throwIfAborted } from "@bitig/core";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  MAX_READ_BYTES,
  type DirEntry,
  type DirEntryKind,
  type FileSystemPort,
  type FsOptions,
} from "../fs/port";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface NodeFileSystemOptions {
  /** Absolute path to the data directory. */
  readonly rootDir: string;
}

export class NodeFileSystem implements FileSystemPort {
  readonly #rootDir: string;

  constructor(opts: NodeFileSystemOptions) {
    this.#rootDir = path.resolve(opts.rootDir);
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  #resolvePath(relPath: string): string {
    const normalized = path.normalize(relPath);
    if (path.isAbsolute(normalized) || normalized.startsWith("..") || normalized === "..") {
      throw new StorageError("io", "Path traversal or absolute path rejected", { location: relPath });
    }
    const resolved = path.resolve(this.#rootDir, normalized);
    if (resolved !== this.#rootDir && !resolved.startsWith(this.#rootDir + path.sep)) {
      throw new StorageError("io", "Path escapes root directory", { location: relPath });
    }
    return resolved;
  }

  async readText(relPath: string, opts?: FsOptions): Promise<string | null> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    try {
      const stat = await fs.lstat(target);
      if (stat.isSymbolicLink()) {
        throw new StorageError("corrupt", "Symbolic link encountered", { location: relPath });
      }
      if (!stat.isFile()) {
        throw new StorageError("io", "Target is not a regular file", { location: relPath });
      }
      if (stat.size > MAX_READ_BYTES) {
        throw new StorageError("corrupt", `File exceeds max size (${String(MAX_READ_BYTES)} bytes)`, { location: relPath });
      }
      throwIfAborted(opts?.signal);
      return await fs.readFile(target, { encoding: "utf8" });
    } catch (err: unknown) {
      if (err instanceof StorageError) throw err;
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
        return null;
      }
      throw new StorageError("io", `Failed to read file: ${err instanceof Error ? err.message : String(err)}`, {
        location: relPath,
        cause: err,
      });
    }
  }

  async writeTextAtomic(relPath: string, content: string, opts?: FsOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    const dir = path.dirname(target);
    const tmpName = `.tmp-${randomBytes(8).toString("hex")}`;
    const tmpPath = path.join(dir, tmpName);

    try {
      // Ensure parent directory exists
      await fs.mkdir(dir, { recursive: true, mode: DIR_MODE });
      throwIfAborted(opts?.signal);

      // Write temp file with private mode
      await fs.writeFile(tmpPath, content, { encoding: "utf8", mode: FILE_MODE });
      throwIfAborted(opts?.signal);

      // Atomic rename
      await fs.rename(tmpPath, target);
    } catch (err: unknown) {
      // Clean up tmp file on failure if possible
      try {
        await fs.unlink(tmpPath);
      } catch {
        // ignore cleanup error
      }
      if (err instanceof StorageError) throw err;
      throw new StorageError("io", `Failed to write file atomically: ${err instanceof Error ? err.message : String(err)}`, {
        location: relPath,
        cause: err,
      });
    }
  }

  async listDir(relPath: string, opts?: FsOptions): Promise<DirEntry[] | null> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    try {
      const entries = await fs.readdir(target, { withFileTypes: true });
      const result: DirEntry[] = [];
      for (const entry of entries) {
        let kind: DirEntryKind = "other";
        if (entry.isFile()) kind = "file";
        else if (entry.isDirectory()) kind = "directory";
        result.push({ name: entry.name, kind });
      }
      return result;
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
        return null;
      }
      throw new StorageError("io", `Failed to list directory: ${err instanceof Error ? err.message : String(err)}`, {
        location: relPath,
        cause: err,
      });
    }
  }

  async makeDir(relPath: string, opts?: FsOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    try {
      await fs.mkdir(target, { mode: DIR_MODE });
    } catch (err: unknown) {
      throw new StorageError("io", `Failed to create directory: ${err instanceof Error ? err.message : String(err)}`, {
        location: relPath,
        cause: err,
      });
    }
  }

  async removeFile(relPath: string, opts?: FsOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    try {
      await fs.unlink(target);
    } catch (err: unknown) {
      if (typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT") {
        return;
      }
      throw new StorageError("io", `Failed to remove file: ${err instanceof Error ? err.message : String(err)}`, {
        location: relPath,
        cause: err,
      });
    }
  }

  async removeDir(relPath: string, opts?: FsOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    try {
      await fs.rm(target, { recursive: true, force: true });
    } catch (err: unknown) {
      throw new StorageError("io", `Failed to remove directory: ${err instanceof Error ? err.message : String(err)}`, {
        location: relPath,
        cause: err,
      });
    }
  }

  async fileExists(relPath: string, opts?: FsOptions): Promise<boolean> {
    throwIfAborted(opts?.signal);
    const target = this.#resolvePath(relPath);
    try {
      const stat = await fs.lstat(target);
      return stat.isFile();
    } catch {
      return false;
    }
  }
}

