/**
 * In-memory async mutex implementing LockPort.
 */
import { throwIfAborted } from "@bitig/core";
import type { LockOptions, LockPort } from "./port";

export class AsyncMutex implements LockPort {
  #queue: Promise<void> = Promise.resolve();

  async withLock<T>(operation: () => Promise<T> | T, opts?: LockOptions): Promise<T> {
    throwIfAborted(opts?.signal);

    let releaseLock!: () => void;
    const lockAcquired = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const previousLock = this.#queue;
    this.#queue = this.#queue.then(() => lockAcquired);

    await previousLock;
    throwIfAborted(opts?.signal);

    try {
      return await operation();
    } finally {
      releaseLock();
    }
  }
}
