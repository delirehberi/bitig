import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  ACTIVE_WORK_QUEUE_ENTRY_STATES,
  DEFAULT_ORGANISATION_ID,
  HostMaxParallelRunsSchema,
  NotFoundError,
  OPEN_WORK_QUEUE_STATES,
  T3ModelSelectionSchema,
  ValidationError,
  WorkQueueEntrySchema,
  WorkQueueSchema,
  canTransitionWorkQueue,
  canTransitionWorkQueueEntry,
  isOpenWorkQueueState,
  parseOrThrow,
  resolveHostMaxParallelRuns,
  toTimestamp,
  type T3ModelSelection,
  type WorkQueue,
  type WorkQueueEntry,
  type WorkQueueEntryState,
  type WorkQueueState,
} from "@bitig/core";
import * as schema from "./schema";
import {
  t3Connections,
  tasks,
  projects,
  workQueueItems,
  workQueues,
  type WorkQueueItemRecord,
  type WorkQueueRecord,
} from "./schema";

export interface CreateWorkQueueInput {
  id: string;
  createdBy: string;
  prompt: string;
  /** Epoch milliseconds. */
  now: number;
}

export interface ListWorkQueuesOptions {
  /** Only planning, active and paused queues. */
  openOnly?: boolean | undefined;
}

export interface AddWorkQueueEntryInput {
  id: string;
  queueId: string;
  taskId: string;
  position: number;
  lane: string;
  resolvedSelection?: T3ModelSelection | null | undefined;
  umbrellaTaskId?: string | null | undefined;
  /** Epoch milliseconds. */
  now: number;
}

export interface TransitionWorkQueueEntryInput {
  to: WorkQueueEntryState;
  /** Stored as the entry's waiting reason; `null` or omitted clears it. */
  waitingReason?: string | null | undefined;
  /** Epoch milliseconds. */
  now: number;
}

/** Converts a stored epoch-ms column to the domain's ISO 8601 timestamp. */
function isoAt(epochMs: number): string {
  return toTimestamp(new Date(epochMs));
}

function invalidTransition(context: string, message: string): ValidationError {
  return new ValidationError(context, [{ code: "custom", message, path: [] }]);
}

function parseStoredSelection(raw: string | null): T3ModelSelection | null {
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error: unknown) {
    throw new ValidationError(
      "work queue entry selection",
      [{ code: "custom", message: "stored selection is not valid JSON", path: [] }],
      { cause: error },
    );
  }
  return parseOrThrow(T3ModelSelectionSchema, decoded, "work queue entry selection");
}

function toWorkQueue(row: WorkQueueRecord): WorkQueue {
  return parseOrThrow(
    WorkQueueSchema,
    {
      id: row.id,
      orgId: row.orgId,
      createdBy: row.createdBy,
      prompt: row.prompt,
      state: row.state,
      createdAt: isoAt(row.createdAt),
      updatedAt: isoAt(row.updatedAt),
    },
    "work queue",
  );
}

function toWorkQueueEntry(row: WorkQueueItemRecord): WorkQueueEntry {
  return parseOrThrow(
    WorkQueueEntrySchema,
    {
      id: row.id,
      queueId: row.queueId,
      taskId: row.taskId,
      position: row.position,
      lane: row.lane,
      state: row.state,
      waitingReason: row.waitingReason,
      resolvedSelection: parseStoredSelection(row.resolvedSelection),
      umbrellaTaskId: row.umbrellaTaskId,
      createdAt: isoAt(row.createdAt),
      updatedAt: isoAt(row.updatedAt),
    },
    "work queue entry",
  );
}

/**
 * Persists work queues, their ordered entries and the per-host parallel run
 * cap. Every read and write is scoped to one organisation.
 *
 * The "one active entry per task" rule is checked before inserting and is also
 * enforced by the `work_queue_items_one_active_per_task_idx` partial unique
 * index, which covers races between concurrent writers.
 */
export class D1WorkQueueStore {
  private readonly db: DrizzleD1Database<typeof schema>;
  private readonly orgId: string;

  constructor(d1: D1Database, orgId: string = DEFAULT_ORGANISATION_ID) {
    this.db = drizzle(d1, { schema });
    this.orgId = orgId;
  }

  async createQueue(input: CreateWorkQueueInput): Promise<WorkQueue> {
    const queue = parseOrThrow(
      WorkQueueSchema,
      {
        id: input.id,
        orgId: this.orgId,
        createdBy: input.createdBy,
        prompt: input.prompt,
        state: "planning",
        createdAt: isoAt(input.now),
        updatedAt: isoAt(input.now),
      },
      "work queue",
    );
    await this.db.insert(workQueues).values({
      id: queue.id,
      orgId: queue.orgId,
      createdBy: queue.createdBy,
      prompt: queue.prompt,
      state: queue.state,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return queue;
  }

  async getQueue(id: string): Promise<WorkQueue | undefined> {
    const row = await this.db
      .select()
      .from(workQueues)
      .where(and(eq(workQueues.id, id), eq(workQueues.orgId, this.orgId)))
      .get();
    return row ? toWorkQueue(row) : undefined;
  }

  async listQueues(options: ListWorkQueuesOptions = {}): Promise<WorkQueue[]> {
    const rows = await this.db
      .select()
      .from(workQueues)
      .where(
        and(
          eq(workQueues.orgId, this.orgId),
          options.openOnly ? inArray(workQueues.state, [...OPEN_WORK_QUEUE_STATES]) : undefined,
        ),
      )
      .orderBy(desc(workQueues.createdAt), asc(workQueues.id));
    return rows.map(toWorkQueue);
  }

  async transitionQueue(id: string, to: WorkQueueState, now: number): Promise<WorkQueue> {
    const current = await this.getQueue(id);
    if (!current) throw new NotFoundError("work_queue", id);
    if (!canTransitionWorkQueue(current.state, to)) {
      throw invalidTransition("work queue", `cannot move a ${current.state} queue to ${to}`);
    }
    const result = await this.db
      .update(workQueues)
      .set({ state: to, updatedAt: now })
      .where(and(eq(workQueues.id, id), eq(workQueues.orgId, this.orgId), eq(workQueues.state, current.state)))
      .run();
    if (result.meta.changes === 0) {
      throw invalidTransition("work queue", "queue changed concurrently; retry the transition");
    }
    return (await this.getQueue(id)) ?? current;
  }

  async addEntry(input: AddWorkQueueEntryInput): Promise<WorkQueueEntry> {
    const queue = await this.getQueue(input.queueId);
    if (!queue) throw new NotFoundError("work_queue", input.queueId);
    if (!isOpenWorkQueueState(queue.state)) {
      throw invalidTransition("work queue entry", `cannot add entries to a ${queue.state} queue`);
    }
    await this.assertTaskInOrganisation(input.taskId);
    if (await this.findActiveEntryForTask(input.taskId)) {
      throw invalidTransition("work queue entry", `task ${input.taskId} already has an active queue entry`);
    }
    const entry = parseOrThrow(
      WorkQueueEntrySchema,
      {
        id: input.id,
        queueId: input.queueId,
        taskId: input.taskId,
        position: input.position,
        lane: input.lane,
        state: "waiting",
        waitingReason: null,
        resolvedSelection: input.resolvedSelection ?? null,
        umbrellaTaskId: input.umbrellaTaskId ?? null,
        createdAt: isoAt(input.now),
        updatedAt: isoAt(input.now),
      },
      "work queue entry",
    );
    await this.db.insert(workQueueItems).values({
      id: entry.id,
      queueId: entry.queueId,
      taskId: entry.taskId,
      position: entry.position,
      lane: entry.lane,
      state: entry.state,
      waitingReason: entry.waitingReason,
      resolvedSelection: entry.resolvedSelection === null ? null : JSON.stringify(entry.resolvedSelection),
      umbrellaTaskId: entry.umbrellaTaskId,
      createdAt: input.now,
      updatedAt: input.now,
    });
    return entry;
  }

  async listEntries(queueId: string): Promise<WorkQueueEntry[]> {
    const queue = await this.getQueue(queueId);
    if (!queue) throw new NotFoundError("work_queue", queueId);
    const rows = await this.db
      .select({ item: workQueueItems })
      .from(workQueueItems)
      .where(eq(workQueueItems.queueId, queueId))
      .orderBy(asc(workQueueItems.position));
    return rows.map((row) => toWorkQueueEntry(row.item));
  }

  /** The entry currently occupying a task, if any. */
  async findActiveEntryForTask(taskId: string): Promise<WorkQueueEntry | undefined> {
    const row = await this.db
      .select({ item: workQueueItems })
      .from(workQueueItems)
      .innerJoin(workQueues, eq(workQueues.id, workQueueItems.queueId))
      .where(
        and(
          eq(workQueueItems.taskId, taskId),
          eq(workQueues.orgId, this.orgId),
          inArray(workQueueItems.state, [...ACTIVE_WORK_QUEUE_ENTRY_STATES]),
        ),
      )
      .get();
    return row ? toWorkQueueEntry(row.item) : undefined;
  }

  async transitionEntry(id: string, input: TransitionWorkQueueEntryInput): Promise<WorkQueueEntry> {
    const waitingReason = parseOrThrow(WorkQueueEntrySchema.shape.waitingReason, input.waitingReason ?? null, "work queue entry waiting reason");
    const current = await this.getEntryRecord(id);
    if (!current) throw new NotFoundError("work_queue_entry", id);
    if (!canTransitionWorkQueueEntry(current.state, input.to)) {
      throw invalidTransition("work queue entry", `cannot move a ${current.state} entry to ${input.to}`);
    }
    const result = await this.db
      .update(workQueueItems)
      .set({ state: input.to, waitingReason, updatedAt: input.now })
      .where(and(eq(workQueueItems.id, id), eq(workQueueItems.state, current.state)))
      .run();
    if (result.meta.changes === 0) {
      throw invalidTransition("work queue entry", "entry changed concurrently; retry the transition");
    }
    const updated = await this.getEntryRecord(id);
    return toWorkQueueEntry(updated ?? current);
  }

  /** The host's run cap, falling back to `DEFAULT_HOST_MAX_PARALLEL_RUNS` when unset. */
  async getHostMaxParallelRuns(hostId: string): Promise<number> {
    const row = await this.db
      .select({ maxParallelRuns: t3Connections.maxParallelRuns })
      .from(t3Connections)
      .where(and(eq(t3Connections.id, hostId), eq(t3Connections.orgId, this.orgId)))
      .get();
    if (!row) throw new NotFoundError("t3_host", hostId);
    return resolveHostMaxParallelRuns(row.maxParallelRuns);
  }

  /** Sets the host's run cap, or clears it (`null`) to use the code default. Returns the effective cap. */
  async setHostMaxParallelRuns(hostId: string, value: number | null): Promise<number> {
    const stored = value === null ? null : parseOrThrow(HostMaxParallelRunsSchema, value, "host max parallel runs");
    const result = await this.db
      .update(t3Connections)
      .set({ maxParallelRuns: stored })
      .where(and(eq(t3Connections.id, hostId), eq(t3Connections.orgId, this.orgId)))
      .run();
    if (result.meta.changes === 0) throw new NotFoundError("t3_host", hostId);
    return resolveHostMaxParallelRuns(stored);
  }

  private async getEntryRecord(id: string): Promise<WorkQueueItemRecord | undefined> {
    const row = await this.db
      .select({ item: workQueueItems })
      .from(workQueueItems)
      .innerJoin(workQueues, eq(workQueues.id, workQueueItems.queueId))
      .where(and(eq(workQueueItems.id, id), eq(workQueues.orgId, this.orgId)))
      .get();
    return row?.item;
  }

  private async assertTaskInOrganisation(taskId: string): Promise<void> {
    const row = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(tasks.id, taskId), eq(projects.orgId, this.orgId)))
      .get();
    if (!row) throw new NotFoundError("task", taskId);
  }
}
