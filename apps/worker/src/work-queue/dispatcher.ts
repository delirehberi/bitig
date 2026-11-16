import { env } from "cloudflare:workers";
import {
  canTransitionWorkQueueEntry,
  defaultIdGenerator,
  isActiveAgentRunState,
  WORK_QUEUE_WAITING_REASON_MAX,
  type AgentRun,
  type Task,
  type WorkQueue,
  type WorkQueueEntry,
  type WorkQueueEntryState,
} from "@bitig/core";
import { D1WorkQueueStore } from "@bitig/storage-d1";
import { launchTaskInT3, stopTaskT3Run, type T3ServiceDeps } from "../t3/service";

const RESERVED_PREFIX = "wq-reserved:";
const USAGE_PREFIX = "Host usage limit: ";
const ACTIVE_STATES_SQL = "('queued','working','waiting_for_approval','waiting_subagent','offline')";
const TERMINAL_ENTRIES = new Set<WorkQueueEntryState>(["done", "failed", "skipped", "cancelled"]);
const FINISHED_TASKS = new Set(["done", "archived"]);
const USAGE_LIMIT_PATTERN = /usage limit|rate limit|credit[s]? (?:exhaust|limit)|quota|\blimited\b|hit your .*limit/i;
const SIGN_IN_PATTERN = /sign.in expired|token.*expired|unauthori[sz]ed|\b401\b/i;
/**
 * A reservation row only lives between the slot reservation and the queued launch request that
 * replaces it within the same request. One older than this was orphaned by a crashed isolate and
 * is released so it stops holding a host slot.
 */
const STALE_RESERVATION_MS = 10 * 60 * 1000;
const ACTIVE_ENTRY_STATES_SQL = "('waiting','ready','running','merged')";

export interface WorkQueueContext {
  db: D1Database;
  orgId: string;
}

export interface WorkQueueDispatchDeps extends WorkQueueContext {
  t3: T3ServiceDeps;
  signal?: AbortSignal | undefined;
}

interface QueueLaunch {
  queue: WorkQueue;
  entry: WorkQueueEntry;
  umbrella: boolean;
}

export class WorkQueueHeldError extends Error {
  override readonly name: string = "WorkQueueHeldError";
}

/** The host already runs `maxParallelRuns` sessions; the launch waits for a free slot. */
export class WorkQueueCapReachedError extends WorkQueueHeldError {
  override readonly name = "WorkQueueCapReachedError";
}

/**
 * Existing REST/MCP callers share the Workers binding; explicit context is used by cron/tests.
 * `T3D1Store` is organisation-scoped, so its connections carry the caller's organisation id.
 */
export async function workQueueContext(deps: T3ServiceDeps): Promise<WorkQueueContext | undefined> {
  if (deps.workQueue) return deps.workQueue;
  const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_queues'").first();
  if (!table) return undefined;
  const connections = await deps.store.listConnections();
  const connection = connections[0];
  return connection ? { db: env.DB, orgId: connection.orgId } : undefined;
}

function queueStore(deps: WorkQueueDispatchDeps): D1WorkQueueStore {
  return new D1WorkQueueStore(deps.db, deps.orgId);
}

function now(deps: WorkQueueDispatchDeps): number {
  deps.signal?.throwIfAborted();
  return deps.t3.now?.() ?? Date.now();
}

function ownsRun(entry: WorkQueueEntry, run: AgentRun | undefined): run is AgentRun {
  return run !== undefined && Date.parse(run.startedAt) >= Date.parse(entry.createdAt);
}

function activeRun(run: AgentRun): boolean {
  return isActiveAgentRunState(run.state) || run.state === "offline";
}

async function updateEntry(
  deps: WorkQueueDispatchDeps, entry: WorkQueueEntry, state: WorkQueueEntryState, reason: string | null = null,
): Promise<WorkQueueEntry> {
  const waitingReason = reason?.slice(0, WORK_QUEUE_WAITING_REASON_MAX) ?? null;
  if (entry.state === state && entry.waitingReason === waitingReason) return entry;
  if (entry.state !== state && !canTransitionWorkQueueEntry(entry.state, state)) return entry;
  const at = now(deps);
  // Compare-and-set also permits changing a waiting reason without a state round trip.
  const result = await deps.db.prepare(`UPDATE work_queue_items SET state = ?, waiting_reason = ?, updated_at = ?
    WHERE id = ? AND state = ? AND updated_at = ? AND queue_id IN
      (SELECT id FROM work_queues WHERE org_id = ?)`)
    .bind(state, waitingReason, at, entry.id, entry.state, Date.parse(entry.updatedAt), deps.orgId).run();
  if (!result.meta.changes) return (await queueStore(deps).listEntries(entry.queueId)).find((item) => item.id === entry.id) ?? entry;
  const updated = { ...entry, state, waitingReason, updatedAt: new Date(at).toISOString() };
  await deps.t3.publishRealtime?.({ type: "work_queue_item.updated", entry: updated });
  return updated;
}

async function runningEntry(deps: WorkQueueDispatchDeps, entry: WorkQueueEntry): Promise<WorkQueueEntry> {
  if (entry.state === "waiting") entry = await updateEntry(deps, entry, "ready");
  if (entry.state === "ready") entry = await updateEntry(deps, entry, "running");
  return entry;
}

async function locateLaunch(deps: WorkQueueDispatchDeps, taskId: string): Promise<QueueLaunch | undefined> {
  for (const queue of await queueStore(deps).listQueues()) {
    const entries = await queueStore(deps).listEntries(queue.id);
    const entry = entries.findLast((item) => item.taskId === taskId) ?? entries.find((item) => item.umbrellaTaskId === taskId);
    if (entry) return { queue, entry, umbrella: entry.umbrellaTaskId === taskId };
  }
  return undefined;
}

async function holdReason(deps: WorkQueueDispatchDeps, launch: QueueLaunch, task: Task): Promise<string | undefined> {
  const { queue, entry, umbrella } = launch;
  if (queue.state !== "active") return `Queue is ${queue.state}`;
  if (!umbrella && TERMINAL_ENTRIES.has(entry.state)) return `Queue item is ${entry.state}; retry it explicitly`;
  if (task.pendingApproval) return "Task approval was revoked";
  if (task.needsHuman) return `Waiting on you: ${task.needsHuman}`;
  if (task.status === "archived") return "Task was archived";
  if (task.status === "done") return "Task is already done";
  if (task.projectId !== entry.lane) return "Task moved to another project";
  if (!umbrella && (task.parentId ?? null) !== entry.umbrellaTaskId) return "Task was reparented";
  if (entry.umbrellaTaskId && !umbrella) {
    const parent = await deps.t3.storage.getTask(entry.umbrellaTaskId);
    if (parent?.needsHuman) return `Lane paused: ${parent.needsHuman}`;
  }
  const entries = await queueStore(deps).listEntries(queue.id);
  for (const dependencyId of task.dependsOn ?? []) {
    const dependency = await deps.t3.storage.getTask(dependencyId);
    if (!dependency || !FINISHED_TASKS.has(dependency.status)) return `Waiting on dependency ${dependencyId}`;
    const queuedDependency = entries.find((item) => item.taskId === dependencyId);
    if (queuedDependency?.state === "failed") return `Dependency ${dependencyId} failed`;
    if (entry.umbrellaTaskId && queuedDependency?.umbrellaTaskId === entry.umbrellaTaskId) {
      const child = await deps.t3.store.getAgentRunChild(entry.umbrellaTaskId, dependencyId);
      if (!child?.mergedAt) return `Waiting for dependency ${dependencyId} to be merged`;
    }
  }
  const mapping = await deps.t3.store.getProjectMapping(task.projectId);
  const connection = await deps.t3.store.getConnection(mapping?.hostId ?? undefined);
  if (!mapping || !connection) return "Project has no connected T3 host";
  for (const candidateQueue of await queueStore(deps).listQueues({ openOnly: true })) {
    for (const candidate of await queueStore(deps).listEntries(candidateQueue.id)) {
      if (!candidate.waitingReason?.startsWith(USAGE_PREFIX)) continue;
      // An explicit pause/resume is permission to try the host again; no paid escalation.
      if (Date.parse(candidateQueue.updatedAt) > Date.parse(candidate.updatedAt)) continue;
      const candidateMapping = await deps.t3.store.getProjectMapping(candidate.lane);
      const candidateHost = await deps.t3.store.getConnection(candidateMapping?.hostId ?? undefined);
      if (candidateHost?.id === connection.id) return candidate.waitingReason;
    }
  }
  return undefined;
}

/** Reused at both enqueue and delivery, including umbrella-driven child starts. */
export async function checkWorkQueueLaunch(
  deps: T3ServiceDeps, taskId: string,
): Promise<{ context: WorkQueueContext; launch: QueueLaunch } | undefined> {
  const context = await workQueueContext(deps);
  if (!context) return undefined;
  const dispatchDeps = { ...context, t3: deps };
  const launch = await locateLaunch(dispatchDeps, taskId);
  if (!launch) return undefined;
  const task = await deps.storage.getTask(taskId);
  if (!task) throw new WorkQueueHeldError("Task no longer exists");
  const reason = await holdReason(dispatchDeps, launch, task);
  if (reason) throw new WorkQueueHeldError(reason);
  return { context, launch };
}

/** Reserve in the run table so competing Worker isolates see the same host occupancy. */
export async function reserveWorkQueueLaunch(deps: T3ServiceDeps, taskId: string): Promise<{
  runId: string; clientRequestId: string; existing: AgentRun | undefined;
} | undefined> {
  const checked = await checkWorkQueueLaunch(deps, taskId);
  if (!checked) return undefined;
  const { context, launch } = checked;
  const { entry, umbrella } = launch;
  const mapping = await deps.store.getProjectMapping(entry.lane);
  const connection = await deps.store.getConnection(mapping?.hostId ?? undefined);
  if (!mapping || !connection) throw new WorkQueueHeldError("Project has no connected T3 host");
  if (connection.expiresAt <= (deps.now?.() ?? Date.now())) throw new WorkQueueHeldError("T3 sign-in expired; reconnect before resuming the queue");
  const clientRequestId = `wq:${entry.id}${!umbrella && entry.umbrellaTaskId ? ":child" : ""}`;
  const marker = `${RESERVED_PREFIX}${clientRequestId}`;
  const existing = await deps.store.getAgentRunByTaskId(taskId);
  if (existing?.threadId === marker) return { runId: existing.id, clientRequestId, existing: undefined };
  if (existing && Date.parse(existing.startedAt) >= Date.parse(entry.createdAt)) {
    return { runId: existing.id, clientRequestId, existing };
  }
  const at = deps.now?.() ?? Date.now();
  const runId = defaultIdGenerator();
  const cap = await new D1WorkQueueStore(context.db, context.orgId).getHostMaxParallelRuns(connection.id);
  // A single SQL statement arbitrates the last slot. Include non-queue task runs and project threads.
  const result = await context.db.prepare(`INSERT INTO agent_runs
    (id, task_id, host_id, t3_project_id, thread_id, state, workspace_strategy, started_at, updated_at)
    SELECT ?, ?, ?, ?, ?, 'queued', 'worktree', ?, ?
    WHERE (SELECT state FROM work_queues WHERE id = ? AND org_id = ?) = 'active'
      AND (SELECT COUNT(*) FROM agent_runs r JOIN tasks t ON t.id = r.task_id JOIN projects p ON p.id = t.project_id
        WHERE p.org_id = ? AND COALESCE(r.host_id, ?) = ? AND r.state IN ${ACTIVE_STATES_SQL})
      + (SELECT COUNT(*) FROM project_t3_threads r JOIN projects p ON p.id = r.project_id
        WHERE p.org_id = ? AND COALESCE(r.host_id, ?) = ? AND r.state IN ${ACTIVE_STATES_SQL}) < ?
    ON CONFLICT(task_id) DO UPDATE SET id = excluded.id, host_id = excluded.host_id,
      t3_project_id = excluded.t3_project_id, thread_id = excluded.thread_id, state = 'queued',
      started_at = excluded.started_at, updated_at = excluded.updated_at
    WHERE agent_runs.state NOT IN ${ACTIVE_STATES_SQL} AND agent_runs.started_at < ?`)
    .bind(runId, taskId, connection.id, mapping.t3ProjectId, marker, at, at, launch.queue.id, context.orgId,
      context.orgId, connection.id, connection.id, context.orgId, connection.id, connection.id, cap, Date.parse(entry.createdAt)).run();
  if (!result.meta.changes) {
    const concurrent = await deps.store.getAgentRunByTaskId(taskId);
    if (concurrent?.threadId === marker) return { runId: concurrent.id, clientRequestId, existing: undefined };
    throw new WorkQueueCapReachedError(`Host parallel run cap (${String(cap)}) reached`);
  }
  return { runId, clientRequestId, existing: undefined };
}

export async function recordWorkQueueFailure(deps: T3ServiceDeps, run: AgentRun, reason?: string): Promise<void> {
  if (!reason || !USAGE_LIMIT_PATTERN.test(reason)) return;
  const context = await workQueueContext(deps);
  if (!context) return;
  const dispatchDeps = { ...context, t3: deps };
  for (const queue of await queueStore(dispatchDeps).listQueues({ openOnly: true })) {
    for (const entry of await queueStore(dispatchDeps).listEntries(queue.id)) {
      if (TERMINAL_ENTRIES.has(entry.state)) continue;
      const mapping = await deps.store.getProjectMapping(entry.lane);
      const connection = await deps.store.getConnection(mapping?.hostId ?? undefined);
      if (connection?.id === run.hostId) await updateEntry(dispatchDeps, entry, entry.state, `${USAGE_PREFIX}${reason}`);
    }
  }
}

async function reconcileEntry(deps: WorkQueueDispatchDeps, entry: WorkQueueEntry): Promise<WorkQueueEntry> {
  if (TERMINAL_ENTRIES.has(entry.state)) return entry;
  const task = await deps.t3.storage.getTask(entry.taskId);
  const run = await deps.t3.store.getAgentRunByTaskId(entry.taskId);
  if (!ownsRun(entry, run) || run.threadId.startsWith(RESERVED_PREFIX)) return entry;
  if (run.state === "queued" || run.threadId.startsWith("queued:")) {
    return entry.state === "waiting" ? updateEntry(deps, entry, "ready", "T3 host offline or waiting to dispatch") : entry;
  }
  entry = await runningEntry(deps, entry);
  if (entry.state === "merged") {
    const umbrella = entry.umbrellaTaskId ? await deps.t3.storage.getTask(entry.umbrellaTaskId) : undefined;
    return !entry.umbrellaTaskId || umbrella?.status === "done" ? updateEntry(deps, entry, "done") : entry;
  }
  if (entry.state !== "running") return entry;
  if (task && FINISHED_TASKS.has(task.status)) {
    const child = entry.umbrellaTaskId ? await deps.t3.store.getAgentRunChild(entry.umbrellaTaskId, entry.taskId) : undefined;
    if (entry.umbrellaTaskId && !child?.mergedAt) return updateEntry(deps, entry, "running", "Waiting for umbrella merge");
    entry = await updateEntry(deps, entry, "merged");
  } else if (["failed", "stopped", "finished"].includes(run.state)) {
    return updateEntry(deps, entry, "failed", entry.waitingReason?.startsWith(USAGE_PREFIX) ? entry.waitingReason : "Run ended before the task was completed");
  }
  if (entry.state === "merged") {
    const umbrella = entry.umbrellaTaskId ? await deps.t3.storage.getTask(entry.umbrellaTaskId) : undefined;
    if (!entry.umbrellaTaskId || umbrella?.status === "done") entry = await updateEntry(deps, entry, "done");
  }
  return entry;
}

async function cancelQueue(deps: WorkQueueDispatchDeps, queue: WorkQueue, entries: WorkQueueEntry[]): Promise<void> {
  // Stop parents first so stopping children cannot resume a cancelled umbrella.
  const taskIds = [...new Set(entries.flatMap((entry) => entry.umbrellaTaskId ? [entry.umbrellaTaskId] : [])), ...entries.map((entry) => entry.taskId)];
  for (const taskId of taskIds) {
    const run = await deps.t3.store.getAgentRunByTaskId(taskId);
    const currentEntry = await queueStore(deps).findActiveEntryForTask(taskId);
    if (currentEntry && currentEntry.queueId !== queue.id) continue;
    if (run && Date.parse(run.startedAt) >= Date.parse(queue.createdAt) && Date.parse(run.startedAt) <= Date.parse(queue.updatedAt) && activeRun(run)) {
      if (run.threadId.startsWith(RESERVED_PREFIX)) await deps.t3.store.updateAgentRunState(taskId, { state: "stopped", now: now(deps) });
      else await stopTaskT3Run(deps.t3, taskId);
    }
  }
  for (let entry of entries) {
    const currentEntry = await queueStore(deps).findActiveEntryForTask(entry.taskId);
    if (currentEntry && currentEntry.queueId !== queue.id) continue;
    const run = await deps.t3.store.getAgentRunByTaskId(entry.taskId);
    const neverStarted = !ownsRun(entry, run) || run.threadId.startsWith("queued:") || run.threadId.startsWith(RESERVED_PREFIX);
    if (entry.state === "merged") entry = await updateEntry(deps, entry, "done");
    else if (!TERMINAL_ENTRIES.has(entry.state)) entry = await updateEntry(deps, entry, "cancelled", "Queue cancelled");
    if (neverStarted && entry.umbrellaTaskId) {
      const task = await deps.t3.storage.getTask(entry.taskId);
      if (task?.parentId === entry.umbrellaTaskId) await deps.t3.storage.updateTask(task.id, { parentId: null }, { actor: "work-queue" });
    }
  }
}

async function dispatchQueue(deps: WorkQueueDispatchDeps, queue: WorkQueue): Promise<void> {
  let entries = await queueStore(deps).listEntries(queue.id);
  if (queue.state === "cancelled") return cancelQueue(deps, queue, entries);
  entries = await Promise.all(entries.map((entry) => reconcileEntry(deps, entry)));
  if (queue.state !== "active") return;
  const startedUmbrellas = new Set<string>();
  for (let entry of entries) {
    if (TERMINAL_ENTRIES.has(entry.state) || entry.state === "merged") continue;
    const task = await deps.t3.storage.getTask(entry.taskId);
    if (!task || FINISHED_TASKS.has(task.status) || task.projectId !== entry.lane || (task.parentId ?? null) !== entry.umbrellaTaskId) {
      if (entry.state !== "running") {
        const run = await deps.t3.store.getAgentRunByTaskId(entry.taskId);
        if (ownsRun(entry, run) && (run.threadId.startsWith("queued:") || run.threadId.startsWith(RESERVED_PREFIX))) {
          await deps.t3.store.requests.cancel(entry.taskId, now(deps));
        }
        await updateEntry(deps, entry, "skipped", !task ? "Task no longer exists" : FINISHED_TASKS.has(task.status) ? `Task is ${task.status}` : task.projectId !== entry.lane ? "Task moved to another project" : "Task was reparented");
      }
      continue;
    }
    const mapping = await deps.t3.store.getProjectMapping(entry.lane);
    const connection = await deps.t3.store.getConnection(mapping?.hostId ?? undefined);
    if (connection && connection.expiresAt <= now(deps)) {
      await updateEntry(deps, entry, entry.state, "T3 sign-in expired; reconnect before resuming the queue");
      const paused = await queueStore(deps).transitionQueue(queue.id, "paused", now(deps));
      await deps.t3.publishRealtime?.({ type: "work_queue.updated", queue: paused });
      return;
    }
    const reason = await holdReason(deps, { queue, entry, umbrella: false }, task);
    if (reason) {
      await updateEntry(deps, entry, entry.state === "ready" ? "waiting" : entry.state, reason);
      continue;
    }
    const targetId = entry.umbrellaTaskId ?? entry.taskId;
    if (entry.umbrellaTaskId && startedUmbrellas.has(targetId)) continue;
    const run = await deps.t3.store.getAgentRunByTaskId(targetId);
    if (ownsRun(entry, run) && !run.threadId.startsWith(RESERVED_PREFIX)) continue;
    if (entry.state === "running") continue;
    try {
      if (entry.state === "waiting") entry = await updateEntry(deps, entry, "ready");
      const result = await launchTaskInT3(deps.t3, {
        taskRef: targetId, workspaceStrategy: "worktree", actor: queue.createdBy,
        ...(entry.umbrellaTaskId ? {} : entry.resolvedSelection ?? {}),
      });
      if (entry.umbrellaTaskId) startedUmbrellas.add(targetId);
      else if (result.run.state !== "queued") await runningEntry(deps, entry);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await releaseWorkQueueReservation(deps, targetId);
      if (error instanceof WorkQueueHeldError) {
        await updateEntry(deps, entry, "waiting", message);
      } else if (USAGE_LIMIT_PATTERN.test(message)) {
        await updateEntry(deps, entry, entry.state, `${USAGE_PREFIX}${message}`);
      } else if (SIGN_IN_PATTERN.test(message)) {
        await updateEntry(deps, entry, entry.state, "T3 sign-in expired; reconnect before resuming the queue");
        const paused = await queueStore(deps).transitionQueue(queue.id, "paused", now(deps));
        await deps.t3.publishRealtime?.({ type: "work_queue.updated", queue: paused });
        return;
      } else {
        const failed = await runningEntry(deps, entry);
        await updateEntry(deps, failed, "failed", `Launch failed: ${message}`);
        console.error("work queue launch failed", { queueId: queue.id, entryId: entry.id, error });
      }
    }
  }
  const current = await queueStore(deps).listEntries(queue.id);
  if (current.length && current.every((entry) => ["done", "skipped", "cancelled"].includes(entry.state))) {
    const done = await queueStore(deps).transitionQueue(queue.id, "done", now(deps));
    await deps.t3.publishRealtime?.({ type: "work_queue.updated", queue: done });
  }
}

/** Frees a slot reserved for a launch that failed before its queued request replaced it. */
async function releaseWorkQueueReservation(deps: WorkQueueDispatchDeps, taskId: string): Promise<void> {
  const run = await deps.t3.store.getAgentRunByTaskId(taskId);
  if (!run?.threadId.startsWith(RESERVED_PREFIX) || !isActiveAgentRunState(run.state)) return;
  await deps.t3.store.updateAgentRunState(taskId, { state: "failed", now: now(deps) });
}

async function releaseStaleReservations(deps: WorkQueueDispatchDeps): Promise<void> {
  await deps.db.prepare(`UPDATE agent_runs SET state = 'failed', updated_at = ?
    WHERE thread_id LIKE ? AND state = 'queued' AND updated_at < ? AND task_id IN
      (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.org_id = ?)`)
    .bind(now(deps), `${RESERVED_PREFIX}%`, now(deps) - STALE_RESERVATION_MS, deps.orgId).run();
}

/**
 * Queues the dispatcher still has work on: active and paused queues with unfinished entries, and
 * cancelled queues that still hold unfinished entries or runs (child or queue umbrella) started
 * before the cancel. Finished history is never scanned again.
 */
async function listQueueIdsNeedingDispatch(deps: WorkQueueContext): Promise<Set<string>> {
  const rows = await deps.db.prepare(`SELECT q.id AS id FROM work_queues q WHERE q.org_id = ? AND (
      (q.state IN ('active', 'paused', 'cancelled') AND EXISTS (SELECT 1 FROM work_queue_items i
        WHERE i.queue_id = q.id AND i.state IN ${ACTIVE_ENTRY_STATES_SQL}))
      OR (q.state = 'active' AND NOT EXISTS (SELECT 1 FROM work_queue_items i
        WHERE i.queue_id = q.id AND i.state IN ${ACTIVE_ENTRY_STATES_SQL}))
      OR (q.state = 'cancelled' AND EXISTS (SELECT 1 FROM work_queue_items i JOIN agent_runs r
        ON r.task_id = i.task_id OR r.task_id = i.umbrella_task_id
        WHERE i.queue_id = q.id AND r.state IN ${ACTIVE_STATES_SQL}
          AND r.started_at >= q.created_at AND r.started_at <= q.updated_at)))`)
    .bind(deps.orgId).all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

/** Cheap pre-check so ordinary requests skip the dispatcher when no queue has work. */
export async function hasWorkQueuesNeedingDispatch(deps: WorkQueueContext): Promise<boolean> {
  return (await listQueueIdsNeedingDispatch(deps)).size > 0;
}

export async function dispatchWorkQueues(deps: WorkQueueDispatchDeps): Promise<void> {
  const t3: T3ServiceDeps = { ...deps.t3, workQueue: { db: deps.db, orgId: deps.orgId }, dispatchingWorkQueue: true };
  await releaseStaleReservations(deps);
  const pending = await listQueueIdsNeedingDispatch(deps);
  if (pending.size === 0) return;
  for (const queue of await queueStore(deps).listQueues()) {
    if (!pending.has(queue.id)) continue;
    deps.signal?.throwIfAborted();
    try {
      await dispatchQueue({ ...deps, t3 }, queue);
    } catch (error) {
      console.error("work queue dispatch failed", { queueId: queue.id, error });
    }
  }
}

/**
 * Dispatch hook for T3 run changes and merge reports. It never throws: a dispatcher failure must
 * not fail the run update or merge report that triggered it (the cron retries).
 */
export async function dispatchWorkQueuesForT3(deps: T3ServiceDeps): Promise<void> {
  if (deps.dispatchingWorkQueue) return;
  try {
    const context = await workQueueContext(deps);
    if (context) await dispatchWorkQueues({ ...context, t3: deps });
  } catch (error: unknown) {
    console.error("work queue dispatch after a T3 change failed", { error });
  }
}
