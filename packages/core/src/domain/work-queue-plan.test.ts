import { describe, expect, it } from "vitest";
import { planWorkQueue, type WorkQueuePlanTask } from "./work-queue-plan";

const projects = [{ id: "project", key: "BIT", connected: true }];
const item = (number: number) => ({ key: "BIT", number, raw: `BIT-${String(number)}` });
const task = (number: number, overrides: Partial<WorkQueuePlanTask> = {}): WorkQueuePlanTask => ({
  id: String(number), code: `BIT-${String(number)}`, projectId: "project", status: "todo", ...overrides,
});

describe("planWorkQueue", () => {
  it("classifies missing, gated, running, queued and completed tasks", () => {
    const tasks = [task(1), task(2, { pendingApproval: true }), task(3, { needsHuman: "Review" }), task(4, { status: "in_progress" }), task(5), task(6, { status: "done" })];
    const result = planWorkQueue({ items: [1, 2, 3, 4, 5, 6, 7].map(item), tasks, projects, queuedTaskIds: ["5"] });
    expect(result.items.map((entry) => entry.classification)).toEqual(["ready", "needs_approval", "needs_person", "already_running", "already_queued", "done", "not_found"]);
  });

  it("folds listed children and skips children of unlisted parents", () => {
    const tasks = [task(1), task(2, { parentId: "1" }), task(3, { parentId: "4" }), task(4)];
    const result = planWorkQueue({ items: [1, 2, 3].map(item), tasks, projects });
    expect(result.items.map((entry) => entry.classification)).toEqual(["ready", "folded", "unlisted_parent"]);
    expect(result.lanes[0]?.items).toHaveLength(1);
  });

  it("schedules dependencies and overlapping tasks in separate waves", () => {
    const profile = { touches: ["src/**"], parallelSafe: true };
    const tasks = [task(1, { profile }), task(2, { profile }), task(3, { dependsOn: ["1"], profile: { touches: ["other/**"], parallelSafe: true } })];
    const result = planWorkQueue({ items: [1, 2, 3].map(item), tasks, projects });
    expect(result.items[2]?.classification).toBe("after_queued_task");
    expect(result.lanes[0]?.waves.map((wave) => wave.tasks.map((entry) => entry.code))).toEqual([["BIT-1"], ["BIT-2", "BIT-3"]]);
    expect(result.lanes[0]?.waves[0]?.skipped.map((skip) => skip.reason)).toEqual(["overlaps_picked", "dependency"]);
  });

  it("classifies disconnected, active and archived tasks before scheduling", () => {
    const result = planWorkQueue({
      items: [1, 2, 3, 4].map(item),
      tasks: [task(1), task(2), task(3, { status: "archived" }), task(4, { projectId: "disconnected" })],
      projects: [...projects, { id: "disconnected", key: "OTHER", connected: false }],
      activeTaskIds: ["1"], queuedTaskIds: ["2"],
    });
    expect(result.items.map((entry) => entry.classification)).toEqual(["already_running", "already_queued", "done", "project_not_connected"]);
    expect(result.lanes).toEqual([]);
  });

  it("holds unqueued blockers and propagates holds through a chain", () => {
    const tasks = [task(1, { dependsOn: ["outside"] }), task(2, { blockedBy: ["1"] }), task(3, { dependsOn: ["2"] })];
    const result = planWorkQueue({ items: [1, 2, 3].map(item), tasks, projects });
    expect(result.items.map((entry) => entry.classification)).toEqual(["waits_on_unqueued_task", "waits_on_unqueued_task", "waits_on_unqueued_task"]);
    expect(result.items[1]?.related).toEqual(["BIT-1"]);
    expect(result.lanes).toEqual([]);
  });

  it("uses both dependency inputs and ignores completed dependencies", () => {
    const tasks = [task(1, { status: "done" }), task(2, { dependsOn: ["1"], blockedBy: ["missing"] })];
    const result = planWorkQueue({ items: [2].map(item), tasks, projects });
    expect(result.items[0]).toMatchObject({ classification: "waits_on_unqueued_task", related: ["missing"] });
  });

  it("plans cross-project dependencies in globally numbered waves", () => {
    const other = { id: "other", key: "WOR", connected: true };
    const tasks = [task(1, { profile: { touches: ["bit/**"] } }), task(2, { id: "other-1", code: "WOR-1", projectId: "other", dependsOn: ["1"], profile: { touches: ["wor/**"] } })];
    const result = planWorkQueue({ items: [item(1), { key: "WOR", number: 1, raw: "WOR-1" }], tasks, projects: [...projects, other] });
    expect(result.items[1]).toMatchObject({ classification: "after_queued_task", related: ["BIT-1"] });
    expect(result.lanes.map((lane) => lane.needsQueueUmbrella)).toEqual([false, false]);
    expect(result.lanes[1]?.waves.map((wave) => [wave.number, wave.tasks.map((entry) => entry.code)])).toEqual([[1, []], [2, ["WOR-1"]]]);
    expect(result.lanes[1]?.waves[0]?.skipped[0]).toMatchObject({ code: "WOR-1", reason: "dependency" });
  });

  it("folds dependencies on children into the listed umbrella without changing dependencies", () => {
    const tasks = [task(1), task(2, { parentId: "1" }), task(3, { dependsOn: ["2"] })];
    const result = planWorkQueue({ items: [1, 2, 3].map(item), tasks, projects });
    expect(result.items[1]).toMatchObject({ classification: "folded", related: ["BIT-1"] });
    expect(result.items[0]?.isUmbrella).toBe(true);
    expect(result.items[2]?.classification).toBe("after_queued_task");
    expect(result.lanes[0]?.waves.map((wave) => wave.tasks.map((entry) => entry.code))).toEqual([["BIT-1"], ["BIT-3"]]);
    expect(tasks[2]?.dependsOn).toEqual(["2"]);
  });

  it("does not queue a child when its listed parent is unavailable", () => {
    const result = planWorkQueue({ items: [1, 2, 3].map(item), tasks: [task(1, { needsHuman: "Review" }), task(2, { parentId: "1" }), task(3, { dependsOn: ["2"] })], projects });
    expect(result.items.map((entry) => entry.classification)).toEqual(["needs_person", "folded", "waits_on_unqueued_task"]);
    expect(result.lanes).toEqual([]);
  });

  it("holds cycles and their downstream dependents while scheduling independent work", () => {
    const tasks = [task(1, { dependsOn: ["2"] }), task(2, { dependsOn: ["1"] }), task(3, { dependsOn: ["2"] }), task(4)];
    const result = planWorkQueue({ items: [1, 2, 3, 4].map(item), tasks, projects });
    expect(result.items.map((entry) => entry.classification)).toEqual(["dependency_cycle", "dependency_cycle", "waits_on_unqueued_task", "ready"]);
    expect(result.lanes[0]?.waves[0]?.tasks.map((entry) => entry.code)).toEqual(["BIT-4"]);
  });

  it("detects an umbrella depending on its own folded child", () => {
    const result = planWorkQueue({ items: [1, 2].map(item), tasks: [task(1, { dependsOn: ["2"] }), task(2, { parentId: "1" })], projects });
    expect(result.items.map((entry) => entry.classification)).toEqual(["dependency_cycle", "folded"]);
    expect(result.lanes).toEqual([]);
  });

  it("honors ordering, capacity, no-touches, unsafe and serial-path solo rules", () => {
    const tasks = [
      task(1, { order: 2, profile: { touches: ["one/**"] } }),
      task(2, { order: 1, profile: { touches: ["two/**"] } }),
      task(3, { order: 3 }),
      task(4, { order: 4, profile: { touches: ["four/**"], parallelSafe: false } }),
      task(5, { order: 5, profile: { touches: ["migrations/**"] } }),
      task(6, { order: 6, profile: { touches: ["six/**"] } }),
    ];
    const result = planWorkQueue({ items: [1, 2, 3, 4, 5, 6].map(item), tasks, projects: [{ id: "project", key: "BIT", connected: true, serialPaths: ["migrations/**"], maxParallelChildren: 2 }] });
    expect(result.lanes[0]?.needsQueueUmbrella).toBe(true);
    expect(result.lanes[0]?.waves.map((wave) => wave.tasks.map((entry) => entry.code))).toEqual([["BIT-2", "BIT-1"], ["BIT-3"], ["BIT-4"], ["BIT-5"], ["BIT-6"]]);
    expect(result.lanes[0]?.waves[0]?.skipped[0]?.reason).toBe("cap_reached");
    expect(result.lanes[0]?.waves[1]?.skipped[0]?.reason).toBe("no_touches");
    expect(result.lanes[0]?.waves[2]?.skipped[0]?.reason).toBe("not_parallel_safe");
    expect(result.lanes[0]?.waves[3]?.skipped[0]?.reason).toBe("touches_serial_path");
  });

  it("retains approval on tasks while estimating their waves", () => {
    const original = task(1, { pendingApproval: true });
    const result = planWorkQueue({ items: [item(1)], tasks: [original], projects });
    expect(result.items[0]?.classification).toBe("needs_approval");
    expect(result.lanes[0]?.waves[0]?.tasks[0]).toBe(original);
    expect(original.pendingApproval).toBe(true);
  });

  it("rejects an invalid lane cap instead of silently dropping tasks", () => {
    expect(() => planWorkQueue({ items: [item(1)], tasks: [task(1)], projects: [{ id: "project", key: "BIT", connected: true, maxParallelChildren: 0 }] })).toThrow("Invalid maxParallelChildren");
  });

  it("marks a known umbrella even when its children are not loaded", () => {
    const result = planWorkQueue({ items: [item(1)], tasks: [task(1, { hasChildren: true })], projects });
    expect(result.items[0]?.isUmbrella).toBe(true);
  });
});
