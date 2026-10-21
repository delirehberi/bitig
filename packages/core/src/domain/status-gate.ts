/**
 * The rules for starting or completing a task, shared by MCP, the REST API, the CLI and the web
 * app: a task waiting on unfinished dependencies is refused, and so (for agents) is a task a
 * person has not approved. Agents can never override; a person can, and the override is logged.
 */
import type { OperationOptions, StorageProvider } from "../storage/provider";
import { blockingTasks } from "./dependencies";
import { ValidationError } from "./errors";
import { withTaskCodes } from "./ticket-codes";
import type { Task, TaskStatus } from "./types";

/** Statuses a task can only move to once every dependency is finished (and, for agents, once approved). */
export const GATED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["in_progress", "done"]);

export const AWAITING_APPROVAL_MESSAGE =
  "Task is awaiting human approval. A person must approve it in Bitig before it can be started or completed.";

/** The `params` key of a blocked-task issue that lists the blockers, so clients can offer an override. */
const BLOCKED_BY_PARAM = "blockedBy";

export interface StatusChangeOptions {
  readonly signal?: OperationOptions["signal"] | undefined;
  /** Refuse while the task awaits a person's approval. Set for agents. */
  readonly requireApproval?: boolean;
  /** A person confirmed the change despite unfinished dependencies. Never set for agents. */
  readonly overrideBlocked?: boolean;
}

/** How a blocker is named to people: its ticket code, or its ID when it has none. */
function blockerLabel(task: Task & { readonly code?: string }): string {
  return task.code ?? task.id;
}

/** The unfinished tasks `task` depends on, with their ticket codes, in `dependsOn` order. */
export async function findBlockingTasks(
  storage: StorageProvider,
  task: Pick<Task, "dependsOn">,
  opts?: OperationOptions,
): Promise<(Task & { readonly code?: string })[]> {
  const ids = task.dependsOn ?? [];
  if (ids.length === 0) return [];
  const loaded = await Promise.all(ids.map((id) => storage.getTask(id, opts)));
  const byId = new Map(loaded.filter((t) => t !== null).map((t) => [t.id, t]));
  const blockers = blockingTasks(task, byId);
  if (blockers.length === 0) return [];
  return withTaskCodes(blockers, await storage.getProjects(opts));
}

/** The `ValidationError` for a status change refused because of unfinished dependencies. */
export function blockedTaskError(context: string, blockedBy: readonly string[], status: TaskStatus): ValidationError {
  const verb = status === "done" ? "completed" : "started";
  return new ValidationError(context, [
    {
      code: "custom",
      path: ["status"],
      message: `Task is blocked by unfinished dependencies: ${blockedBy.join(", ")}. It cannot be ${verb} until they are done or archived.`,
      input: status,
      params: { [BLOCKED_BY_PARAM]: [...blockedBy] },
    },
  ]);
}

/**
 * The blockers named by a `blockedTaskError`, or `undefined` for any other error. Survives the
 * REST round trip, since `ApiStorage` rebuilds validation errors from the response's issues.
 */
export function blockedByFromError(err: unknown): string[] | undefined {
  if (!(err instanceof ValidationError)) return undefined;
  for (const issue of err.issues) {
    if (issue.code !== "custom") continue;
    const value: unknown = issue.params?.[BLOCKED_BY_PARAM];
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value;
  }
  return undefined;
}

/**
 * Checks moving task `id` to `status` before the caller writes it. Rejects with a
 * `ValidationError` when an agent's task awaits approval (`requireApproval`), or when unfinished
 * dependencies block it and nobody overrode them. Resolves to the blockers that were overridden,
 * which the caller passes on as `overrideBlockedBy`; empty when nothing blocks the change.
 * Leaving a status, keeping it, or an unknown ID (left for storage to report) is never refused.
 */
export async function checkStatusChange(
  storage: StorageProvider,
  id: string,
  status: TaskStatus,
  context: string,
  opts?: StatusChangeOptions,
): Promise<string[]> {
  if (!GATED_STATUSES.has(status)) return [];
  const readOpts = opts?.signal === undefined ? undefined : { signal: opts.signal };
  const task = await storage.getTask(id, readOpts);
  if (task === null || task.status === status) return [];
  if (opts?.requireApproval === true && task.pendingApproval === true) {
    throw new ValidationError(context, [{ code: "custom", path: ["status"], message: AWAITING_APPROVAL_MESSAGE }]);
  }
  const blockedBy = (await findBlockingTasks(storage, task, readOpts)).map(blockerLabel);
  if (blockedBy.length > 0 && opts?.overrideBlocked !== true) throw blockedTaskError(context, blockedBy, status);
  return blockedBy;
}
