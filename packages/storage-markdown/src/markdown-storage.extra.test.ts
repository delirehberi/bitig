import { StorageError } from "@bitig/core";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarkdownStorage } from "./markdown-storage";
import { NodeFileSystem } from "./node/node-fs";

describe("MarkdownStorage extra tests", () => {
  let tempDir: string;
  let storage: MarkdownStorage;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-md-extra-"));
    const nodeFs = new NodeFileSystem({ rootDir: tempDir });
    storage = new MarkdownStorage({ fs: nodeFs });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("picks up manual edits to files", async () => {
    const proj = await storage.createProject({ name: "Original" });
    const task = await storage.saveTask({ projectId: proj.id, title: "Original Title" });

    // Manually edit the task markdown file
    const taskFile = path.join(tempDir, proj.id, `${task.id}.md`);
    const content = await fs.readFile(taskFile, "utf8");
    const edited = content.replace("title: Original Title", "title: Manually Edited Title");
    await fs.writeFile(taskFile, edited, "utf8");

    const fetched = await storage.getTask(task.id);
    expect(fetched?.title).toBe("Manually Edited Title");
  });

  it("ignores non-UUIDv7 directories and non-markdown files", async () => {
    const proj = await storage.createProject({ name: "Valid" });
    await storage.saveTask({ projectId: proj.id, title: "Task 1" });

    // Create dotfiles, random notes, non-UUID dirs
    await fs.writeFile(path.join(tempDir, ".hidden"), "secret");
    await fs.writeFile(path.join(tempDir, "notes.txt"), "hello");
    await fs.mkdir(path.join(tempDir, "random-dir"));
    await fs.writeFile(path.join(tempDir, proj.id, "junk.txt"), "junk");

    const projects = await storage.getProjects();
    expect(projects).toHaveLength(1);
    expect(projects[0]?.id).toBe(proj.id);

    const tasks = await storage.getTasks();
    expect(tasks).toHaveLength(1);
  });

  it("throws StorageError on corrupt files", async () => {
    const proj = await storage.createProject({ name: "Valid" });
    const task = await storage.saveTask({ projectId: proj.id, title: "Task 1" });

    const taskFile = path.join(tempDir, proj.id, `${task.id}.md`);
    await fs.writeFile(taskFile, "not valid yaml frontmatter", "utf8");

    await expect(storage.getTask(task.id)).rejects.toThrow(StorageError);
  });

  it("detects and throws on duplicate task IDs in different projects", async () => {
    const proj1 = await storage.createProject({ name: "Project 1" });
    const proj2 = await storage.createProject({ name: "Project 2" });
    const task = await storage.saveTask({ projectId: proj1.id, title: "Task 1" });

    // Manually copy the task file to proj2
    const taskFile1 = path.join(tempDir, proj1.id, `${task.id}.md`);
    const taskFile2 = path.join(tempDir, proj2.id, `${task.id}.md`);
    await fs.copyFile(taskFile1, taskFile2);

    await expect(storage.getTask(task.id)).rejects.toThrow(/Duplicate task ID/);
    await expect(storage.getTasks()).rejects.toThrow(/Duplicate task ID/);
  });

  it("stores each comment as a Markdown file next to its task and moves them with it", async () => {
    const proj = await storage.createProject({ name: "Project" });
    const other = await storage.createProject({ name: "Other" });
    const task = await storage.saveTask({ projectId: proj.id, title: "Task" });
    const comment = await storage.addComment({
      taskId: task.id,
      body: "Use the staging key.",
      authorType: "agent",
      author: "claude",
    });

    const commentFile = path.join(tempDir, proj.id, `${task.id}.comments`, `${comment.id}.md`);
    expect(await fs.readFile(commentFile, "utf8")).toBe(
      `---\nauthorType: agent\nauthor: claude\ncreatedAt: "${comment.createdAt}"\n---\nUse the staging key.\n`,
    );
    expect((await storage.getTasks()).map((t) => t.id)).toEqual([task.id]);

    await storage.updateTask(task.id, { projectId: other.id });
    await expect(fs.stat(path.join(tempDir, proj.id, `${task.id}.comments`))).rejects.toThrow();
    expect(await storage.getComments(task.id)).toEqual([comment]);
  });
});
