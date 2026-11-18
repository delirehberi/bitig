/**
 * Work queues (#BIT-200): persisted queues of tasks to run, their items, the
 * item state machine, and the per-host parallel run cap.
 *
 * Environment-neutral: no Node, DOM or Workers APIs.
 */
import { z } from "zod";
import { parseOrThrow } from "./errors";
import { IdSchema, TimestampSchema } from "./schemas";
import { T3ModelSelectionSchema } from "./t3";

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------

export const WORK_QUEUE_PROMPT_MAX = 10_000;
export const WORK_QUEUE_CREATED_BY_MAX = 200;
export const WORK_QUEUE_WAITING_REASON_MAX = 500;
export const WORK_QUEUE_LANE_MAX = 200;

/** Run cap per T3 host when the host has no explicit `max_parallel_runs`. */
export const DEFAULT_HOST_MAX_PARALLEL_RUNS = 3;
export const HOST_MAX_PARALLEL_RUNS_MIN = 1;
export const HOST_MAX_PARALLEL_RUNS_MAX = 20;

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

export const WORK_QUEUE_STATES = ["planning", "active", "paused", "done", "cancelled"] as const;
export type WorkQueueState = (typeof WORK_QUEUE_STATES)[number];
export const WorkQueueStateSchema = z.enum(WORK_QUEUE_STATES);

/** Queues that can still start or hold work. */
export const OPEN_WORK_QUEUE_STATES = ["planning", "active", "paused"] as const satisfies readonly WorkQueueState[];

export function isOpenWorkQueueState(state: WorkQueueState): boolean {
  return (OPEN_WORK_QUEUE_STATES as readonly WorkQueueState[]).includes(state);
}

const WORK_QUEUE_TRANSITIONS: Readonly<Record<WorkQueueState, readonly WorkQueueState[]>> = {
  planning: ["active", "cancelled"],
  active: ["paused", "done", "cancelled"],
  paused: ["active", "cancelled"],
  done: [],
  cancelled: [],
};

export function canTransitionWorkQueue(from: WorkQueueState, to: WorkQueueState): boolean {
  return WORK_QUEUE_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Entry (queue item) state
// ---------------------------------------------------------------------------

export const WORK_QUEUE_ENTRY_STATES = [
  "waiting",
  "ready",
  "running",
  "merged",
  "done",
  "failed",
  "skipped",
  "cancelled",
] as const;
export type WorkQueueEntryState = (typeof WORK_QUEUE_ENTRY_STATES)[number];
export const WorkQueueEntryStateSchema = z.enum(WORK_QUEUE_ENTRY_STATES);

/**
 * Entries in these states occupy their task: a task may have at most one of
 * them. The D1 partial unique index mirrors this list, so keep both in sync.
 */
export const ACTIVE_WORK_QUEUE_ENTRY_STATES = ["waiting", "ready", "running", "merged"] as const satisfies readonly WorkQueueEntryState[];

export function isActiveWorkQueueEntryState(state: WorkQueueEntryState): boolean {
  return (ACTIVE_WORK_QUEUE_ENTRY_STATES as readonly WorkQueueEntryState[]).includes(state);
}

/** Terminal entries (done, failed, skipped, cancelled) accept no further transitions. */
const WORK_QUEUE_ENTRY_TRANSITIONS: Readonly<Record<WorkQueueEntryState, readonly WorkQueueEntryState[]>> = {
  waiting: ["ready", "skipped", "cancelled"],
  ready: ["running", "waiting", "skipped", "cancelled"],
  running: ["merged", "failed", "cancelled"],
  merged: ["done"],
  done: [],
  // A failed attempt that is still the latest for its task recovers when the task is finished
  // after all, or when its paused session is working again.
  failed: ["running", "merged"],
  skipped: [],
  cancelled: [],
};

export function canTransitionWorkQueueEntry(from: WorkQueueEntryState, to: WorkQueueEntryState): boolean {
  return WORK_QUEUE_ENTRY_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Schemas & types
// ---------------------------------------------------------------------------

export const WorkQueueSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  createdBy: z.string().trim().min(1).max(WORK_QUEUE_CREATED_BY_MAX),
  prompt: z.string().trim().min(1).max(WORK_QUEUE_PROMPT_MAX),
  state: WorkQueueStateSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WorkQueue = z.output<typeof WorkQueueSchema>;

export const WorkQueueEntrySchema = z.strictObject({
  id: IdSchema,
  queueId: IdSchema,
  taskId: IdSchema,
  position: z.number().int().min(0),
  /** Project id the task belongs to; queue lanes run in parallel per project. */
  lane: z.string().trim().min(1).max(WORK_QUEUE_LANE_MAX),
  state: WorkQueueEntryStateSchema,
  waitingReason: z.string().trim().min(1).max(WORK_QUEUE_WAITING_REASON_MAX).nullable(),
  /** Model selection resolved when the entry was planned; a snapshot, not a live setting. */
  resolvedSelection: T3ModelSelectionSchema.nullable(),
  umbrellaTaskId: IdSchema.nullable(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type WorkQueueEntry = z.output<typeof WorkQueueEntrySchema>;

/**
 * The entry that stands for its task when a queue holds several attempts for it (a retry adds a
 * new entry): the latest attempt that was not skipped or cancelled, else the latest attempt.
 * Earlier attempts are history; they neither count in progress nor keep a queue open.
 */
export function isRepresentativeWorkQueueEntry<T extends Pick<WorkQueueEntry, "id" | "taskId" | "state">>(
  entry: T,
  entries: readonly T[],
): boolean {
  const attempts = entries.filter((item) => item.taskId === entry.taskId);
  const ran = attempts.findLast((item) => item.state !== "skipped" && item.state !== "cancelled");
  return (ran ?? attempts.at(-1))?.id === entry.id;
}

/** One entry per task, in queue order: see {@link isRepresentativeWorkQueueEntry}. */
export function representativeWorkQueueEntries<T extends Pick<WorkQueueEntry, "id" | "taskId" | "state">>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => isRepresentativeWorkQueueEntry(entry, entries));
}

export const HostMaxParallelRunsSchema = z
  .number()
  .int()
  .min(HOST_MAX_PARALLEL_RUNS_MIN)
  .max(HOST_MAX_PARALLEL_RUNS_MAX);

/** Parses a stored host cap; `null` means the code default applies. */
export function resolveHostMaxParallelRuns(stored: number | null | undefined): number {
  if (stored === null || stored === undefined) return DEFAULT_HOST_MAX_PARALLEL_RUNS;
  return parseOrThrow(HostMaxParallelRunsSchema, stored, "host max parallel runs");
}
