import { describe, expect, it } from "vitest";
import {
  applyProjectPatch,
  applyTaskPatch,
  buildProject,
  buildTask,
  compareProjects,
  compareTasks,
  sortProjectsByActivity,
  completeTaskEntity,
} from "./entities";
import { ValidationError } from "./errors";
import type { Project, Task } from "./types";
import { createTestRuntime } from "../testing/fixtures";

function setup(): { project: Project; task: Task; runtime: ReturnType<typeof createTestRuntime> } {
  const runtime = createTestRuntime();
  const project = buildProject({ name: "Bitig" }, runtime, []);
  const task = buildTask({ projectId: project.id, title: "Write tests" }, runtime, 1);
  return { project, task, runtime };
}

describe("buildProject", () => {
  it("assigns id, defaults and equal timestamps", () => {
    const { project } = setup();
    expect(project).toEqual({
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig",
      description: "",
      kind: "hobby",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      key: "BIT",
    });
  });

  it("rejects invalid input", () => {
    expect(() => buildProject({ name: "" }, createTestRuntime(), [])).toThrow(ValidationError);
  });

  it("derives a unique key or takes a free given one", () => {
    const runtime = createTestRuntime();
    expect(buildProject({ name: "Bitig" }, runtime, ["BIT"]).key).toBe("BIT2");
    expect(buildProject({ name: "Bitig", key: "bt" }, runtime, ["BIT"]).key).toBe("BT");
    expect(() => buildProject({ name: "Other", key: "bit" }, runtime, ["BIT"])).toThrow(ValidationError);
  });

  it("rejects a broken id generator", () => {
    const runtime = { ...createTestRuntime(), generateId: () => "bad" };
    expect(() => buildProject({ name: "x" }, runtime, [])).toThrow(ValidationError);
  });
});

describe("applyProjectPatch", () => {
  it("changes only patched fields and bumps updatedAt", () => {
    const { project, runtime } = setup();
    const next = applyProjectPatch(project, { kind: "paid" }, runtime.clock(), []);
    expect(next).toEqual({ ...project, kind: "paid", updatedAt: next.updatedAt });
    expect(next.updatedAt > project.updatedAt).toBe(true);
  });

  it("never moves updatedAt backwards", () => {
    const { project } = setup();
    const next = applyProjectPatch(project, { name: "New" }, new Date(0), []);
    expect(next.updatedAt).toBe(project.updatedAt);
  });

  it("changes the key unless another project has it", () => {
    const { project, runtime } = setup();
    expect(applyProjectPatch(project, { key: " bt " }, runtime.clock(), ["OTH"]).key).toBe("BT");
    expect(applyProjectPatch(project, { key: "BIT" }, runtime.clock(), []).key).toBe("BIT");
    expect(() => applyProjectPatch(project, { key: "oth" }, runtime.clock(), ["OTH"])).toThrow(ValidationError);
    expect(() => applyProjectPatch(project, { key: "1AB" }, runtime.clock(), [])).toThrow(ValidationError);
  });

  it("rejects an empty patch", () => {
    const { project, runtime } = setup();
    expect(() => applyProjectPatch(project, {}, runtime.clock(), [])).toThrow(ValidationError);
  });
});

describe("buildTask", () => {
  it("applies defaults and omits unset optional fields", () => {
    const { task, project } = setup();
    expect(task).toEqual({
      id: "01940000-0000-7000-8000-000000000002",
      projectId: project.id,
      title: "Write tests",
      description: "",
      status: "todo",
      isPublic: false,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      number: 1,
    });
    expect(Object.keys(task)).not.toContain("dueDate");
  });

  it("keeps optional fields and copies labels", () => {
    const runtime = createTestRuntime();
    const project = buildProject({ name: "p" }, runtime, []);
    const labels = ["a", "b"];
    const task = buildTask(
      { projectId: project.id, title: "t", dueDate: "2026-12-31", priority: "urgent", labels, order: 2 },
      runtime,
      1,
    );
    expect(task).toMatchObject({ dueDate: "2026-12-31", priority: "urgent", labels, order: 2 });
    expect(task.labels).not.toBe(labels);
  });
});

describe("applyTaskPatch", () => {
  it("sets, keeps and clears optional fields", () => {
    const { task, runtime } = setup();
    const withFields = applyTaskPatch(
      task,
      { dueDate: "2026-12-31", priority: "low", labels: ["x"], order: 1 },
      runtime.clock(),
    );
    const cleared = applyTaskPatch(withFields, { dueDate: null, order: null }, runtime.clock());
    expect(cleared.priority).toBe("low");
    expect(cleared.labels).toEqual(["x"]);
    expect(Object.keys(cleared)).not.toContain("dueDate");
    expect(Object.keys(cleared)).not.toContain("order");
  });

  it("updates required fields and preserves id/createdAt", () => {
    const { task, runtime } = setup();
    const next = applyTaskPatch(
      task,
      { title: "Renamed", status: "in_progress", isPublic: true, description: "d" },
      runtime.clock(),
    );
    expect(next).toMatchObject({
      id: task.id,
      createdAt: task.createdAt,
      title: "Renamed",
      status: "in_progress",
      isPublic: true,
      description: "d",
    });
    expect(next.updatedAt > task.updatedAt).toBe(true);
  });

  it("rejects clearing a required field", () => {
    const { task, runtime } = setup();
    expect(() => applyTaskPatch(task, { title: null } as never, runtime.clock())).toThrow(
      ValidationError,
    );
  });
});

describe("completeTaskEntity", () => {
  it("marks a task done and bumps updatedAt", () => {
    const { task, runtime } = setup();
    const done = completeTaskEntity(task, runtime.clock());
    expect(done.status).toBe("done");
    expect(done.updatedAt > task.updatedAt).toBe(true);
  });

  it("is idempotent for done tasks", () => {
    const { task, runtime } = setup();
    const done = completeTaskEntity(task, runtime.clock());
    expect(completeTaskEntity(done, runtime.clock())).toBe(done);
  });

  it("completes archived tasks", () => {
    const { task, runtime } = setup();
    const archived = applyTaskPatch(task, { status: "archived" }, runtime.clock(), "claude");
    expect(archived.completedAt).toBe(archived.updatedAt);
    expect(archived.completedBy).toBe("claude");
    expect(completeTaskEntity(archived, runtime.clock()).status).toBe("done");
  });
});

describe("compareTasks", () => {
  const base: Task = {
    id: "01940000-0000-7000-8000-000000000005",
    projectId: "01940000-0000-7000-8000-000000000001",
    title: "t",
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: "2026-01-01T00:00:05.000Z",
    updatedAt: "2026-01-01T00:00:05.000Z",
  };

  it("orders by order, unset last, then createdAt, then id", () => {
    const unsetLate = { ...base, id: "01940000-0000-7000-8000-00000000000a" };
    const unsetEarly = { ...base, createdAt: "2026-01-01T00:00:01.000Z" };
    const unsetSameTimeLowerId = { ...base, id: "01940000-0000-7000-8000-000000000003" };
    const orderTwo = { ...base, order: 2 };
    const orderNegative = { ...base, order: -1 };
    const sorted = [unsetLate, orderTwo, unsetSameTimeLowerId, unsetEarly, orderNegative].sort(
      compareTasks,
    );
    expect(sorted).toEqual([orderNegative, orderTwo, unsetEarly, unsetSameTimeLowerId, unsetLate]);
  });

  it("returns 0 for identical tasks", () => {
    expect(compareTasks(base, { ...base })).toBe(0);
  });
});

describe("compareProjects", () => {
  it("orders by createdAt then id", () => {
    const runtime = createTestRuntime();
    const a = buildProject({ name: "a" }, runtime, []);
    const b = buildProject({ name: "b" }, runtime, []);
    const sameTime = { ...a, id: "01940000-0000-7000-8000-0000000000ff" };
    expect([b, sameTime, a].sort(compareProjects)).toEqual([a, sameTime, b]);
    expect(compareProjects(a, { ...a })).toBe(0);
  });
});


describe("sortProjectsByActivity", () => {
  const runtime = createTestRuntime();
  const older = buildProject({ name: "older" }, runtime, []);
  const newer = buildProject({ name: "newer" }, runtime, []);
  const task: Task = {
    id: "01940000-0000-7000-8000-000000000099",
    projectId: older.id,
    title: "t",
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: older.createdAt,
    updatedAt: older.createdAt,
  };

  it("puts the most recently updated project first", () => {
    expect(sortProjectsByActivity([older, newer], [])).toEqual([newer, older]);
  });

  it("counts a task update as activity on its project", () => {
    const touched = { ...task, updatedAt: "2099-01-01T00:00:00.000Z" };
    expect(sortProjectsByActivity([older, newer], [touched])).toEqual([older, newer]);
  });

  it("ignores tasks of unknown projects and keeps ties in canonical order", () => {
    const stray = { ...task, projectId: "01940000-0000-7000-8000-0000000000aa" };
    const twin = { ...older, id: "01940000-0000-7000-8000-0000000000ff" };
    expect(sortProjectsByActivity([twin, older], [stray])).toEqual([older, twin]);
  });

  it("does not mutate its input", () => {
    const input = [older, newer];
    sortProjectsByActivity(input, []);
    expect(input).toEqual([older, newer]);
  });
});
