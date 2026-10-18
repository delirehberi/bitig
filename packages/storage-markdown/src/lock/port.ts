/**
 * Concurrency port for storage mutations.
 */
import type { AbortSignalLike } from "@bitig/core";

export interface LockOptions {
  readonly signal?: AbortSignalLike | undefined;
}

export interface LockPort {
  /**
   * Executes `operation` exclusively while holding the lock.
   * Releases the lock when done (or on error).
   */
  withLock<T>(operation: () => Promise<T> | T, opts?: LockOptions): Promise<T>;
}
