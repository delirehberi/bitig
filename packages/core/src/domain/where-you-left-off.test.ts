import { describe, expect, it } from "vitest";
import type { Project, Task } from "./types";
import { LEFT_OFF_IN_PROGRESS_LIMIT, LEFT_OFF_RECENT_LIMIT, lastTouch, whereYouLeftOff } from "./where-you-left-off";

function project(n: number, overrides: Partial<Project> = {}): Project {
  return {
    id: `01940000-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`,
    name: `Project ${String(n)}`,
    description: "",
    kind: "hobby",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

let nextTaskId = 100;
function task(projectId: string, updatedAt: string, overrides: Partial<Task> = {}): Task {
  nextTaskId += 1;
  return {
    id: `01940000-0000-7000-8000-000000000${String(nextTaskId)}`,
    projectId,
    title: `Task ${String(nextTaskId)}`,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt,
    ...overrides,
  };
}

describe("lastTouch", () => {
  const base = task(project(1).id, "2026-10-20T10:00:00.000Z");

  it("reads what the last touch did from the lifecycle timestamps", () => {
    expect(lastTouch({ ...base, createdAt: base.updatedAt }).kind).toBe("created");
    expect(lastTouch({ ...base, startedAt: base.updatedAt }).kind).toBe("started");
    expect(lastTouch({ ...base, startedAt: "2026-10-19T00:00:00.000Z", completedAt: base.updatedAt }).kind).toBe(
      "completed",
    );
    expect(lastTouch({ ...base, startedAt: "2026-10-19T00:00:00.000Z" }).kind).toBe("updated");
  });

  it("names the actor only when the newest activity entry is that touch", () => {
    const entry = { action: "updated" as const, actor: "claude", timestamp: base.updatedAt };
    expect(lastTouch({ ...base, activity: [entry] }).actor).toBe("claude");
    expect(
      lastTouch({ ...base, activity: [{ ...entry, timestamp: "2026-10-19T00:00:00.000Z" }] }).actor,
    ).toBeUndefined();
    expect(lastTouch(base).actor).toBeUndefined();
  });
});

describe("whereYouLeftOff", () => {
  it("is empty without projects", () => {
    expect(whereYouLeftOff([], [])).toEqual({
      lastProject: undefined,
      inProgress: [],
      inProgressCount: 0,
      recent: [],
    });
  });

  it("picks the project with the newest touch and counts its open work", () => {
    const quiet = project(1, { updatedAt: "2026-10-15T00:00:00.000Z" });
    const busy = project(2);
    const tasks = [
      task(busy.id, "2026-10-21T09:00:00.000Z", { status: "in_progress" }),
      task(busy.id, "2026-10-20T09:00:00.000Z", { status: "todo" }),
      task(busy.id, "2026-10-19T09:00:00.000Z", { status: "done" }),
    ];
    expect(whereYouLeftOff([quiet, busy], tasks).lastProject).toEqual({
      project: busy,
      lastActiveAt: "2026-10-21T09:00:00.000Z",
      inProgressCount: 1,
      openCount: 2,
    });
  });

  it("lists in-progress tasks newest first with their next unchecked subtask", () => {
    const p = project(1);
    const older = task(p.id, "2026-10-20T09:00:00.000Z", { status: "in_progress" });
    const newer = task(p.id, "2026-10-21T09:00:00.000Z", {
      status: "in_progress",
      checklist: [
        { text: "Write schema", done: true },
        { text: "Write migration", done: false },
        { text: "Ship", done: false },
      ],
    });
    const todo = task(p.id, "2026-10-22T09:00:00.000Z");
    const result = whereYouLeftOff([p], [older, todo, newer]);
    expect(result.inProgress).toEqual([
      { task: newer, project: p, nextSubtask: "Write migration" },
      { task: older, project: p, nextSubtask: undefined },
    ]);
    expect(result.inProgressCount).toBe(2);
  });

  it("caps the lists but still counts every in-progress task", () => {
    const p = project(1);
    const tasks = Array.from({ length: LEFT_OFF_RECENT_LIMIT + 2 }, (_, i) =>
      task(p.id, `2026-10-${String(10 + i)}T09:00:00.000Z`, { status: "in_progress" }),
    );
    const result = whereYouLeftOff([p], tasks);
    expect(result.inProgress).toHaveLength(LEFT_OFF_IN_PROGRESS_LIMIT);
    expect(result.inProgressCount).toBe(tasks.length);
    expect(result.recent).toHaveLength(LEFT_OFF_RECENT_LIMIT);
    expect(result.recent[0]?.task).toBe(tasks.at(-1));
  });

  it("describes recent touches, including finished tasks", () => {
    const p = project(1);
    const done = task(p.id, "2026-10-21T12:00:00.000Z", {
      status: "done",
      startedAt: "2026-10-21T09:00:00.000Z",
      completedAt: "2026-10-21T12:00:00.000Z",
      activity: [{ action: "completed", actor: "claude", timestamp: "2026-10-21T12:00:00.000Z" }],
    });
    expect(whereYouLeftOff([p], [done]).recent).toEqual([
      { task: done, project: p, at: done.updatedAt, kind: "completed", actor: "claude" },
    ]);
  });

  it("leaves out archived projects, their tasks and archived tasks", () => {
    const live = project(1);
    const archived = project(2, { archived: true, updatedAt: "2026-10-22T00:00:00.000Z" });
    const hidden = [
      task(archived.id, "2026-10-22T09:00:00.000Z", { status: "in_progress" }),
      task(live.id, "2026-10-22T10:00:00.000Z", { status: "archived" }),
    ];
    const kept = task(live.id, "2026-10-20T09:00:00.000Z", { status: "in_progress" });
    const result = whereYouLeftOff([live, archived], [...hidden, kept]);
    expect(result.lastProject?.project).toBe(live);
    expect(result.inProgress.map((entry) => entry.task)).toEqual([kept]);
    expect(result.recent.map((entry) => entry.task)).toEqual([kept]);
  });
});
