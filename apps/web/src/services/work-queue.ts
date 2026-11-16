import type {
  RunProfileSource,
  T3ModelSelection,
  WorkQueue,
  WorkQueueClassification,
  WorkQueueEntry,
  WorkQueueUnknownKey,
  WorkQueueWaveSkip,
} from "@bitig/core";

/**
 * REST client for the work queue (#BIT-202): plan a prompt into a preview, then confirm it into a
 * queue. The view types mirror what the worker's work queue service returns.
 */

const BASE_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  "X-Bitig-Request": "true",
} as const;

const ACTIVE_ORG_STORAGE_KEY = "bitig:active-org";
const PLAN_PATH = "/api/work-queue/plan";
const CONFIRM_PATH = "/api/work-queue";
const NOTHING_TO_QUEUE_ERROR = "nothing_to_queue";

/** How the model fallback of the prompt parser ended. */
export type WorkQueueFallbackStatus = "not_needed" | "applied" | "router_unavailable" | "failed";

export interface WorkQueueRunChoice {
  readonly level: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Who chose the level: a stored profile's source, or `default` when no profile decided it. */
  readonly source: RunProfileSource | "default";
  /** Set when the level is a fallback rather than a profile or router choice. */
  readonly note?: string | undefined;
  readonly selection: T3ModelSelection | null;
}

export interface WorkQueuePlanRow {
  readonly code: string;
  readonly raw: string;
  readonly classification: WorkQueueClassification;
  /** Whether confirming now would put this task on the queue. */
  readonly queueable: boolean;
  readonly taskId?: string | undefined;
  readonly title?: string | undefined;
  readonly projectId?: string | undefined;
  readonly isUmbrella?: boolean | undefined;
  /** Codes or text the classification refers to (blockers, the parent, the needs-human note). */
  readonly related?: readonly string[] | undefined;
  readonly run?: WorkQueueRunChoice | undefined;
}

export interface WorkQueuePlanWave {
  readonly number: number;
  readonly codes: readonly string[];
  readonly skipped: readonly WorkQueueWaveSkip[];
}

export interface WorkQueuePlanLane {
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly needsQueueUmbrella: boolean;
  readonly codes: readonly string[];
  readonly waves: readonly WorkQueuePlanWave[];
}

export interface WorkQueueParseView {
  readonly items: readonly { readonly code: string; readonly raw: string }[];
  readonly unknownKeys: readonly WorkQueueUnknownKey[];
  readonly unparsed: readonly string[];
  readonly warnings: readonly string[];
  readonly fallback: WorkQueueFallbackStatus;
}

export interface WorkQueueRoutingSummary {
  /** Whether the organisation's AI router is configured and enabled. */
  readonly enabled: boolean;
  readonly attempted: number;
  readonly failed: number;
}

export interface WorkQueuePlanView {
  readonly parse: WorkQueueParseView;
  readonly rows: readonly WorkQueuePlanRow[];
  readonly lanes: readonly WorkQueuePlanLane[];
  readonly routing: WorkQueueRoutingSummary;
}

export interface WorkQueueEntryView extends WorkQueueEntry {
  readonly taskCode?: string | undefined;
  readonly taskTitle?: string | undefined;
}

export interface WorkQueueView extends WorkQueue {
  readonly entries: readonly WorkQueueEntryView[];
}

export interface WorkQueueUmbrellaView {
  readonly projectId: string;
  readonly taskId: string;
  readonly code?: string | undefined;
  readonly title: string;
  readonly children: readonly string[];
}

export interface WorkQueueConfirmResult {
  readonly queue: WorkQueueView;
  readonly umbrellas: readonly WorkQueueUmbrellaView[];
  /** Codes approved by this confirm, as the signed-in person. */
  readonly approved: readonly string[];
  readonly plan: WorkQueuePlanView;
}

/** A person's level, model or effort choice for one task; saved as a `manual` run profile on confirm. */
export interface WorkQueueRunOverride {
  readonly code: string;
  readonly level?: string;
  readonly effort?: string;
  readonly selection?: T3ModelSelection;
}

export interface PlanWorkQueueInput {
  readonly prompt: string;
  /** Edited code list from the preview; when present the prompt is not parsed again. */
  readonly items?: readonly string[] | undefined;
}

export interface ConfirmWorkQueueInput {
  readonly prompt: string;
  readonly items: readonly string[];
  /** Codes of pending tasks the person ticked "Approve" for. */
  readonly approvals: readonly string[];
  readonly overrides: readonly WorkQueueRunOverride[];
}

export class WorkQueueApiError extends Error {
  override readonly name = "WorkQueueApiError";
  readonly status: number;
  /** The server's fresh plan, sent when a confirm found nothing left to queue. */
  readonly plan: WorkQueuePlanView | undefined;

  constructor(status: number, message: string, plan?: WorkQueuePlanView) {
    super(message);
    this.status = status;
    this.plan = plan;
  }
}

function requestHeaders(): Record<string, string> {
  const result: Record<string, string> = { ...BASE_HEADERS };
  if (typeof window === "undefined") return result;
  try {
    const org = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    if (org) result["X-Bitig-Org"] = org;
  } catch (err) {
    console.warn("Could not read the active organisation", err);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks the parts of a plan the preview reads, so an unexpected answer fails as an error instead of breaking the view. */
function isPlanView(body: unknown): body is WorkQueuePlanView {
  if (!isRecord(body)) return false;
  const { parse, rows, lanes, routing } = body;
  return (
    isRecord(parse) &&
    Array.isArray(parse.items) &&
    Array.isArray(parse.unknownKeys) &&
    Array.isArray(parse.unparsed) &&
    Array.isArray(parse.warnings) &&
    Array.isArray(rows) &&
    Array.isArray(lanes) &&
    isRecord(routing)
  );
}

function isConfirmResult(body: unknown): body is WorkQueueConfirmResult {
  return (
    isRecord(body) &&
    isRecord(body.queue) &&
    Array.isArray(body.queue.entries) &&
    Array.isArray(body.umbrellas) &&
    Array.isArray(body.approved) &&
    isPlanView(body.plan)
  );
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

async function toApiError(response: Response, fallback: string): Promise<WorkQueueApiError> {
  const statusMessage = `${fallback} (HTTP ${String(response.status)})`;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON: report the plain HTTP status instead.
    return new WorkQueueApiError(response.status, statusMessage);
  }
  if (!isRecord(body)) return new WorkQueueApiError(response.status, statusMessage);
  const firstIssue = Array.isArray(body.details) ? (body.details as unknown[]).find(isRecord) : undefined;
  const message =
    nonBlank(body.message) ??
    nonBlank(firstIssue?.message) ??
    // `nothing_to_queue` always carries a message; other codes are not written for people.
    statusMessage;
  const plan = body.error === NOTHING_TO_QUEUE_ERROR && isPlanView(body.plan) ? body.plan : undefined;
  return new WorkQueueApiError(response.status, message, plan);
}

async function post<T>(
  path: string,
  payload: unknown,
  fallback: string,
  guard: (body: unknown) => body is T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: requestHeaders(),
    credentials: "same-origin",
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await toApiError(response, fallback);
  const body: unknown = await response.json();
  if (!guard(body)) throw new WorkQueueApiError(response.status, `${fallback}: unexpected response`);
  return body;
}

/** Builds the plan preview for a prompt, or for an edited code list. Nothing is queued. */
export function planWorkQueue(input: PlanWorkQueueInput, signal?: AbortSignal): Promise<WorkQueuePlanView> {
  return post(
    PLAN_PATH,
    { prompt: input.prompt, ...(input.items ? { items: input.items } : {}) },
    "Could not plan the work queue",
    isPlanView,
    signal,
  );
}

/** Queues the listed tasks, approving the ticked ones and saving run overrides as `manual` profiles. */
export function confirmWorkQueue(input: ConfirmWorkQueueInput, signal?: AbortSignal): Promise<WorkQueueConfirmResult> {
  return post(
    CONFIRM_PATH,
    { prompt: input.prompt, items: input.items, approvals: input.approvals, overrides: input.overrides },
    "Could not queue the tasks",
    isConfirmResult,
    signal,
  );
}

const QUEUES_PATH = "/api/work-queues";
const ITEMS_PATH = "/api/work-queue-items";

function isQueueView(value: unknown): value is WorkQueueView {
  return isRecord(value) && typeof value.id === "string" && typeof value.state === "string" && Array.isArray(value.entries);
}

function isEntryView(value: unknown): value is WorkQueueEntryView {
  return isRecord(value) && typeof value.id === "string" && typeof value.queueId === "string" && typeof value.state === "string";
}

function isQueueList(body: unknown): body is WorkQueueView[] {
  return Array.isArray(body) && body.every(isQueueView);
}

/** Calls one of the queue endpoints with no body and checks the answer. */
async function send<T>(
  method: "GET" | "POST",
  path: string,
  fallback: string,
  guard: (body: unknown) => body is T,
  payload?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: requestHeaders(),
    credentials: "same-origin",
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw await toApiError(response, fallback);
  const body: unknown = await response.json();
  if (!guard(body)) throw new WorkQueueApiError(response.status, `${fallback}: unexpected response`);
  return body;
}

/** Open work queues (planning, active, paused) with their entries, for the dashboard panel. */
export function fetchWorkQueues(signal?: AbortSignal): Promise<WorkQueueView[]> {
  return send("GET", QUEUES_PATH, "Could not load the work queues", isQueueList, undefined, signal);
}

/** Pauses an active queue: no new entries start until it is resumed. */
export function pauseWorkQueue(queueId: string): Promise<WorkQueueView> {
  return send("POST", `${QUEUES_PATH}/${encodeURIComponent(queueId)}/pause`, "Could not pause the queue", isQueueView, {});
}

/** Resumes a paused queue. */
export function resumeWorkQueue(queueId: string): Promise<WorkQueueView> {
  return send("POST", `${QUEUES_PATH}/${encodeURIComponent(queueId)}/resume`, "Could not resume the queue", isQueueView, {});
}

/** Cancels a queue; unstarted entries are cancelled and running ones finish as they are. */
export function cancelWorkQueue(queueId: string): Promise<WorkQueueView> {
  return send("POST", `${QUEUES_PATH}/${encodeURIComponent(queueId)}/cancel`, "Could not cancel the queue", isQueueView, {});
}

/** Takes a waiting or ready entry out of its queue. */
export function skipWorkQueueItem(entryId: string): Promise<WorkQueueEntryView> {
  return send("POST", `${ITEMS_PATH}/${encodeURIComponent(entryId)}/skip`, "Could not skip the task", isEntryView, {});
}

/** Re-queues a failed, skipped or cancelled entry, optionally on a different run level. */
export function retryWorkQueueItem(entryId: string, level?: string): Promise<WorkQueueEntryView> {
  return send(
    "POST",
    `${ITEMS_PATH}/${encodeURIComponent(entryId)}/retry`,
    "Could not retry the task",
    isEntryView,
    level !== undefined ? { level } : {},
  );
}
