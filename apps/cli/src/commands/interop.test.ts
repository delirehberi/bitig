import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../main";
import type { BackupBundle, ProjectBundle } from "@bitig/core";

describe("CLI Interop Commands (export, import, backup, restore)", () => {
  let tempDir: string;
  let dataDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-cli-interop-test-"));
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

  it("exports a project to a JSON file and imports it back", async () => {
    // 1. Create project
    let code = await exec(["projects", "create", "Interop Alpha", "-k", "open_source", "-d", "Test alpha"]);
    expect(code).toBe(0);

    const entries = await fs.readdir(dataDir);
    const projectId = entries.find((e) => !e.startsWith("."));
    expect(projectId).toBeDefined();
    if (!projectId) throw new Error("Missing project ID");

    // 2. Add task
    code = await exec(["tasks", "add", "Task Alpha 1", "-p", projectId, "--priority", "urgent"]);
    expect(code).toBe(0);

    // 3. Export project
    const exportFile = path.join(tempDir, "export-alpha.json");
    code = await exec(["export", projectId, "--file", exportFile]);
    expect(code).toBe(0);

    const exportContent = await fs.readFile(exportFile, "utf8");
    const bundle = JSON.parse(exportContent) as ProjectBundle;
    expect(bundle.version).toBe(1);
    expect(bundle.project.name).toBe("Interop Alpha");
    expect(bundle.tasks.length).toBe(1);
    expect(bundle.tasks[0]?.title).toBe("Task Alpha 1");

    // 4. Delete project directory to simulate empty storage
    await fs.rm(path.join(dataDir, projectId), { recursive: true, force: true });

    // 5. Import project bundle
    code = await exec(["import", exportFile]);
    expect(code).toBe(0);

    // 6. Verify restored project
    const reloaded = await fs.readdir(dataDir);
    expect(reloaded).toContain(projectId);
    const reloadedTasks = await fs.readdir(path.join(dataDir, projectId));
    expect(reloadedTasks.some((f) => f.endsWith(".md"))).toBe(true);
  });

  it("creates a full backup and restores it into fresh storage", async () => {
    // 1. Create two projects with tasks
    let code = await exec(["projects", "create", "Project 1", "-k", "hobby"]);
    expect(code).toBe(0);
    code = await exec(["projects", "create", "Project 2", "-k", "personal"]);
    expect(code).toBe(0);

    const entries = await fs.readdir(dataDir);
    const projectIds = entries.filter((e) => !e.startsWith("."));
    expect(projectIds.length).toBe(2);

    const firstProjectId = projectIds[0];
    const secondProjectId = projectIds[1];
    if (!firstProjectId || !secondProjectId) {
      throw new Error("Missing project IDs");
    }

    code = await exec(["tasks", "add", "Task 1", "-p", firstProjectId]);
    expect(code).toBe(0);
    code = await exec(["tasks", "add", "Task 2", "-p", secondProjectId]);
    expect(code).toBe(0);

    // 2. Backup
    const backupFile = path.join(tempDir, "backup-all.json");
    code = await exec(["backup", "--file", backupFile]);
    expect(code).toBe(0);

    const backupContent = await fs.readFile(backupFile, "utf8");
    const backup = JSON.parse(backupContent) as BackupBundle;
    expect(backup.version).toBe(1);
    expect(backup.bundles.length).toBe(2);

    // 3. Clear storage directory
    for (const pId of projectIds) {
      await fs.rm(path.join(dataDir, pId), { recursive: true, force: true });
    }

    // 4. Restore backup
    code = await exec(["restore", backupFile]);
    expect(code).toBe(0);

    // 5. Verify restored
    const restoredProjects = await fs.readdir(dataDir);
    expect(restoredProjects.filter((e) => !e.startsWith(".")).length).toBe(2);
  });

  describe("into a data directory that does not exist yet", () => {
    const OWNER_ONLY_MODE = 0o700;
    const PERMISSION_BITS = 0o777;

    let newDataDir: string;
    let stderr: string[];

    beforeEach(() => {
      newDataDir = path.join(tempDir, "fresh", "nested", "data");
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

    async function writeExport(): Promise<{ file: string; projectId: string }> {
      expect(await exec(["projects", "create", "Seed Project"])).toBe(0);
      const projectId = (await fs.readdir(dataDir)).find((e) => !e.startsWith("."));
      if (!projectId) throw new Error("Missing project ID");
      expect(await exec(["tasks", "add", "Seed Task", "-p", projectId])).toBe(0);
      const file = path.join(tempDir, "seed-export.json");
      expect(await exec(["export", projectId, "--file", file])).toBe(0);
      return { file, projectId };
    }

    it("import creates the directory with owner-only permissions and reports it", async () => {
      const { file, projectId } = await writeExport();

      expect(await execIn(newDataDir, ["import", file])).toBe(0);

      const stat = await fs.stat(newDataDir);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.mode & PERMISSION_BITS).toBe(OWNER_ONLY_MODE);
      expect(await fs.readdir(newDataDir)).toContain(projectId);
      expect(stderr).toContain(`Created data directory: ${newDataDir}`);
    });

    it("restore creates the directory", async () => {
      await writeExport();
      const backupFile = path.join(tempDir, "seed-backup.json");
      expect(await exec(["backup", "--file", backupFile])).toBe(0);

      expect(await execIn(newDataDir, ["restore", backupFile])).toBe(0);

      const restored = (await fs.readdir(newDataDir)).filter((e) => !e.startsWith("."));
      expect(restored).toHaveLength(1);
    });

    it("does not report the new directory with --quiet", async () => {
      const { file } = await writeExport();

      expect(await runCli(["node", "bitig", "--quiet", "--data-dir", newDataDir, "import", file])).toBe(0);

      expect((await fs.stat(newDataDir)).isDirectory()).toBe(true);
      expect(stderr.some((line) => line.startsWith("Created data directory"))).toBe(false);
    });

    it("does not create the directory when the import file is invalid", async () => {
      const badFile = path.join(tempDir, "bad.json");
      await fs.writeFile(badFile, "{ not json", "utf8");

      expect(await execIn(newDataDir, ["import", badFile])).toBe(1);

      await expect(fs.stat(newDataDir)).rejects.toThrow();
    });
  });
});
