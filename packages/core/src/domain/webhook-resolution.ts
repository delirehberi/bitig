import type { OperationOptions, StorageProvider } from "../storage/provider";
import { blockedByFromError, checkStatusChange } from "./status-gate";
import type { Webhook } from "./types";
import { sentryTaskReferences } from "./webhooks";

const SENTRY_ACTOR = "sentry";
const RESOLUTION_MESSAGE = "Marked done because the linked issue was resolved in Sentry.";

export interface WebhookResolutionResult {
  readonly status: "resolved";
  readonly completedTaskIds: string[];
  readonly blockedTaskIds: string[];
}

/** Resolve only exact issue references in this webhook's project; never guess from a title. */
export async function resolveSentryTasks(
  storage: StorageProvider,
  webhook: Webhook,
  payload: unknown,
  opts?: OperationOptions,
): Promise<WebhookResolutionResult> {
  const result: WebhookResolutionResult = { status: "resolved", completedTaskIds: [], blockedTaskIds: [] };
  const references = sentryTaskReferences(webhook, payload);
  if (references.length === 0) return result;
  const options = { ...opts, actor: SENTRY_ACTOR };
  const tasks = await storage.getTasks({ projectId: webhook.projectId }, options);
  for (const task of tasks) {
    if (task.status === "done" || task.status === "archived") continue;
    const lines = task.description.split("\n");
    if (!references.some((reference) => lines.includes(reference))) continue;
    try {
      await checkStatusChange(storage, task.id, "done", "Sentry resolution", { signal: opts?.signal });
    } catch (error: unknown) {
      if (blockedByFromError(error) === undefined) throw error;
      result.blockedTaskIds.push(task.id);
      continue;
    }
    // Write the explanation first. A retry after a failed status write reuses it.
    const comments = await storage.getComments(task.id, options);
    if (!comments.some((comment) => comment.author === SENTRY_ACTOR && comment.body === RESOLUTION_MESSAGE)) {
      await storage.addComment({ taskId: task.id, author: SENTRY_ACTOR, authorType: "agent", body: RESOLUTION_MESSAGE }, options);
    }
    // An external resolution needs no triage approval; dependency gates above still apply.
    await storage.updateTask(task.id, { status: "done", pendingApproval: null }, options);
    result.completedTaskIds.push(task.id);
  }
  return result;
}
