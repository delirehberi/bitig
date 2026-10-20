/**
 * Shared contract suite for `StorageProvider` adapters.
 *
 * Usage from an adapter package:
 *
 *   runStorageContractSuite("D1Storage", async (runtime) => {
 *     const storage = new D1Storage(db, runtime);
 *     return { storage, dispose: () => resetDb(db) };
 *   });
 *
 * Adapters must pass the supplied `runtime` (clock + ID generator) through so
 * timestamps and ordering are deterministic.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../domain/errors";
import { CommentSchema, ProjectSchema, TaskSchema } from "../domain/schemas";
import type { Project, Task } from "../domain/types";
import { PROJECT_KINDS } from "../domain/constants";
import type { AbortSignalLike } from "../storage/abort";
import type { StorageProvider } from "../storage/provider";
import { createTestRuntime, type TestRuntime } from "./fixtures";

export {
  TEST_EPOCH,
  createSequentialIdGenerator,
  createTestClock,
  createTestRuntime,
} from "./fixtures";
export type { TestClock, TestRuntime } from "./fixtures";

export interface StorageHarness {
  readonly storage: StorageProvider;
  /** Releases resources (connections, temp dirs, relays) after each test. */
  readonly dispose?: () => Promise<void> | void;
}

export type StorageFactory = (runtime: TestRuntime) => Promise<StorageHarness> | StorageHarness;

/** A valid UUIDv7 that no sequential test ID generator will ever produce. */
const UNKNOWN_ID = "01940000-0000-7000-8fff-ffffffffffff";
const MALFORMED_ID = "../not-an-id";

class ContractAbortReason extends Error {
  constructor() {
    super("aborted by contract suite");
    this.name = "AbortError";
  }
}

/** An already-aborted signal; `core` has no DOM types, so it is built by hand. */
function abortedSignal(): { signal: AbortSignalLike; reason: ContractAbortReason } {
  const reason = new ContractAbortReason();
  return {
    reason,
    signal: {
      aborted: true,
      reason,
      throwIfAborted: () => {
        throw reason;
      },
    },
  };
}

export function runStorageContractSuite(name: string, factory: StorageFactory): void {
  describe(`StorageProvider contract: ${name}`, () => {
    let harness: StorageHarness;
    let storage: StorageProvider;
    let runtime: TestRuntime;

    beforeEach(async () => {
      runtime = createTestRuntime();
      harness = await factory(runtime);
      storage = harness.storage;
    });

    afterEach(async () => {
      await harness.dispose?.();
    });

    async function createProject(projectName = "Project"): Promise<Project> {
      return storage.createProject({ name: projectName });
    }

    describe("projects", () => {
      it("starts empty", async () => {
        expect(await storage.getProjects()).toEqual([]);
        expect(await storage.getProject(UNKNOWN_ID)).toBeNull();
      });

      it("creates a project with defaults and reads it back", async () => {
        const project = await storage.createProject({ name: "  Bitig  " });
        expect(project).toMatchObject({ name: "Bitig", description: "", kind: "hobby" });
        expect(project.createdAt).toBe(project.updatedAt);
        expect(ProjectSchema.parse(project)).toEqual(project);
        expect(await storage.getProject(project.id)).toEqual(project);
        expect(await storage.getProjects()).toEqual([project]);
      });

      it.each(PROJECT_KINDS)("round-trips kind %s", async (kind) => {
        const project = await storage.createProject({ name: "p", kind });
        expect((await storage.getProject(project.id))?.kind).toBe(kind);
      });

      it("lists projects oldest first", async () => {
        const first = await createProject("first");
        const second = await createProject("second");
        expect((await storage.getProjects()).map((p) => p.id)).toEqual([first.id, second.id]);
      });

      it("updates fields, bumps updatedAt and keeps createdAt", async () => {
        const project = await createProject();
        const updated = await storage.updateProject(project.id, {
          name: "Renamed",
          description: "About",
          kind: "paid",
        });
        expect(updated).toMatchObject({
          id: project.id,
          name: "Renamed",
          description: "About",
          kind: "paid",
          createdAt: project.createdAt,
        });
        expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(project.updatedAt));
        expect(await storage.getProject(project.id)).toEqual(updated);
      });

      it("rejects invalid project input", async () => {
        const project = await createProject();
        await expect(storage.createProject({ name: "" })).rejects.toBeInstanceOf(ValidationError);
        await expect(
          storage.createProject({ name: "p", kind: "commercial" } as never),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.updateProject(project.id, {})).rejects.toBeInstanceOf(ValidationError);
        await expect(
          storage.updateProject(project.id, { kind: null } as never),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await storage.getProjects()).toEqual([project]);
      });

      it("creates a project without resources by default", async () => {
        const project = await createProject();
        expect(project).not.toHaveProperty("resources");
      });

      it("round-trips resources in order", async () => {
        const resources = [
          { type: "repository", label: "GitHub", url: "https://github.com/acme/bitig" },
          { type: "issue_tracker", label: "Jira", url: "https://acme.atlassian.net/browse/BIT" },
          { type: "design", label: "Figma", url: "https://www.figma.com/design/abc/Bitig?node-id=1-2" },
        ] as const;
        const project = await storage.createProject({ name: "p", resources: [...resources] });
        expect(project.resources).toEqual(resources);
        expect(await storage.getProject(project.id)).toEqual(project);
        expect(await storage.getProjects()).toEqual([project]);
      });

      it("edits resources as a whole and clears them with null or []", async () => {
        const project = await storage.createProject({
          name: "p",
          resources: [{ type: "other", label: "Wiki", url: "https://wiki.example.com" }],
        });

        const edited = await storage.updateProject(project.id, {
          resources: [
            { type: "documentation", label: "Docs", url: "https://docs.example.com" },
            { type: "other", label: "Wiki (old)", url: "https://wiki.example.com" },
          ],
        });
        expect(edited.resources?.map((r) => r.label)).toEqual(["Docs", "Wiki (old)"]);
        expect(await storage.getProject(project.id)).toEqual(edited);

        const renamed = await storage.updateProject(project.id, { name: "Renamed" });
        expect(renamed.resources).toEqual(edited.resources);

        const emptied = await storage.updateProject(project.id, { resources: [] });
        expect(emptied).not.toHaveProperty("resources");
        expect(await storage.getProject(project.id)).toEqual(emptied);

        await storage.updateProject(project.id, {
          resources: [{ type: "other", label: "x", url: "https://x.example.com" }],
        });
        const cleared = await storage.updateProject(project.id, { resources: null });
        expect(cleared).not.toHaveProperty("resources");
        expect(await storage.getProject(project.id)).toEqual(cleared);
      });

      it("rejects invalid resources", async () => {
        const invalid = [
          { type: "other", label: "x", url: "javascript:alert(1)" },
          { type: "other", label: "x", url: "file:///etc/passwd" },
          { type: "other", label: "x", url: "not a url" },
          { type: "other", label: " ", url: "https://example.com" },
          { type: "chat", label: "x", url: "https://example.com" },
          { type: "other", label: "x" },
        ];
        for (const resource of invalid) {
          await expect(
            storage.createProject({ name: "p", resources: [resource] as never }),
          ).rejects.toBeInstanceOf(ValidationError);
        }
        expect(await storage.getProjects()).toEqual([]);
      });

      it("rejects malformed IDs", async () => {
        await expect(storage.getProject(MALFORMED_ID)).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.deleteProject(MALFORMED_ID)).rejects.toBeInstanceOf(ValidationError);
      });

      it("throws NotFoundError when mutating a missing project", async () => {
        await expect(storage.updateProject(UNKNOWN_ID, { name: "x" })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(storage.deleteProject(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe("tasks", () => {
      it("starts empty", async () => {
        expect(await storage.getTasks()).toEqual([]);
        expect(await storage.getTask(UNKNOWN_ID)).toBeNull();
      });

      it("creates a task with defaults and reads it back", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "Write tests" });
        expect(task).toMatchObject({
          projectId: project.id,
          title: "Write tests",
          description: "",
          status: "todo",
          isPublic: false,
        });
        expect(task).not.toHaveProperty("dueDate");
        expect(task).not.toHaveProperty("priority");
        expect(task).not.toHaveProperty("labels");
        expect(task).not.toHaveProperty("order");
        expect(task).not.toHaveProperty("checklist");
        expect(task).not.toHaveProperty("needsHuman");
        expect(TaskSchema.parse(task)).toEqual(task);
        expect(await storage.getTask(task.id)).toEqual(task);
      });

      it("round-trips every optional field", async () => {
        const project = await createProject();
        const task = await storage.saveTask({
          projectId: project.id,
          title: "Full",
          description: "Body",
          status: "in_progress",
          isPublic: true,
          dueDate: "2026-12-31",
          priority: "trivial",
          labels: ["a", "b"],
          order: 1.5,
          checklist: [
            { text: "First", done: true },
            { text: "Second", done: false },
          ],
          needsHuman: "Pick a pricing tier",
        });
        expect(await storage.getTask(task.id)).toEqual(task);
        expect(task).toMatchObject({
          dueDate: "2026-12-31",
          priority: "trivial",
          labels: ["a", "b"],
          order: 1.5,
          checklist: [
            { text: "First", done: true },
            { text: "Second", done: false },
          ],
          needsHuman: "Pick a pricing tier",
          isPublic: true,
          status: "in_progress",
        });
      });

      it("requires an existing project", async () => {
        await expect(storage.saveTask({ projectId: UNKNOWN_ID, title: "t" })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(await storage.getTasks()).toEqual([]);
      });

      it("rejects invalid task input", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
        await expect(storage.saveTask({ projectId: project.id, title: " " })).rejects.toBeInstanceOf(
          ValidationError,
        );
        await expect(
          storage.saveTask({ projectId: project.id, title: "t", dueDate: "2026-02-30" }),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.updateTask(task.id, {})).rejects.toBeInstanceOf(ValidationError);
        await expect(
          storage.updateTask(task.id, { title: null } as never),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.getTask(MALFORMED_ID)).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.getTasks({ projectId: MALFORMED_ID })).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(await storage.getTasks()).toEqual([task]);
      });

      it("patches fields, clears with null and bumps updatedAt", async () => {
        const project = await createProject();
        const task = await storage.saveTask({
          projectId: project.id,
          title: "t",
          dueDate: "2026-12-31",
          priority: "high",
          labels: ["x"],
          order: 3,
        });
        const updated = await storage.updateTask(task.id, {
          title: "Renamed",
          dueDate: null,
          labels: null,
          priority: "urgent",
        });
        expect(updated).toMatchObject({
          id: task.id,
          title: "Renamed",
          priority: "urgent",
          order: 3,
          createdAt: task.createdAt,
        });
        expect(updated).not.toHaveProperty("dueDate");
        expect(updated).not.toHaveProperty("labels");
        expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(task.updatedAt));
        expect(await storage.getTask(task.id)).toEqual(updated);
      });

      it("edits the checklist as a whole and keeps item order", async () => {
        const project = await createProject();
        const task = await storage.saveTask({
          projectId: project.id,
          title: "t",
          checklist: [
            { text: "a", done: false },
            { text: "b", done: false },
          ],
        });

        // Check, rename, reorder and add in one replacement
        const edited = await storage.updateTask(task.id, {
          checklist: [
            { text: "c", done: false },
            { text: "b renamed", done: true },
            { text: "a", done: false },
          ],
        });
        expect(edited.checklist).toEqual([
          { text: "c", done: false },
          { text: "b renamed", done: true },
          { text: "a", done: false },
        ]);
        expect(await storage.getTask(task.id)).toEqual(edited);

        // Other patches leave it alone
        const retitled = await storage.updateTask(task.id, { title: "Retitled" });
        expect(retitled.checklist).toEqual(edited.checklist);

        // An empty list removes it, like null
        const emptied = await storage.updateTask(task.id, { checklist: [] });
        expect(emptied).not.toHaveProperty("checklist");
        expect(await storage.getTask(task.id)).toEqual(emptied);

        const restored = await storage.updateTask(task.id, { checklist: [{ text: "x", done: true }] });
        const cleared = await storage.updateTask(restored.id, { checklist: null });
        expect(cleared).not.toHaveProperty("checklist");
        expect(await storage.getTask(task.id)).toEqual(cleared);
      });

      it("stores an empty checklist as none", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t", checklist: [] });
        expect(task).not.toHaveProperty("checklist");
        expect(await storage.getTask(task.id)).toEqual(task);
      });

      it("rejects invalid checklist items", async () => {
        const project = await createProject();
        await expect(
          storage.saveTask({ projectId: project.id, title: "t", checklist: [{ text: " ", done: false }] }),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(
          storage.saveTask({
            projectId: project.id,
            title: "t",
            checklist: [{ text: "x" }] as never,
          }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await storage.getTasks()).toEqual([]);
      });

      it("flags a task as needing a human and clears the flag", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });

        const flagged = await storage.updateTask(task.id, { needsHuman: "  Approve the schema change  " });
        expect(flagged.needsHuman).toBe("Approve the schema change");
        expect(await storage.getTask(task.id)).toEqual(flagged);

        // Other edits keep the flag
        const retitled = await storage.updateTask(task.id, { title: "renamed" });
        expect(retitled.needsHuman).toBe("Approve the schema change");

        const cleared = await storage.updateTask(task.id, { needsHuman: null });
        expect(cleared).not.toHaveProperty("needsHuman");
        expect(await storage.getTask(task.id)).toEqual(cleared);
      });

      it("rejects a blank needs-human reason", async () => {
        const project = await createProject();
        await expect(
          storage.saveTask({ projectId: project.id, title: "t", needsHuman: "   " }),
        ).rejects.toBeInstanceOf(ValidationError);
        expect(await storage.getTasks()).toEqual([]);
      });

      it("filters by project", async () => {
        const a = await createProject("a");
        const b = await createProject("b");
        const taskA = await storage.saveTask({ projectId: a.id, title: "a" });
        const taskB = await storage.saveTask({ projectId: b.id, title: "b" });
        expect(await storage.getTasks({ projectId: a.id })).toEqual([taskA]);
        expect(await storage.getTasks({ projectId: b.id })).toEqual([taskB]);
        expect(await storage.getTasks({ projectId: UNKNOWN_ID })).toEqual([]);
        expect(await storage.getTasks()).toEqual([taskA, taskB]);
        expect(await storage.getTasks({})).toEqual([taskA, taskB]);
      });

      it("returns tasks in canonical order", async () => {
        const project = await createProject();
        const save = (title: string, order?: number): Promise<Task> =>
          storage.saveTask(
            order === undefined
              ? { projectId: project.id, title }
              : { projectId: project.id, title, order },
          );
        const unsetFirst = await save("unset-first");
        const three = await save("three", 3);
        const unsetSecond = await save("unset-second");
        const one = await save("one", 1);
        const negative = await save("negative", -2);
        expect((await storage.getTasks()).map((t) => t.title)).toEqual(
          [negative, one, three, unsetFirst, unsetSecond].map((t) => t.title),
        );
      });

      it("moves a task to another existing project", async () => {
        const a = await createProject("a");
        const b = await createProject("b");
        const task = await storage.saveTask({ projectId: a.id, title: "t" });
        const moved = await storage.updateTask(task.id, { projectId: b.id });
        expect(moved.projectId).toBe(b.id);
        expect(await storage.getTasks({ projectId: a.id })).toEqual([]);
        expect(await storage.getTasks({ projectId: b.id })).toEqual([moved]);
      });

      it("refuses to move a task to a missing project", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
        await expect(storage.updateTask(task.id, { projectId: UNKNOWN_ID })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        expect(await storage.getTask(task.id)).toEqual(task);
      });

      it("deletes a task", async () => {
        const project = await createProject();
        const keep = await storage.saveTask({ projectId: project.id, title: "keep" });
        const drop = await storage.saveTask({ projectId: project.id, title: "drop" });
        await storage.deleteTask(drop.id);
        expect(await storage.getTask(drop.id)).toBeNull();
        expect(await storage.getTasks()).toEqual([keep]);
      });

      it("throws NotFoundError when mutating a missing task", async () => {
        await expect(storage.updateTask(UNKNOWN_ID, { title: "x" })).rejects.toBeInstanceOf(
          NotFoundError,
        );
        await expect(storage.deleteTask(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe("completeTask", () => {
      it("marks a task done", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
        const done = await storage.completeTask(task.id);
        expect(done.status).toBe("done");
        expect(Date.parse(done.updatedAt)).toBeGreaterThan(Date.parse(task.updatedAt));
        expect(await storage.getTask(task.id)).toEqual(done);
      });

      it("is idempotent", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
        const done = await storage.completeTask(task.id);
        expect(await storage.completeTask(task.id)).toEqual(done);
        expect(await storage.getTask(task.id)).toEqual(done);
      });

      it("completes archived tasks", async () => {
        const project = await createProject();
        const task = await storage.saveTask({
          projectId: project.id,
          title: "t",
          status: "archived",
        });
        expect((await storage.completeTask(task.id)).status).toBe("done");
      });

      it("throws NotFoundError for a missing task", async () => {
        await expect(storage.completeTask(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
      });
    });

    describe("deleteProject cascade", () => {
      it("removes the project's tasks and leaves others untouched", async () => {
        const doomed = await createProject("doomed");
        const survivor = await createProject("survivor");
        const doomedTask = await storage.saveTask({ projectId: doomed.id, title: "gone" });
        const survivorTask = await storage.saveTask({ projectId: survivor.id, title: "stays" });
        await storage.deleteProject(doomed.id);
        expect(await storage.getProject(doomed.id)).toBeNull();
        expect(await storage.getTask(doomedTask.id)).toBeNull();
        expect(await storage.getProjects()).toEqual([survivor]);
        expect(await storage.getTasks()).toEqual([survivorTask]);
      });
    });

    describe("comments", () => {
      async function createTask(title = "t"): Promise<Task> {
        const project = await createProject();
        return storage.saveTask({ projectId: project.id, title });
      }

      it("starts with no comments, also for an unknown task", async () => {
        const task = await createTask();
        expect(await storage.getComments(task.id)).toEqual([]);
        expect(await storage.getComments(UNKNOWN_ID)).toEqual([]);
      });

      it("adds comments with defaults, lists them oldest first and leaves the task unchanged", async () => {
        const task = await createTask();
        const first = await storage.addComment({ taskId: task.id, body: "  Which API key?  " });
        const second = await storage.addComment({
          taskId: task.id,
          body: "Use the **staging** key.\n\n- one\n- two",
          authorType: "agent",
          author: " claude ",
        });
        expect(first).toMatchObject({ taskId: task.id, body: "Which API key?", authorType: "human" });
        expect(first).not.toHaveProperty("author");
        expect(second).toMatchObject({ authorType: "agent", author: "claude" });
        expect(CommentSchema.parse(first)).toEqual(first);
        expect(CommentSchema.parse(second)).toEqual(second);
        expect(await storage.getComments(task.id)).toEqual([first, second]);
        expect(await storage.getTask(task.id)).toEqual(task);
      });

      it("keeps each task's comments apart", async () => {
        const a = await createTask("a");
        const b = await createTask("b");
        const onA = await storage.addComment({ taskId: a.id, body: "on a" });
        const onB = await storage.addComment({ taskId: b.id, body: "on b" });
        expect(await storage.getComments(a.id)).toEqual([onA]);
        expect(await storage.getComments(b.id)).toEqual([onB]);
      });

      it("rejects invalid comments and comments on a missing task", async () => {
        const task = await createTask();
        await expect(storage.addComment({ taskId: task.id, body: "   " })).rejects.toBeInstanceOf(ValidationError);
        await expect(
          storage.addComment({ taskId: task.id, body: "x", authorType: "robot" } as never),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.addComment({ taskId: MALFORMED_ID, body: "x" })).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.getComments(MALFORMED_ID)).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.addComment({ taskId: UNKNOWN_ID, body: "x" })).rejects.toBeInstanceOf(NotFoundError);
        expect(await storage.getComments(task.id)).toEqual([]);
      });

      it("deletes one comment", async () => {
        const task = await createTask();
        const gone = await storage.addComment({ taskId: task.id, body: "gone" });
        const kept = await storage.addComment({ taskId: task.id, body: "kept" });
        await storage.deleteComment(gone.id);
        expect(await storage.getComments(task.id)).toEqual([kept]);
        await expect(storage.deleteComment(gone.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(storage.deleteComment(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
        await expect(storage.deleteComment(MALFORMED_ID)).rejects.toBeInstanceOf(ValidationError);
      });

      it("keeps comments on a task moved to another project", async () => {
        const task = await createTask();
        const comment = await storage.addComment({ taskId: task.id, body: "travels along" });
        const target = await createProject("target");
        await storage.updateTask(task.id, { projectId: target.id });
        expect(await storage.getComments(task.id)).toEqual([comment]);
      });

      it("deletes a task's comments with the task and a project's with the project", async () => {
        const project = await createProject("doomed");
        const doomed = await storage.saveTask({ projectId: project.id, title: "doomed" });
        const sibling = await storage.saveTask({ projectId: project.id, title: "sibling" });
        const survivor = await createTask("survivor");
        const doomedComment = await storage.addComment({ taskId: doomed.id, body: "gone with the task" });
        await storage.addComment({ taskId: sibling.id, body: "gone with the project" });
        const kept = await storage.addComment({ taskId: survivor.id, body: "kept" });

        await storage.deleteTask(doomed.id);
        expect(await storage.getComments(doomed.id)).toEqual([]);
        await expect(storage.deleteComment(doomedComment.id)).rejects.toBeInstanceOf(NotFoundError);

        await storage.deleteProject(project.id);
        expect(await storage.getComments(sibling.id)).toEqual([]);
        expect(await storage.getComments(survivor.id)).toEqual([kept]);
      });

      it("returns copies that cannot mutate stored state", async () => {
        const task = await createTask();
        const comment = await storage.addComment({ taskId: task.id, body: "original" });
        const snapshot = { ...comment };
        comment.body = "mutated";
        const listed = await storage.getComments(task.id);
        if (listed[0]) listed[0].body = "mutated";
        expect(await storage.getComments(task.id)).toEqual([snapshot]);
      });
    });

    describe("abort", () => {
      it("rejects every method with the signal reason and changes nothing", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
        const comment = await storage.addComment({ taskId: task.id, body: "c" });
        const { signal, reason } = abortedSignal();
        const opts = { signal };

        const calls: (() => Promise<unknown>)[] = [
          () => storage.getProjects(opts),
          () => storage.getProject(project.id, opts),
          () => storage.createProject({ name: "new" }, opts),
          () => storage.updateProject(project.id, { name: "changed" }, opts),
          () => storage.deleteProject(project.id, opts),
          () => storage.getTasks(undefined, opts),
          () => storage.getTask(task.id, opts),
          () => storage.saveTask({ projectId: project.id, title: "new" }, opts),
          () => storage.updateTask(task.id, { title: "changed" }, opts),
          () => storage.deleteTask(task.id, opts),
          () => storage.completeTask(task.id, opts),
          () => storage.getComments(task.id, opts),
          () => storage.addComment({ taskId: task.id, body: "new" }, opts),
          () => storage.deleteComment(comment.id, opts),
          () => storage.exportProject(project.id, opts),
          () => storage.exportAll(opts),
        ];
        for (const call of calls) {
          await expect(call()).rejects.toBe(reason);
        }

        expect(await storage.getProjects()).toEqual([project]);
        expect(await storage.getTasks()).toEqual([task]);
        expect(await storage.getComments(task.id)).toEqual([comment]);
      });
    });

    describe("ticket codes", () => {
      it("derives a project key from the name and keeps it unique", async () => {
        const first = await storage.createProject({ name: "Bitig" });
        const second = await storage.createProject({ name: "bitig app" });
        expect(first.key).toBe("BIT");
        expect(second.key).toBe("BIT2");
        expect(await storage.getProject(second.id)).toEqual(second);
      });

      it("takes a given key uppercased and rejects one in use", async () => {
        const project = await storage.createProject({ name: "Project", key: " web " });
        expect(project.key).toBe("WEB");
        await expect(storage.createProject({ name: "Other", key: "Web" })).rejects.toBeInstanceOf(
          ValidationError,
        );
        await expect(storage.createProject({ name: "Other", key: "1AB" })).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(await storage.getProjects()).toEqual([project]);
      });

      it("changes a key unless another project uses it", async () => {
        const a = await storage.createProject({ name: "Alpha" });
        const b = await storage.createProject({ name: "Beta" });
        const renamed = await storage.updateProject(a.id, { key: "alf" });
        expect(renamed.key).toBe("ALF");
        expect(await storage.getProject(a.id)).toEqual(renamed);
        expect((await storage.updateProject(a.id, { key: "ALF", name: "Alpha 2" })).key).toBe("ALF");
        await expect(storage.updateProject(b.id, { key: "ALF" })).rejects.toBeInstanceOf(ValidationError);
        expect(await storage.getProject(b.id)).toEqual(b);
      });

      it("numbers tasks per project and keeps numbers on update and completion", async () => {
        const a = await createProject("a");
        const b = await createProject("b");
        const a1 = await storage.saveTask({ projectId: a.id, title: "a1" });
        const a2 = await storage.saveTask({ projectId: a.id, title: "a2" });
        const b1 = await storage.saveTask({ projectId: b.id, title: "b1" });
        expect([a1.number, a2.number, b1.number]).toEqual([1, 2, 1]);
        expect(await storage.getTask(a2.id)).toEqual(a2);

        expect((await storage.updateTask(a1.id, { title: "renamed" })).number).toBe(1);
        expect((await storage.completeTask(a1.id)).number).toBe(1);
        await storage.deleteTask(a1.id);
        expect((await storage.saveTask({ projectId: a.id, title: "a3" })).number).toBe(3);
      });

      it("gives a moved task the next number in its new project", async () => {
        const a = await createProject("a");
        const b = await createProject("b");
        await storage.saveTask({ projectId: b.id, title: "b1" });
        const task = await storage.saveTask({ projectId: a.id, title: "a1" });
        const moved = await storage.updateTask(task.id, { projectId: b.id });
        expect(moved.number).toBe(2);
        expect(await storage.getTask(task.id)).toEqual(moved);
      });

      it("does not let callers set a task number", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
        await expect(
          storage.saveTask({ projectId: project.id, title: "t", number: 9 } as never),
        ).rejects.toBeInstanceOf(ValidationError);
        await expect(storage.updateTask(task.id, { number: 9 } as never)).rejects.toBeInstanceOf(
          ValidationError,
        );
        expect(await storage.getTasks()).toEqual([task]);
      });

      it("imports projects and tasks without codes as they are", async () => {
        const bundle = {
          version: 1 as const,
          exportedAt: "2026-01-01T00:00:00.000Z",
          project: {
            id: "01940000-0000-7000-8000-0000000000a1",
            name: "Legacy",
            description: "",
            kind: "hobby" as const,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          tasks: [
            {
              id: "01940000-0000-7000-8000-0000000000a2",
              projectId: "01940000-0000-7000-8000-0000000000a1",
              title: "Old",
              description: "",
              status: "todo" as const,
              isPublic: false,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        };
        await storage.importProject(bundle);
        expect(await storage.getProject(bundle.project.id)).toEqual(bundle.project);
        expect(await storage.getTasks()).toEqual(bundle.tasks);
        const next = await storage.saveTask({ projectId: bundle.project.id, title: "New" });
        expect(next.number).toBe(1);
      });
    });

    describe("interoperability and bundles", () => {
      it("exports and imports a project bundle with exact fields and tasks", async () => {
        const project = await storage.createProject({
          name: "Export Test",
          kind: "open_source",
          resources: [{ type: "repository", label: "Code", url: "https://github.com/acme/export" }],
        });
        const t1 = await storage.saveTask({
          projectId: project.id,
          title: "Task 1",
          description: "Desc 1",
          status: "in_progress",
          priority: "urgent",
          dueDate: "2026-12-31",
          labels: ["bug", "core"],
          order: 10,
          checklist: [{ text: "Sub", done: true }],
          needsHuman: "Review the export",
        });
        const t2 = await storage.saveTask({
          projectId: project.id,
          title: "Task 2",
          isPublic: true,
        });
        const c1 = await storage.addComment({ taskId: t2.id, body: "On the public task" });
        const c2 = await storage.addComment({ taskId: t1.id, body: "Context", authorType: "agent", author: "claude" });

        const bundle = await storage.exportProject(project.id);
        expect(bundle.version).toBe(1);
        expect(bundle.project).toEqual(project);
        expect(bundle.tasks).toEqual([t1, t2]);
        expect(bundle.comments).toEqual([c1, c2]);

        // Delete project to test import restores it
        await storage.deleteProject(project.id);
        expect(await storage.getProject(project.id)).toBeNull();
        expect(await storage.getTasks({ projectId: project.id })).toEqual([]);

        // Import the bundle
        const importedProject = await storage.importProject(bundle);
        expect(importedProject).toEqual(project);
        expect(await storage.getProject(project.id)).toEqual(project);
        expect(await storage.getTasks({ projectId: project.id })).toEqual([t1, t2]);
        expect(await storage.getComments(t1.id)).toEqual([c2]);
        expect(await storage.getComments(t2.id)).toEqual([c1]);

        // Importing again changes nothing
        await storage.importProject(bundle);
        expect(await storage.getComments(t1.id)).toEqual([c2]);
      });

      it("exportProject throws NotFoundError on missing project", async () => {
        await expect(storage.exportProject(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
      });

      it("exports and imports a full backup bundle", async () => {
        const p1 = await storage.createProject({ name: "P1" });
        const p2 = await storage.createProject({ name: "P2" });
        const t1 = await storage.saveTask({ projectId: p1.id, title: "T1" });
        const t2 = await storage.saveTask({ projectId: p2.id, title: "T2" });
        const comment = await storage.addComment({ taskId: t2.id, body: "Backed up" });

        const backup = await storage.exportAll();
        expect(backup.version).toBe(1);
        expect(backup.bundles.length).toBe(2);

        await storage.deleteProject(p1.id);
        await storage.deleteProject(p2.id);
        expect(await storage.getProjects()).toEqual([]);

        await storage.importBackup(backup);
        expect(await storage.getProjects()).toEqual([p1, p2]);
        expect(await storage.getTasks()).toEqual([t1, t2]);
        expect(await storage.getComments(t2.id)).toEqual([comment]);
      });
    });

    describe("integrity", () => {
      it("returns copies that cannot mutate stored state", async () => {
        const project = await storage.createProject({
          name: "p",
          resources: [{ type: "other", label: "Site", url: "https://example.com" }],
        });
        const task = await storage.saveTask({
          projectId: project.id,
          title: "t",
          labels: ["a"],
          checklist: [{ text: "item", done: false }],
        });
        const snapshotProject = {
          ...project,
          resources: [{ type: "other", label: "Site", url: "https://example.com" }],
        };
        const snapshotTask = { ...task, labels: ["a"], checklist: [{ text: "item", done: false }] };

        project.name = "mutated";
        project.resources?.push({ type: "other", label: "pushed", url: "https://x.example.com" });
        const listedProject = (await storage.getProjects())[0]?.resources?.[0];
        if (listedProject) listedProject.label = "mutated";
        task.title = "mutated";
        task.labels?.push("b");
        task.checklist?.push({ text: "pushed", done: false });
        const listed = await storage.getTasks();
        listed[0]?.labels?.push("c");
        const listedItem = listed[0]?.checklist?.[0];
        if (listedItem) listedItem.done = true;

        expect(await storage.getProject(project.id)).toEqual(snapshotProject);
        expect(await storage.getTask(task.id)).toEqual(snapshotTask);
      });
    });
  });
}

