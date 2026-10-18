import { describe, expect, it } from "vitest";
import { AsyncMutex } from "./mutex";

describe("AsyncMutex", () => {
  it("serializes concurrent operations", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const p1 = mutex.withLock(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(1);
    });

    const p2 = mutex.withLock(() => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });
});
