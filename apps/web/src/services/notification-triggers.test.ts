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

  it("announces a new feedback task with the feedback variant of the approval notification", () => {
    const tracker = new NotificationTracker();
    const feedback = notifyTask(4, { status: "todo", pendingApproval: true, labels: ["feedback"] });
    expect(tracker.handleEvent({ type: "task.created", task: feedback }, LABELS)).toEqual([
      {
        tag: `bitig:task:${feedback.id}:approval`,
        trigger: "awaitingApproval",
        title: "ALP-4 · Task 4",
        body: "New feedback is awaiting your review",
        taskRef: "ALP-4",
      },
    ]);
    // The same approval state arriving again through an update is not a second notification.
    expect(tracker.handleEvent({ type: "task.updated", task: feedback }, LABELS)).toEqual([]);
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

  it("announces when all running children in an umbrella batch finish, deduplicates with umbrella resume, and resets on the next batch (#BIT-191)", () => {
    const tracker = new NotificationTracker();
    const umbrella = notifyTask(1, { title: "Umbrella rollout" });
    const childA = notifyTask(2, { title: "Child A" });
    const childB = notifyTask(3, { title: "Child B" });
    const startedAt = "2026-03-10T10:00:00.000Z";

    tracker.observeTasks([umbrella, childA, childB]);
    tracker.observeRuns([notifyRun(umbrella, "waiting_subagent")]);
    tracker.observeRunChildren([
      { parentTaskId: umbrella.id, childTaskId: childA.id, state: "running", startedAt },
      { parentTaskId: umbrella.id, childTaskId: childB.id, state: "running", startedAt },
    ]);

    // First child finishing leaves Child B running -> no batch notification yet
    expect(
      tracker.handleEvent(
        {
          type: "agent_run_child.updated",
          child: {
            parentTaskId: umbrella.id,
            childTaskId: childA.id,
            state: "done",
            startedAt,
            finishedAt: "2026-03-10T10:15:00.000Z",
          },
        },
        LABELS,
      ),
    ).toEqual([]);

    // Last child in the batch finishing announces "Child batch finished" once
    expect(
      tracker.handleEvent(
        {
          type: "agent_run_child.updated",
          child: {
            parentTaskId: umbrella.id,
            childTaskId: childB.id,
            state: "done",
            startedAt,
            finishedAt: "2026-03-10T10:18:00.000Z",
          },
        },
        LABELS,
      ),
    ).toEqual([
      {
        tag: `bitig:batch:${umbrella.id}:finished`,
        trigger: "agentRun",
        title: "ALP-1 \u00b7 Task 1",
        body: "Child batch finished",
        taskRef: "ALP-1",
      },
    ]);

    // Umbrella resuming from waiting_subagent -> working right afterward stays deduplicated
    expect(
      tracker.handleEvent(
        { type: "agent_run.updated", run: notifyRun(umbrella, "working") },
        LABELS,
      ),
    ).toEqual([]);

    // Merge conflict setting needsHuman on the umbrella notifies via existing needsHuman trigger
    expect(
      tracker.handleEvent(
        {
          type: "task.updated",
          task: notifyTask(1, { needsHuman: "Merge conflict in packages/core/src/index.ts" }),
        },
        LABELS,
      ),
    ).toEqual([
      {
        tag: `bitig:task:${umbrella.id}:needs-human`,
        trigger: "needsHuman",
        title: "ALP-1 \u00b7 Task 1",
        body: "Needs your input: Merge conflict in packages/core/src/index.ts",
        taskRef: "ALP-1",
      },
    ]);

    // Starting a second child batch clears the batch signal so its completion notifies again
    const childC = notifyTask(4, { title: "Child C" });
    expect(
      tracker.handleEvent(
        {
          type: "agent_run_child.updated",
          child: { parentTaskId: umbrella.id, childTaskId: childC.id, state: "running", startedAt },
        },
        LABELS,
      ),
    ).toEqual([]);
    expect(
      tracker.handleEvent(
        {
          type: "agent_run_child.updated",
          child: {
            parentTaskId: umbrella.id,
            childTaskId: childC.id,
            state: "done",
            startedAt,
            finishedAt: "2026-03-10T10:40:00.000Z",
          },
        },
        LABELS,
      ),
    ).toHaveLength(1);
  });

  it("stays silent for already-completed child batches recorded via observeRunChildren (#BIT-191)", () => {
    const tracker = new NotificationTracker();
    const umbrella = notifyTask(1);
    const childA = notifyTask(2);
    const startedAt = "2026-03-10T10:00:00.000Z";
    tracker.observeRunChildren([
      {
        parentTaskId: umbrella.id,
        childTaskId: childA.id,
        state: "done",
        startedAt,
        finishedAt: "2026-03-10T10:10:00.000Z",
      },
    ]);
    expect(
      tracker.handleEvent(
        {
          type: "agent_run_child.updated",
          child: {
            parentTaskId: umbrella.id,
            childTaskId: childA.id,
            state: "done",
            startedAt,
            finishedAt: "2026-03-10T10:10:00.000Z",
          },
        },
        LABELS,
      ),
    ).toEqual([]);
  });
});
