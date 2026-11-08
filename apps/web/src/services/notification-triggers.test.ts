import type { Task } from "@bitig/core";
import { describe, expect, it } from "vitest";
import { notifyRun, notifyTask } from "../test/notification-fixtures";
import { NotificationTracker, type TriggerLabels } from "./notification-triggers";

const LABELS: TriggerLabels = {
  forTask: (task: Task) => ({ ref: `ALP-${String(task.number)}`, title: task.title }),
  forTaskId: (taskId) => (taskId === notifyTask(1).id ? { ref: "ALP-1", title: "Task 1" } : undefined),
};

describe("NotificationTracker", () => {
  it("announces a task moving to done once, with code, title and reason", () => {
    const tracker = new NotificationTracker();
    const open = notifyTask(1);
    tracker.observeTasks([open]);
    const done = notifyTask(1, { status: "done" });
    expect(tracker.handleEvent({ type: "task.updated", task: done }, LABELS)).toEqual([
      { tag: `bitig:task:${open.id}:done`, trigger: "taskCompleted", title: "ALP-1 · Task 1", body: "Task completed", taskRef: "ALP-1" },
    ]);
    // An echo of the same change, or an unrelated edit to the done task, stays quiet.
    expect(tracker.handleEvent({ type: "task.updated", task: done }, LABELS)).toEqual([]);
    expect(tracker.handleEvent({ type: "task.updated", task: { ...done, title: "Renamed" } }, LABELS)).toEqual([]);
  });

  it("announces again after a task is reopened and completed", () => {
    const tracker = new NotificationTracker();
    const done = notifyTask(1, { status: "done" });
    tracker.observeTasks([done]);
    expect(tracker.handleEvent({ type: "task.updated", task: notifyTask(1) }, LABELS)).toEqual([]);
    expect(tracker.handleEvent({ type: "task.updated", task: done }, LABELS)).toHaveLength(1);
  });

  it("never announces state that was already loaded", () => {
    const tracker = new NotificationTracker();
    const waiting = notifyTask(1, { status: "done", needsHuman: "Pick one" });
    tracker.observeTasks([waiting]);
    expect(tracker.handleEvent({ type: "task.updated", task: waiting }, LABELS)).toEqual([]);
  });

  it("announces needsHuman when set, not when reworded, and again after it clears", () => {
    const tracker = new NotificationTracker();
    tracker.observeTasks([notifyTask(1)]);
    const [first] = tracker.handleEvent({ type: "task.updated", task: notifyTask(1, { needsHuman: "Postgres or SQLite?" }) }, LABELS);
    expect(first).toMatchObject({ trigger: "needsHuman", body: "Needs your input: Postgres or SQLite?" });
    expect(tracker.handleEvent({ type: "task.updated", task: notifyTask(1, { needsHuman: "Postgres?" }) }, LABELS)).toEqual([]);
    expect(tracker.handleEvent({ type: "task.updated", task: notifyTask(1) }, LABELS)).toEqual([]);
    expect(tracker.handleEvent({ type: "task.updated", task: notifyTask(1, { needsHuman: "Again?" }) }, LABELS)).toHaveLength(1);
  });

  it("announces new tasks awaiting approval or a person, but not tasks created done", () => {
    const tracker = new NotificationTracker();
    const proposed = notifyTask(2, { status: "todo", pendingApproval: true });
    expect(tracker.handleEvent({ type: "task.created", task: proposed }, LABELS)).toEqual([
      expect.objectContaining({ trigger: "awaitingApproval", taskRef: "ALP-2", body: "Task is awaiting your approval" }),
    ]);
    expect(tracker.handleEvent({ type: "task.created", task: notifyTask(3, { status: "done" }) }, LABELS)).toEqual([]);
    // The done state was recorded, so a later update does not announce it either.
    expect(tracker.handleEvent({ type: "task.updated", task: notifyTask(3, { status: "done" }) }, LABELS)).toEqual([]);
  });

  it("forgets deleted tasks", () => {
    const tracker = new NotificationTracker();
    const done = notifyTask(1, { status: "done" });
    tracker.observeTasks([done]);
    expect(tracker.handleEvent({ type: "task.deleted", id: done.id }, LABELS)).toEqual([]);
    expect(tracker.handleEvent({ type: "task.created", task: notifyTask(1, { needsHuman: "Hi" }) }, LABELS)).toHaveLength(1);
  });

  it("announces agent runs entering states that need a person", () => {
    const tracker = new NotificationTracker();
    const task = notifyTask(1);
    tracker.observeRuns([notifyRun(task, "working")]);
    expect(tracker.handleEvent({ type: "agent_run.updated", run: notifyRun(task, "queued") }, LABELS)).toEqual([]);
    expect(tracker.handleEvent({ type: "agent_run.updated", run: notifyRun(task, "waiting_for_approval") }, LABELS)).toEqual([
      expect.objectContaining({ trigger: "agentRun", title: "ALP-1 · Task 1", body: "Agent is waiting for your approval" }),
    ]);
    expect(tracker.handleEvent({ type: "agent_run.updated", run: notifyRun(task, "waiting_for_approval") }, LABELS)).toEqual([]);
    for (const [state, body] of [
      ["finished", "Agent run finished"],
      ["failed", "Agent run failed"],
      ["stopped", "Agent run stopped"],
    ] as const) {
      expect(tracker.handleEvent({ type: "agent_run.updated", run: notifyRun(task, state) }, LABELS)).toEqual([
        expect.objectContaining({ body, tag: `bitig:run:${notifyRun(task, state).id}:${state}` }),
      ]);
    }
  });

  it("falls back to the task ID for runs on tasks that are not loaded", () => {
    const tracker = new NotificationTracker();
    const unknown = notifyTask(7);
    expect(tracker.handleEvent({ type: "agent_run.updated", run: notifyRun(unknown, "failed") }, LABELS)).toEqual([
      expect.objectContaining({ taskRef: unknown.id, title: `${unknown.id} · Task` }),
    ]);
  });

  it("ignores events that are not task or run transitions", () => {
    const tracker = new NotificationTracker();
    expect(tracker.handleEvent({ type: "sync" }, LABELS)).toEqual([]);
  });
});
