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
import { ProjectSchema, TaskSchema } from "../domain/schemas";
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
        });
        expect(await storage.getTask(task.id)).toEqual(task);
        expect(task).toMatchObject({
          dueDate: "2026-12-31",
          priority: "trivial",
          labels: ["a", "b"],
          order: 1.5,
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

    describe("abort", () => {
      it("rejects every method with the signal reason and changes nothing", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t" });
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
          () => storage.exportProject(project.id, opts),
          () => storage.exportAll(opts),
        ];
        for (const call of calls) {
          await expect(call()).rejects.toBe(reason);
        }

        expect(await storage.getProjects()).toEqual([project]);
        expect(await storage.getTasks()).toEqual([task]);
      });
    });

    describe("interoperability and bundles", () => {
      it("exports and imports a project bundle with exact fields and tasks", async () => {
        const project = await storage.createProject({ name: "Export Test", kind: "open_source" });
        const t1 = await storage.saveTask({
          projectId: project.id,
          title: "Task 1",
          description: "Desc 1",
          status: "in_progress",
          priority: "urgent",
          dueDate: "2026-12-31",
          labels: ["bug", "core"],
          order: 10,
        });
        const t2 = await storage.saveTask({
          projectId: project.id,
          title: "Task 2",
          isPublic: true,
        });

        const bundle = await storage.exportProject(project.id);
        expect(bundle.version).toBe(1);
        expect(bundle.project).toEqual(project);
        expect(bundle.tasks).toEqual([t1, t2]);

        // Delete project to test import restores it
        await storage.deleteProject(project.id);
        expect(await storage.getProject(project.id)).toBeNull();
        expect(await storage.getTasks({ projectId: project.id })).toEqual([]);

        // Import the bundle
        const importedProject = await storage.importProject(bundle);
        expect(importedProject).toEqual(project);
        expect(await storage.getProject(project.id)).toEqual(project);
        expect(await storage.getTasks({ projectId: project.id })).toEqual([t1, t2]);
      });

      it("exportProject throws NotFoundError on missing project", async () => {
        await expect(storage.exportProject(UNKNOWN_ID)).rejects.toBeInstanceOf(NotFoundError);
      });

      it("exports and imports a full backup bundle", async () => {
        const p1 = await storage.createProject({ name: "P1" });
        const p2 = await storage.createProject({ name: "P2" });
        const t1 = await storage.saveTask({ projectId: p1.id, title: "T1" });
        const t2 = await storage.saveTask({ projectId: p2.id, title: "T2" });

        const backup = await storage.exportAll();
        expect(backup.version).toBe(1);
        expect(backup.bundles.length).toBe(2);

        await storage.deleteProject(p1.id);
        await storage.deleteProject(p2.id);
        expect(await storage.getProjects()).toEqual([]);

        await storage.importBackup(backup);
        expect(await storage.getProjects()).toEqual([p1, p2]);
        expect(await storage.getTasks()).toEqual([t1, t2]);
      });
    });

    describe("integrity", () => {
      it("returns copies that cannot mutate stored state", async () => {
        const project = await createProject();
        const task = await storage.saveTask({ projectId: project.id, title: "t", labels: ["a"] });
        const snapshotProject = { ...project };
        const snapshotTask = { ...task, labels: ["a"] };

        project.name = "mutated";
        task.title = "mutated";
        task.labels?.push("b");
        const listed = await storage.getTasks();
        listed[0]?.labels?.push("c");

        expect(await storage.getProject(project.id)).toEqual(snapshotProject);
        expect(await storage.getTask(task.id)).toEqual(snapshotTask);
      });
    });
  });
}

