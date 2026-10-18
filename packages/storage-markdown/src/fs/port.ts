/**
 * Minimal filesystem surface `MarkdownStorage` depends on. Runtime-neutral:
 * the Node implementation lives in `@bitig/storage-markdown/node`, and a File
 * System Access API implementation can implement the same port for browsers.
 *
 * Paths are relative to the data directory, `/`-separated, and `""` denotes
 * the data directory itself. Implementations must:
 * - refuse paths that escape the data directory;
 * - never follow symbolic links (reject them with `StorageError` reason `corrupt`);
 * - report failures other than the documented "missing" results as
 *   `StorageError` with reason `io` and the relative path as `location`;
 * - honour an already-aborted `signal` by rejecting with its reason before
 *   touching the filesystem.
 */
import type { AbortSignalLike } from "@bitig/core";

export interface FsOptions {
  readonly signal?: AbortSignalLike | undefined;
}

export type DirEntryKind = "file" | "directory" | "other";

export interface DirEntry {
  readonly name: string;
  /** Symbolic links are reported as `other` and never followed. */
  readonly kind: DirEntryKind;
}

/** Files larger than this are refused before being read into memory. */
export const MAX_READ_BYTES = 4 * 1024 * 1024;

export interface FileSystemPort {
  /** UTF-8 contents, or `null` if the file does not exist. */
  readText(path: string, opts?: FsOptions): Promise<string | null>;
  /** Writes via a temporary sibling file and rename, so readers never see partial content. */
  writeTextAtomic(path: string, content: string, opts?: FsOptions): Promise<void>;
  /** Directory entries in unspecified order, or `null` if the directory does not exist. */
  listDir(path: string, opts?: FsOptions): Promise<DirEntry[] | null>;
  /** Creates one directory; the parent must exist. */
  makeDir(path: string, opts?: FsOptions): Promise<void>;
  removeFile(path: string, opts?: FsOptions): Promise<void>;
  /** Removes a directory and everything below it. */
  removeDir(path: string, opts?: FsOptions): Promise<void>;
  /** Whether a regular file exists at `path`. */
  fileExists(path: string, opts?: FsOptions): Promise<boolean>;
}

