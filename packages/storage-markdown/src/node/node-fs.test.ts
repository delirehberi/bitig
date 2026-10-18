import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeFileSystem } from "./node-fs";

describe("NodeFileSystem", () => {
  let tempDir: string;
  let nodeFs: NodeFileSystem;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-fs-test-"));
    nodeFs = new NodeFileSystem({ rootDir: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads and writes atomic files with mode 0600", async () => {
    await nodeFs.writeTextAtomic("test.txt", "hello world");
    const content = await nodeFs.readText("test.txt");
    expect(content).toBe("hello world");

    const stat = await fs.stat(path.join(tempDir, "test.txt"));
    // On Unix, mode & 0o777 gives file permissions
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns null on missing file", async () => {
    const content = await nodeFs.readText("missing.txt");
    expect(content).toBeNull();
  });

  it("creates directory and lists entries", async () => {
    await nodeFs.makeDir("sub");
    await nodeFs.writeTextAtomic("sub/item.txt", "content");

    const entries = await nodeFs.listDir("sub");
    expect(entries).toEqual([{ name: "item.txt", kind: "file" }]);

    const rootEntries = await nodeFs.listDir("");
    expect(rootEntries).toEqual([{ name: "sub", kind: "directory" }]);
  });

  it("rejects path traversal", async () => {
    await expect(nodeFs.readText("../outside.txt")).rejects.toThrow(/traversal/i);
    await expect(nodeFs.writeTextAtomic("../outside.txt", "evil")).rejects.toThrow(/traversal/i);
  });

  it("removes files and directories", async () => {
    await nodeFs.makeDir("to-del");
    await nodeFs.writeTextAtomic("to-del/file.txt", "x");
    expect(await nodeFs.fileExists("to-del/file.txt")).toBe(true);

    await nodeFs.removeFile("to-del/file.txt");
    expect(await nodeFs.fileExists("to-del/file.txt")).toBe(false);

    await nodeFs.removeDir("to-del");
    expect(await nodeFs.listDir("to-del")).toBeNull();
  });

  it("rejects symbolic links on read", async () => {
    const realFile = path.join(tempDir, "real.txt");
    const linkFile = path.join(tempDir, "link.txt");
    await fs.writeFile(realFile, "secret");
    await fs.symlink(realFile, linkFile);

    await expect(nodeFs.readText("link.txt")).rejects.toThrow(/symbolic link/i);
  });
});

