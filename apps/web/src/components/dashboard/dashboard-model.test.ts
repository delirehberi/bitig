import type { AgentRun, Project, Task } from "@bitig/core";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceActiveSessions } from "../projects/activeSessions";
import {
  STALLED_AFTER_MS,
  buildAttentionItems,
  findStalledTasks,
  workingSessions,
  type DashboardInput,
} from "./dashboard-model";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const LONG_AGO = "2026-03-01T00:00:00.000Z";
const RECENT = new Date(NOW.getTime() - STALLED_AFTER_MS / 2).toISOString();

const ALPHA: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  key: "ALP",
  description: "",
  kind: "paid",
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
};
const ARCHIVED_PROJECT_ID = "01940000-0000-7000-8000-000000000009";

let taskNumber = 0;
function task(overrides: Partial<Task> = {}): Task {
  taskNumber += 1;
  return {
    id: `01940000-0000-7000-8000-${String(100 + taskNumber).padStart(12, "0")}`,
    projectId: ALPHA.id,
    title: `Task ${String(taskNumber)}`,
    description: "",
    status: "in_progress",
    number: taskNumber,
    isPublic: false,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...overrides,
  };
}

function run(forTask: Task, state: AgentRun["state"], updatedAt = LONG_AGO): AgentRun {
  return {
    id: `01940000-0000-7000-8000-${String(900 + Number(forTask.number)).padStart(12, "0")}`,
    taskId: forTask.id,
    t3ProjectId: "t3",
    threadId: `thread-${forTask.id}`,
    link: `https://t3.example.test/${forTask.id}`,
    state,
    startedAt: LONG_AGO,
    updatedAt,
  };
}

function input(tasks: Task[], runs: AgentRun[] = [], projects: Project[] = [ALPHA]): DashboardInput {
  return { projects, tasks, runs, sessions: resolveWorkspaceActiveSessions(projects, tasks, runs) };
}

describe("buildAttentionItems", () => {
  it("lists each reason, most urgent first and oldest first within a reason", () => {
    const waiting = task({ title: "Waiting thread" });
    const question = task({ title: "Question", needsHuman: "Which plan?", updatedAt: "2026-03-05T00:00:00.000Z" });
    const olderQuestion = task({ title: "Older question", needsHuman: "Pick a name", updatedAt: "2026-03-02T00:00:00.000Z" });
    const stopped = task({ title: "Stopped agent" });
    const done = task({ title: "Done", status: "done", completedAt: "2026-03-08T00:00:00.000Z" });

    const items = buildAttentionItems(
      input(
        [done, stopped, question, olderQuestion, waiting],
        [run(waiting, "waiting_for_approval"), run(stopped, "failed")],
      ),
    );

    expect(items.map((item) => [item.reason, item.title])).toEqual([
      ["thread_waiting", "Waiting thread"],
      ["needs_human", "Older question"],
      ["needs_human", "Question"],
      ["agent_stopped", "Stopped agent"],
      ["review_done", "Done"],
    ]);
    expect(items[0]).toMatchObject({ code: `ALP-${String(waiting.number)}`, threadLink: `https://t3.example.test/${waiting.id}` });
    expect(items[1]?.detail).toBe("Pick a name");
    expect(items[3]?.detail).toBe("failed");
  });

  it("shows a task once, under its most urgent reason", () => {
    const both = task({ needsHuman: "Approve the plan" });
    const items = buildAttentionItems(input([both], [run(both, "waiting_for_approval")]));
    expect(items).toHaveLength(1);
    expect(items[0]?.reason).toBe("thread_waiting");
  });

  it("ignores ended runs whose task is no longer in progress, and archived tasks", () => {
    const finished = task({ status: "done", completedAt: LONG_AGO });
    const archived = task({ status: "archived", needsHuman: "stale question" });
    const items = buildAttentionItems(input([finished, archived], [run(finished, "finished")]));
    expect(items.map((item) => item.reason)).toEqual(["review_done"]);
  });

  it("leaves Backlog tasks out, even with a question or a waiting thread", () => {
    const backlog = task({ title: "Agent idea", status: "todo", pendingApproval: true });
    const backlogQuestion = task({ status: "todo", pendingApproval: true, needsHuman: "Worth doing?" });
    const backlogThread = task({ pendingApproval: true });
    const items = buildAttentionItems(
      input([backlog, backlogQuestion, backlogThread], [run(backlogThread, "waiting_for_approval")]),
    );
    expect(items).toEqual([]);
  });

  it("does not treat an offline run as waiting on the person", () => {
    const offline = task();
    expect(buildAttentionItems(input([offline], [run(offline, "offline")]))).toEqual([]);
  });

  it("ignores tasks of projects that are not shown", () => {
    const hidden = task({ projectId: ARCHIVED_PROJECT_ID, needsHuman: "hidden" });
    expect(buildAttentionItems(input([hidden]))).toEqual([]);
  });

  it("lists project-level threads waiting for input", () => {
    const items = buildAttentionItems({
      projects: [ALPHA],
      tasks: [],
      runs: [],
      sessions: resolveWorkspaceActiveSessions(
        [ALPHA],
        [],
        [],
        [
          {
            threadId: "thread-project",
            projectId: ALPHA.id,
            t3ProjectId: "t3",
            state: "waiting_for_approval",
            title: "Project chat",
            updatedAt: RECENT,
          },
        ],
      ),
    });
    expect(items).toEqual([
      expect.objectContaining({ key: "thread-project", reason: "thread_waiting", title: "Project chat", since: RECENT }),
    ]);
    expect(items[0]?.task).toBeUndefined();
  });
});

describe("workingSessions", () => {
  it("keeps working threads, longest running first", () => {
    const first = task();
    const second = task();
    const waiting = task();
    const sessions = resolveWorkspaceActiveSessions(
      [ALPHA],
      [first, second, waiting],
      [
        { ...run(second, "working"), startedAt: "2026-03-09T00:00:00.000Z" },
        { ...run(first, "working"), startedAt: "2026-03-08T00:00:00.000Z" },
        run(waiting, "waiting_for_approval"),
      ],
    );
    expect(workingSessions(sessions).map((session) => session.taskId)).toEqual([first.id, second.id]);
  });
});

describe("findStalledTasks", () => {
  it("lists idle in-progress tasks with no run or an offline run, longest idle first", () => {
    const noRun = task({ title: "Never started", updatedAt: "2026-03-03T00:00:00.000Z" });
    const offline = task({ title: "Host offline", updatedAt: "2026-03-02T00:00:00.000Z" });
    const stalled = findStalledTasks(input([noRun, offline], [run(offline, "offline")]), NOW);
    expect(stalled.map((entry) => entry.task.title)).toEqual(["Host offline", "Never started"]);
    expect(stalled[0]?.lastRun?.state).toBe("offline");
    expect(stalled[1]?.lastRun).toBeUndefined();
    expect(stalled[1]?.code).toBe(`ALP-${String(noRun.number)}`);
  });

  it("skips tasks with an active or ended run, a question, recent activity, or another status", () => {
    const working = task();
    const ended = task();
    const asking = task({ needsHuman: "help" });
    const recent = task({ updatedAt: RECENT });
    const todo = task({ status: "todo" });
    const stalled = findStalledTasks(
      input([working, ended, asking, recent, todo], [run(working, "working"), run(ended, "stopped")]),
      NOW,
    );
    expect(stalled).toEqual([]);
  });
});
