import type { AgentRun, Project, T3ProjectActiveSession, Task } from "@bitig/core";
import { describe, expect, it } from "vitest";
import { cleanT3Link, resolveWorkspaceActiveSessions } from "./activeSessions";

const STARTED_AT = "2026-01-01T00:00:00.000Z";
const UPDATED_AT = "2026-01-01T01:00:00.000Z";

function project(id: string, key: string): Project {
  return { id, name: `Project ${key}`, description: "", kind: "hobby", key, createdAt: STARTED_AT, updatedAt: STARTED_AT };
}

function task(id: string, projectId: string, number: number): Task {
  return {
    id,
    projectId,
    title: `Task ${String(number)}`,
    description: "",
    status: "in_progress",
    number,
    isPublic: false,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  };
}

const ALPHA = project("01940000-0000-7000-8000-000000000001", "ALP");
const BETA = project("01940000-0000-7000-8000-000000000002", "BET");
const ALPHA_TASK = task("01940000-0000-7000-8000-000000000011", ALPHA.id, 1);
const BETA_TASK = task("01940000-0000-7000-8000-000000000012", BETA.id, 2);

function run(overrides: Partial<AgentRun> & Pick<AgentRun, "taskId" | "threadId" | "state">): AgentRun {
  return {
    id: "01940000-0000-7000-8000-000000000090",
    t3ProjectId: "t3",
    startedAt: STARTED_AT,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

describe("resolveWorkspaceActiveSessions", () => {
  it("joins active runs from every project with their task code and timestamps", () => {
    const sessions = resolveWorkspaceActiveSessions(
      [ALPHA, BETA],
      [ALPHA_TASK, BETA_TASK],
      [
        run({ taskId: ALPHA_TASK.id, threadId: "thread-a", state: "working", model: "opus" }),
        run({ taskId: BETA_TASK.id, threadId: "thread-b", state: "waiting_for_approval" }),
      ],
    );

    expect(sessions).toEqual([
      expect.objectContaining({
        threadId: "thread-a",
        projectId: ALPHA.id,
        taskCode: "ALP-1",
        title: "Task 1",
        state: "working",
        model: "opus",
        startedAt: STARTED_AT,
        updatedAt: UPDATED_AT,
      }),
      expect.objectContaining({ threadId: "thread-b", projectId: BETA.id, taskCode: "BET-2", state: "waiting_for_approval" }),
    ]);
  });

  it("skips runs that are no longer active", () => {
    const sessions = resolveWorkspaceActiveSessions(
      [ALPHA],
      [ALPHA_TASK],
      [run({ taskId: ALPHA_TASK.id, threadId: "thread-a", state: "finished" })],
    );
    expect(sessions).toEqual([]);
  });

  it("de-duplicates a thread reported both as a run and as an active session", () => {
    const duplicate: T3ProjectActiveSession = {
      threadId: "thread-a",
      projectId: ALPHA.id,
      t3ProjectId: "t3",
      state: "working",
      taskId: ALPHA_TASK.id,
    };
    const sessions = resolveWorkspaceActiveSessions(
      [ALPHA],
      [ALPHA_TASK],
      [run({ taskId: ALPHA_TASK.id, threadId: "thread-a", state: "working" })],
      [duplicate],
    );
    expect(sessions).toHaveLength(1);
  });

  it("keeps project-level sessions that have no task", () => {
    const sessions = resolveWorkspaceActiveSessions(
      [ALPHA, BETA],
      [],
      [],
      [
        {
          threadId: "thread-project",
          projectId: BETA.id,
          t3ProjectId: "t3",
          state: "working",
          title: "Ad-hoc session",
          updatedAt: UPDATED_AT,
        },
      ],
    );
    expect(sessions).toEqual([
      expect.objectContaining({ threadId: "thread-project", projectId: BETA.id, title: "Ad-hoc session", updatedAt: UPDATED_AT }),
    ]);
    expect(sessions[0]?.taskId).toBeUndefined();
  });

  it("ignores sessions of projects that are not listed, such as archived ones", () => {
    const sessions = resolveWorkspaceActiveSessions(
      [ALPHA],
      [BETA_TASK],
      [run({ taskId: BETA_TASK.id, threadId: "thread-b", state: "working" })],
    );
    expect(sessions).toEqual([]);
  });
});

describe("cleanT3Link", () => {
  it("strips angle brackets and whitespace from http(s) links", () => {
    expect(cleanT3Link(" <https://t3.example.test/threads/a> ")).toBe("https://t3.example.test/threads/a");
  });

  it("drops empty, relative and non-http links", () => {
    expect(cleanT3Link(undefined)).toBeUndefined();
    expect(cleanT3Link("  ")).toBeUndefined();
    expect(cleanT3Link("/threads/a")).toBeUndefined();
    expect(cleanT3Link("javascript:alert(1)")).toBeUndefined();
  });
});
