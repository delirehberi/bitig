import type { Clock, IdGenerator, RuntimeDeps } from "../runtime/ids";

export const TEST_EPOCH = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
const DEFAULT_TICK_MS = 1_000;
const ID_COUNTER_HEX_WIDTH = 12;

export interface TestClock {
  readonly clock: Clock;
  /** Moves time forward (or backward, with a negative value) without a read. */
  advance(ms: number): void;
}

/**
 * A clock that advances by `tickMs` after every read, so successive
 * operations get strictly increasing timestamps without real waiting.
 */
export function createTestClock(start: Date = TEST_EPOCH, tickMs = DEFAULT_TICK_MS): TestClock {
  let current = start.getTime();
  return {
    clock: () => {
      const reading = new Date(current);
      current += tickMs;
      return reading;
    },
    advance: (ms) => {
      current += ms;
    },
  };
}

/** Deterministic, lexicographically increasing UUIDv7-shaped IDs. */
export function createSequentialIdGenerator(): IdGenerator {
  let counter = 0;
  return () => {
    counter += 1;
    return `01940000-0000-7000-8000-${counter.toString(16).padStart(ID_COUNTER_HEX_WIDTH, "0")}`;
  };
}

export interface TestRuntime extends RuntimeDeps {
  readonly testClock: TestClock;
}

export function createTestRuntime(): TestRuntime {
  const testClock = createTestClock();
  return { clock: testClock.clock, generateId: createSequentialIdGenerator(), testClock };
}

