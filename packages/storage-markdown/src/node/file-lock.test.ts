import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileLock } from "./file-lock";

describe("FileLock", () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-lock-test-"));
    lockPath = path.join(tempDir, "test.lock");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("acquires and releases the lock", async () => {
    const lock = new FileLock({ lockPath, timeoutMs: 1000 });
    let inside = false;
    await lock.withLock(async () => {
      inside = true;
      const exists = await fs.stat(lockPath).then(() => true).catch(() => false);
      expect(exists).toBe(true);
    });
    expect(inside).toBe(true);
    const existsAfter = await fs.stat(lockPath).then(() => true).catch(() => false);
    expect(existsAfter).toBe(false);
  });

  it("recovers from stale lock with dead PID", async () => {
    // Write a lock file with PID 9999999 (presumably dead)
    const deadPayload = {
      pid: 9999999,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(deadPayload), "utf8");

    const lock = new FileLock({ lockPath, timeoutMs: 1000 });
    let ran = false;
    await lock.withLock(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("times out if lock is held by live process", async () => {
    // Current process PID is definitely alive
    const livePayload = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockPath, JSON.stringify(livePayload), "utf8");

    const lock = new FileLock({ lockPath, timeoutMs: 200 });
    await expect(lock.withLock(() => "blocked")).rejects.toThrow(/timed out/i);
  });
});
