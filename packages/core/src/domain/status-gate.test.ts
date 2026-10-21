import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../memory/memory-storage";
import { createTestRuntime } from "../testing/fixtures";
import { blockingTasks, isTaskBlocked, isTaskFinished } from "./dependencies";
import { NotFoundError, ValidationError } from "./errors";
import {
  AWAITING_APPROVAL_MESSAGE,
  blockedByFromError,
  blockedTaskError,
  checkStatusChange,
  findBlockingTasks,
} from "./status-gate";
import type { Task, TaskStatus } from "./types";

async function setup() {
  const storage = new InMemoryStorage(createTestRuntime());
  const project = await storage.createProject({ name: "Bitig", key: "BIT" });
  const other = await storage.createProject({ name: "Other", key: "OTH" });
  const a = await storage.saveTask({ projectId: project.id, title: "a" });
  const b = await storage.saveTask({ projectId: other.id, title: "b" });
  const c = await storage.saveTask({ projectId: project.id, title: "c", dependsOn: [a.id, b.id] });
  return { storage, a, b, c };
}

function withStatus(status: TaskStatus): Pick<Task, "status"> {
  return { status };
}

describe("isTaskFinished / blockingTasks / isTaskBlocked", () => {
  it("counts done and archived as finished", () => {
    expect(isTaskFinished(withStatus("todo"))).toBe(false);
    expect(isTaskFinished(withStatus("in_progress"))).toBe(false);
    expect(isTaskFinished(withStatus("done"))).toBe(true);
    expect(isTaskFinished(withStatus("archived"))).toBe(true);
  });

  it("lists unfinished dependencies in dependsOn order and skips unknown IDs", () => {
    const byId = new Map([
      ["x", { id: "x", status: "todo" as const }],
      ["y", { id: "y", status: "done" as const }],
      ["z", { id: "z", status: "in_progress" as const }],
    ]);
    expect(blockingTasks({ dependsOn: ["z", "y", "missing", "x"] }, byId).map((t) => t.id)).toEqual(["z", "x"]);
    expect(isTaskBlocked({ dependsOn: ["y", "missing"] }, byId)).toBe(false);
    expect(isTaskBlocked({ dependsOn: ["x"] }, byId)).toBe(true);
    expect(isTaskBlocked({}, byId)).toBe(false);
  });
});

describe("findBlockingTasks", () => {
  it("loads unfinished dependencies across projects with their codes", async () => {
    const { storage, a, b, c } = await setup();
    expect((await findBlockingTasks(storage, c)).map((t) => t.code)).toEqual(["BIT-1", "OTH-1"]);
    await storage.completeTask(a.id);
    await storage.updateTask(b.id, { status: "archived" });
    expect(await findBlockingTasks(storage, c)).toEqual([]);
  });
});

describe("checkStatusChange", () => {
  it("refuses to start or complete a blocked task and names the blockers", async () => {
    const { storage, c } = await setup();
    for (const status of ["in_progress", "done"] as const) {
      const error: unknown = await checkStatusChange(storage, c.id, status, "updateTask").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("BIT-1, OTH-1");
      expect(blockedByFromError(error)).toEqual(["BIT-1", "OTH-1"]);
    }
  });

  it("allows other statuses, an unchanged status and an unknown task", async () => {
    const { storage, c } = await setup();
    expect(await checkStatusChange(storage, c.id, "todo", "updateTask")).toEqual([]);
    expect(await checkStatusChange(storage, c.id, "archived", "updateTask")).toEqual([]);
    expect(await checkStatusChange(storage, "01a15ba1-dbc7-703e-8c18-286c229c2c41", "done", "x")).toEqual([]);
    await storage.updateTask(c.id, { status: "in_progress" });
    expect(await checkStatusChange(storage, c.id, "in_progress", "updateTask")).toEqual([]);
  });

  it("lets the change through once every dependency is done or archived", async () => {
    const { storage, a, b, c } = await setup();
    await storage.completeTask(a.id);
    await expect(checkStatusChange(storage, c.id, "done", "completeTask")).rejects.toBeInstanceOf(ValidationError);
    await storage.updateTask(b.id, { status: "archived" });
    expect(await checkStatusChange(storage, c.id, "done", "completeTask")).toEqual([]);
  });

  it("returns the overridden blockers when a person overrides", async () => {
    const { storage, a, c } = await setup();
    await storage.completeTask(a.id);
    expect(await checkStatusChange(storage, c.id, "done", "completeTask", { overrideBlocked: true })).toEqual([
      "OTH-1",
    ]);
  });

  it("refuses a task awaiting approval only when approval is required, before dependencies", async () => {
    const { storage, a, b } = await setup();
    const c = await storage.saveTask({
      projectId: a.projectId,
      title: "unapproved",
      dependsOn: [a.id, b.id],
      pendingApproval: true,
    });
    const error: unknown = await checkStatusChange(storage, c.id, "done", "complete_task", {
      requireApproval: true,
      overrideBlocked: true,
    }).catch((e: unknown) => e);
    expect((error as ValidationError).message).toContain(AWAITING_APPROVAL_MESSAGE);
    expect(blockedByFromError(error)).toBeUndefined();
    expect(await checkStatusChange(storage, c.id, "done", "x", { overrideBlocked: true })).toHaveLength(2);
  });
});

describe("blockedByFromError", () => {
  it("reads the blockers back, also from a rebuilt error, and ignores other errors", () => {
    const error = blockedTaskError("updateTask", ["BIT-1"], "in_progress");
    expect(blockedByFromError(error)).toEqual(["BIT-1"]);
    const rebuilt = new ValidationError("updateTask", JSON.parse(JSON.stringify(error.issues)) as ValidationError["issues"]);
    expect(blockedByFromError(rebuilt)).toEqual(["BIT-1"]);
    expect(blockedByFromError(new ValidationError("x", []))).toBeUndefined();
    expect(blockedByFromError(new NotFoundError("task", "x"))).toBeUndefined();
    expect(blockedByFromError("nope")).toBeUndefined();
  });
});
