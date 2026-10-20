import { describe, expect, it } from "vitest";
import { RealtimeEventSchema } from "./realtime";

const PROJECT_ID = "0192f0c8-7b4a-7c3e-8f12-3456789abcde";
const TASK_ID = "0192f0c8-7b4a-7c3e-9f12-3456789abcdf";
const COMMENT_ID = "0192f0c8-7b4a-7c3e-af12-3456789abce0";
const NOW = "2026-10-20T12:00:00.000Z";

const SAMPLE_PROJECT = {
  id: PROJECT_ID,
  name: "Bitig",
  description: "Task manager",
  kind: "open_source" as const,
  key: "BIT",
  createdAt: NOW,
  updatedAt: NOW,
};

const SAMPLE_TASK = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "Realtime Update in web ui",
  description: "Push changes via Durable Object",
  status: "in_progress" as const,
  isPublic: false,
  priority: "urgent" as const,
  number: 55,
  createdAt: NOW,
  updatedAt: NOW,
};

const SAMPLE_COMMENT = {
  id: COMMENT_ID,
  taskId: TASK_ID,
  body: "Working on BIT-55",
  authorType: "agent" as const,
  author: "antigravity",
  createdAt: NOW,
};

describe("RealtimeEventSchema", () => {
  it.each([
    { type: "project.created" as const, project: SAMPLE_PROJECT },
    { type: "project.updated" as const, project: SAMPLE_PROJECT },
    { type: "project.deleted" as const, id: PROJECT_ID },
    { type: "task.created" as const, task: SAMPLE_TASK },
    { type: "task.updated" as const, task: SAMPLE_TASK },
    { type: "task.deleted" as const, id: TASK_ID },
    { type: "comment.created" as const, comment: SAMPLE_COMMENT },
    { type: "comment.deleted" as const, id: COMMENT_ID },
    { type: "sync" as const },
  ])("accepts valid $type event", (event) => {
    expect(RealtimeEventSchema.parse(event)).toEqual(event);
  });

  it("rejects unknown event types or malformed payloads", () => {
    expect(RealtimeEventSchema.safeParse({ type: "unknown" }).success).toBe(false);
    expect(RealtimeEventSchema.safeParse({ type: "task.deleted", id: "not-a-uuid" }).success).toBe(false);
    expect(RealtimeEventSchema.safeParse({ type: "sync", extra: true }).success).toBe(false);
  });
});

