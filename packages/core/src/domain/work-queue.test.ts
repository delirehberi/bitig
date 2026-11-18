import { describe, expect, it } from "vitest";
import {
  ACTIVE_WORK_QUEUE_ENTRY_STATES,
  DEFAULT_HOST_MAX_PARALLEL_RUNS,
  HOST_MAX_PARALLEL_RUNS_MAX,
  HOST_MAX_PARALLEL_RUNS_MIN,
  WORK_QUEUE_ENTRY_STATES,
  WORK_QUEUE_STATES,
  WorkQueueEntrySchema,
  WorkQueueSchema,
  canTransitionWorkQueue,
  canTransitionWorkQueueEntry,
  isActiveWorkQueueEntryState,
  isOpenWorkQueueState,
  resolveHostMaxParallelRuns,
} from "./work-queue";
import { ValidationError } from "./errors";

const QUEUE_ID = "01a1e22a-5932-754d-9397-f1475bb80015";
const ORG_ID = "01a10000-0000-7000-8000-000000000001";
const TASK_ID = "01a1e22a-001e-7284-b821-87e76f3986a7";
const PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc2f";
const NOW = "2026-11-16T06:00:00.000Z";

function validQueue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: QUEUE_ID,
    orgId: ORG_ID,
    createdBy: "Emre",
    prompt: "BIT-1 BIT-2",
    state: "planning",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01a1e22a-f150-706b-9d0f-a16adacd7a5d",
    queueId: QUEUE_ID,
    taskId: TASK_ID,
    position: 0,
    lane: PROJECT_ID,
    state: "waiting",
    waitingReason: null,
    resolvedSelection: null,
    umbrellaTaskId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("work queue state", () => {
  it("treats planning, active and paused queues as open", () => {
    expect(WORK_QUEUE_STATES).toEqual(["planning", "active", "paused", "done", "cancelled"]);
    expect(WORK_QUEUE_STATES.filter(isOpenWorkQueueState)).toEqual(["planning", "active", "paused"]);
  });

  it("allows only the documented queue transitions", () => {
    expect(canTransitionWorkQueue("planning", "active")).toBe(true);
    expect(canTransitionWorkQueue("active", "paused")).toBe(true);
    expect(canTransitionWorkQueue("paused", "active")).toBe(true);
    expect(canTransitionWorkQueue("active", "done")).toBe(true);
    expect(canTransitionWorkQueue("planning", "done")).toBe(false);
    expect(canTransitionWorkQueue("done", "active")).toBe(false);
    expect(canTransitionWorkQueue("cancelled", "planning")).toBe(false);
  });
});

describe("work queue entry state", () => {
  it("marks waiting, ready, running and merged as the states that occupy a task", () => {
    expect(ACTIVE_WORK_QUEUE_ENTRY_STATES).toEqual(["waiting", "ready", "running", "merged"]);
    const inactive = WORK_QUEUE_ENTRY_STATES.filter((state) => !isActiveWorkQueueEntryState(state));
    expect(inactive).toEqual(["done", "failed", "skipped", "cancelled"]);
  });

  it("follows the item state machine and keeps terminal states final and lets a failed entry recover", () => {
    expect(canTransitionWorkQueueEntry("waiting", "ready")).toBe(true);
    expect(canTransitionWorkQueueEntry("ready", "running")).toBe(true);
    expect(canTransitionWorkQueueEntry("running", "merged")).toBe(true);
    expect(canTransitionWorkQueueEntry("running", "failed")).toBe(true);
    expect(canTransitionWorkQueueEntry("merged", "done")).toBe(true);
    expect(canTransitionWorkQueueEntry("waiting", "running")).toBe(false);
    expect(canTransitionWorkQueueEntry("merged", "failed")).toBe(false);
    expect(canTransitionWorkQueueEntry("failed", "running")).toBe(true);
    expect(canTransitionWorkQueueEntry("failed", "merged")).toBe(true);
    expect(canTransitionWorkQueueEntry("failed", "waiting")).toBe(false);
    for (const terminal of ["done", "skipped", "cancelled"] as const) {
      for (const target of WORK_QUEUE_ENTRY_STATES) {
        expect(canTransitionWorkQueueEntry(terminal, target)).toBe(false);
      }
    }
  });
});

describe("work queue schemas", () => {
  it("accepts a well-formed queue and entry", () => {
    expect(WorkQueueSchema.parse(validQueue())).toMatchObject({ state: "planning", prompt: "BIT-1 BIT-2" });
    expect(WorkQueueEntrySchema.parse(validEntry())).toMatchObject({ position: 0, state: "waiting" });
  });

  it("rejects unknown states, blank prompts and negative positions", () => {
    expect(WorkQueueSchema.safeParse(validQueue({ state: "running" })).success).toBe(false);
    expect(WorkQueueSchema.safeParse(validQueue({ prompt: "   " })).success).toBe(false);
    expect(WorkQueueEntrySchema.safeParse(validEntry({ state: "queued" })).success).toBe(false);
    expect(WorkQueueEntrySchema.safeParse(validEntry({ position: -1 })).success).toBe(false);
  });

  it("validates the resolved selection snapshot and umbrella link", () => {
    const parsed = WorkQueueEntrySchema.parse(
      validEntry({
        resolvedSelection: { providerInstanceId: "claudeAgent", model: "claude-haiku-5-5", options: [] },
        umbrellaTaskId: TASK_ID,
        waitingReason: "waits on BIT-1",
      }),
    );
    expect(parsed.resolvedSelection?.model).toBe("claude-haiku-5-5");
    expect(parsed.umbrellaTaskId).toBe(TASK_ID);
    expect(WorkQueueEntrySchema.safeParse(validEntry({ resolvedSelection: { model: "x" } })).success).toBe(false);
  });
});

describe("host parallel run cap", () => {
  it("defaults to three runs when the host has no stored cap", () => {
    expect(DEFAULT_HOST_MAX_PARALLEL_RUNS).toBe(3);
    expect(resolveHostMaxParallelRuns(null)).toBe(3);
    expect(resolveHostMaxParallelRuns(undefined)).toBe(3);
  });

  it("returns a stored cap within bounds", () => {
    expect(resolveHostMaxParallelRuns(HOST_MAX_PARALLEL_RUNS_MIN)).toBe(1);
    expect(resolveHostMaxParallelRuns(HOST_MAX_PARALLEL_RUNS_MAX)).toBe(20);
  });

  it("rejects stored caps outside the bounds", () => {
    expect(() => resolveHostMaxParallelRuns(0)).toThrow(ValidationError);
    expect(() => resolveHostMaxParallelRuns(HOST_MAX_PARALLEL_RUNS_MAX + 1)).toThrow(ValidationError);
    expect(() => resolveHostMaxParallelRuns(2.5)).toThrow(ValidationError);
  });
});
