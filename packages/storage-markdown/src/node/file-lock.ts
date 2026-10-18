/**
 * Advisory file lock for cross-process synchronization.
 *
 * Implements O_EXCL file creation with stale PID detection and timeout.
 */
import { StorageError, throwIfAborted } from "@bitig/core";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LockOptions, LockPort } from "../lock/port";

export const DEFAULT_LOCK_TIMEOUT_MS = 5000;
export const LOCK_POLL_INTERVAL_MS = 50;

export interface FileLockOptions {
  /** Absolute path to the primary lock file (e.g. in XDG_RUNTIME_DIR). */
  readonly lockPath: string;
  /** Fallback lock file (e.g. in dataDir) if primary directory cannot be created. */
  readonly fallbackLockPath?: string | undefined;
  readonly timeoutMs?: number | undefined;
}

interface LockPayload {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class FileLock implements LockPort {
  readonly #lockPath: string;
  readonly #fallbackLockPath: string | undefined;
  readonly #timeoutMs: number;
  #activeLockPath: string;

  constructor(opts: FileLockOptions) {
    this.#lockPath = path.resolve(opts.lockPath);
    this.#fallbackLockPath = opts.fallbackLockPath !== undefined ? path.resolve(opts.fallbackLockPath) : undefined;
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#activeLockPath = this.#lockPath;
  }

  get lockPath(): string {
    return this.#activeLockPath;
  }

  async withLock<T>(operation: () => Promise<T> | T, opts?: LockOptions): Promise<T> {
    throwIfAborted(opts?.signal);
    await this.#acquire(opts);
    try {
      return await operation();
    } finally {
      await this.#release();
    }
  }

  async #acquire(opts?: LockOptions): Promise<void> {
    const startTime = Date.now();
    this.#activeLockPath = this.#lockPath;
    let lockDir = path.dirname(this.#activeLockPath);

    try {
      await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    } catch {
      if (this.#fallbackLockPath !== undefined) {
        this.#activeLockPath = this.#fallbackLockPath;
        lockDir = path.dirname(this.#activeLockPath);
        await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
      }
    }

    const payload: LockPayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    const content = JSON.stringify(payload);

    while (Date.now() - startTime < this.#timeoutMs) {
      throwIfAborted(opts?.signal);
      try {
        const handle = await fs.open(this.#activeLockPath, "wx", 0o600);
        try {
          await handle.writeFile(content, { encoding: "utf8" });
        } finally {
          await handle.close();
        }
        return; // Lock acquired
      } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "EEXIST") {
          // Lock exists, check if stale
          const isStale = await this.#checkIfStale();
          if (isStale) {
            try {
              await fs.unlink(this.#activeLockPath);
            } catch {
              // Ignore unlink error if someone else cleaned it up
            }
            continue; // Retry immediately
          }
          // Wait and retry
          await sleep(LOCK_POLL_INTERVAL_MS);
          continue;
        }
        throw new StorageError("lock", `Failed to create lock file: ${err instanceof Error ? err.message : String(err)}`, {
          location: this.#activeLockPath,
          cause: err,
        });
      }
    }

    // Timeout exceeded
    let holderInfo = "unknown holder";
    try {
      const raw = await fs.readFile(this.#activeLockPath, "utf8");
      const parsed = JSON.parse(raw) as LockPayload;
      holderInfo = `held by PID ${String(parsed.pid)} on ${parsed.hostname} since ${parsed.acquiredAt}`;
    } catch {
      // ignore
    }

    throw new StorageError("lock", `Lock acquisition timed out after ${String(this.#timeoutMs)}ms (${holderInfo})`, {
      location: this.#activeLockPath,
    });
  }

  async #checkIfStale(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.#activeLockPath, "utf8");
      const parsed = JSON.parse(raw) as LockPayload;
      if (parsed.hostname !== os.hostname()) {
        return false; // Cannot verify remote host PID
      }
      try {
        process.kill(parsed.pid, 0);
        return false; // Process is still alive
      } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "code" in err && err.code === "ESRCH") {
          return true; // No such process -> stale!
        }
        return false;
      }
    } catch {
      return false;
    }
  }

  async #release(): Promise<void> {
    try {
      const raw = await fs.readFile(this.#activeLockPath, "utf8");
      const parsed = JSON.parse(raw) as LockPayload;
      if (parsed.pid === process.pid && parsed.hostname === os.hostname()) {
        await fs.unlink(this.#activeLockPath);
      }
    } catch {
      // Ignore if already deleted
    }
  }
}
