import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MarkdownStorage } from "@bitig/storage-markdown";
import { NodeFileSystem } from "@bitig/storage-markdown/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main";

describe("CLI main commands", () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-cli-test-"));
    dataDir = path.join(tempDir, "data");
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const exec = async (args: string[]) => {
    const fullArgs = ["node", "bitig", "--data-dir", dataDir, ...args];
    return runCli(fullArgs);
  };

  it("prints paths with --data-dir flag override", async () => {
    const code = await exec(["paths", "--json"]);
    expect(code).toBe(0);
  });

  it("runs project creation, listing and task lifecycle", async () => {
    // 1. Create project
    let code = await exec(["projects", "create", "Work Project", "-k", "paid"]);
    expect(code).toBe(0);

    // 2. List projects
    code = await exec(["projects", "list"]);
    expect(code).toBe(0);

    // 3. Find created project ID from dataDir
    const entries = await fs.readdir(dataDir);
    const projectId = entries.find((e) => !e.startsWith("."));
    expect(projectId).toBeDefined();
    if (projectId === undefined) throw new Error("Expected project ID");

    // 4. Add task to project
    code = await exec(["tasks", "add", "Important Task", "-p", projectId, "--priority", "urgent"]);
    expect(code).toBe(0);

    // 5. List tasks
    code = await exec(["tasks", "list", "-p", projectId]);
    expect(code).toBe(0);

    // 6. Find task ID
    const taskFiles = await fs.readdir(path.join(dataDir, projectId));
    const taskFile = taskFiles.find((f) => f.endsWith(".md"));
    expect(taskFile).toBeDefined();
    if (taskFile === undefined) throw new Error("Expected task file");
    const taskId = taskFile.replace(".md", "");

    // 7. Build and edit a checklist
    for (const args of [
      ["tasks", "item", "add", taskId, "Write"],
      ["tasks", "item", "add", taskId, "Review"],
      ["tasks", "item", "add", taskId, "Ship"],
      ["tasks", "item", "check", taskId, "1"],
      ["tasks", "item", "rename", taskId, "2", "Review twice"],
      ["tasks", "item", "move", taskId, "3", "1"],
      ["tasks", "item", "remove", taskId, "3"],
    ]) {
      expect(await exec(args)).toBe(0);
    }
    const taskText = await fs.readFile(path.join(dataDir, projectId, taskFile), "utf8");
    expect(taskText).toContain("checklist:");
    const reader = new MarkdownStorage({ fs: new NodeFileSystem({ rootDir: dataDir }) });
    expect((await reader.getTask(taskId))?.checklist).toEqual([
      { text: "Ship", done: false },
      { text: "Write", done: true },
    ]);
    // A position past the end fails without changing anything
    expect(await exec(["tasks", "item", "check", taskId, "9"])).not.toBe(0);

    // 8. Complete task
    code = await exec(["tasks", "done", taskId]);
    expect(code).toBe(0);

    // 9. Delete task
    code = await exec(["tasks", "delete", taskId]);
    expect(code).toBe(0);

    // 10. Delete project
    code = await exec(["projects", "delete", projectId]);
    expect(code).toBe(0);
  });

  describe("explicit data directory that does not exist", () => {
    let missingDir: string;
    let stderr: string[];

    beforeEach(() => {
      missingDir = path.join(tempDir, "missing", "data");
      stderr = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        stderr.push(args.map(String).join(" "));
      });
      vi.spyOn(console, "log").mockImplementation(() => undefined);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    const execIn = (dir: string, args: string[]) => runCli(["node", "bitig", "--data-dir", dir, ...args]);

    it("fails read commands with a hint and does not create the directory", async () => {
      expect(await execIn(missingDir, ["projects", "list"])).toBe(1);

      const message = stderr.join("\n");
      expect(message).toContain(`Data directory does not exist: ${missingDir}`);
      expect(message).toContain("bitig init");
      await expect(fs.stat(missingDir)).rejects.toThrow();
    });

    it("is created by init, which then links the workspace", async () => {
      const workspace = path.join(tempDir, "workspace");
      await fs.mkdir(workspace);
      // init writes ./.bitig; point the working directory at a temp workspace.
      vi.spyOn(process, "cwd").mockReturnValue(workspace);

      expect(await execIn(missingDir, ["init", "--name", "Fresh Start"])).toBe(0);

      expect((await fs.stat(missingDir)).isDirectory()).toBe(true);
      expect((await fs.readdir(missingDir)).filter((e) => !e.startsWith("."))).toHaveLength(1);
      await expect(fs.stat(path.join(workspace, ".bitig"))).resolves.toBeDefined();
      expect(stderr).toContain(`Created data directory: ${missingDir}`);
    });

    it("still rejects a path that is a file", async () => {
      const filePath = path.join(tempDir, "not-a-dir");
      await fs.writeFile(filePath, "", "utf8");
      const workspace = path.join(tempDir, "workspace");
      await fs.mkdir(workspace);
      vi.spyOn(process, "cwd").mockReturnValue(workspace);

      expect(await execIn(filePath, ["init", "--name", "Nope"])).toBe(1);

      expect(stderr.join("\n")).toContain(`Data directory path is not a directory: ${filePath}`);
    });
  });
});
