import {
  isOpenWorkQueueState,
  type Project,
  type RealtimeEvent,
  type RunLevel,
  type T3ModelCapability,
  type T3ModelSelection,
  type WorkQueue,
  type WorkQueueEntryState,
  type WorkQueueState,
} from "@bitig/core";
import type {
  WorkQueueEntryView,
  WorkQueuePlanLane,
  WorkQueuePlanRow,
  WorkQueuePlanView,
  WorkQueueRunOverride,
  WorkQueueView,
} from "../../services/work-queue";

/** Option IDs T3 models use for reasoning effort; the worker reads the same set. */
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort", "thinkingEffort"]);

/** A person's edits to one row of the preview; only fields they changed are set. */
export interface RowOverrideDraft {
  readonly level?: string;
  readonly effort?: string;
  readonly selection?: T3ModelSelection;
}

/** What a row says about its task, from the plan's classification. */
export function describeRowStatus(row: WorkQueuePlanRow): string {
  const related = (row.related ?? []).join(", ");
  switch (row.classification) {
    case "ready":
      return "Ready";
    case "needs_approval":
      return "Needs approval";
    case "after_queued_task":
      return related ? `After ${related}` : "Waits on a queued task";
    case "waits_on_unqueued_task":
      return `Waits on ${related} (not queued)`;
    case "already_running":
      return "Already running";
    case "already_queued":
      return "Already queued";
    case "done":
      return "Done, skipped";
    case "not_found":
      return `${row.code} doesn't exist`;
    case "project_not_connected":
      return `${projectKeyOf(row.code)} is not connected to a T3 project`;
    case "needs_person":
      return related ? `Waiting on you: ${related}` : "Waiting on you";
    case "unlisted_parent":
      return `Part of ${related}`;
    case "folded":
      return `Runs under ${related}`;
    case "dependency_cycle":
      return related ? `Dependency cycle with ${related}` : "Dependency cycle";
  }
}

/** `BIT` for `BIT-92`. */
export function projectKeyOf(code: string): string {
  const dash = code.lastIndexOf("-");
  return dash > 0 ? code.slice(0, dash) : code;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites every reference to an unknown project key in the prompt with the chosen key, keeping the
 * rest of the text: `KOM-03` becomes `KMZ-03`, `kom 3` becomes `KMZ 3`. Only keys followed by a
 * number change, so a word like "komodo" is left alone.
 */
export function replacePromptKey(prompt: string, unknownKey: string, replacement: string): string {
  const pattern = new RegExp(`(^|[^A-Za-z0-9])#?${escapeRegExp(unknownKey)}(?=[\\s-]*[0-9])`, "gi");
  return prompt.replace(pattern, (_match, lead: string) => `${lead}${replacement}`);
}

/** "KOM is not a project key. Did you mean KMZ (Komuz)?" */
export function unknownKeyMessage(key: string, suggestions: readonly string[], projects: readonly Project[]): string {
  const base = `${key} is not a project key.`;
  if (suggestions.length === 0) return base;
  return `${base} Did you mean ${suggestions.map((suggestion) => suggestionLabel(suggestion, projects)).join(" or ")}?`;
}

export function suggestionLabel(key: string, projects: readonly Project[]): string {
  const project = projects.find((candidate) => candidate.key?.toUpperCase() === key.toUpperCase());
  return project ? `${key} (${project.name})` : key;
}

/** The code list after swapping one code for another, without duplicates and in the original order. */
export function replaceCode(codes: readonly string[], from: string, to: string): string[] {
  const next: string[] = [];
  for (const code of codes) {
    const value = code === from ? to : code;
    if (!next.includes(value)) next.push(value);
  }
  return next;
}

/** The code list with extra codes appended, skipping ones already listed. */
export function addCodes(codes: readonly string[], extra: readonly string[]): string[] {
  const next = [...codes];
  for (const code of extra) if (!next.includes(code)) next.push(code);
  return next;
}

/** Rows that can be approved from the preview. */
export function approvableRows(plan: WorkQueuePlanView): WorkQueuePlanRow[] {
  return plan.rows.filter((row) => row.classification === "needs_approval" && row.taskId !== undefined);
}

/** Codes a confirm would queue: queueable rows plus pending rows the person ticked. */
export function queuedCodes(plan: WorkQueuePlanView, approvals: ReadonlySet<string>): string[] {
  return plan.rows
    .filter((row) => row.queueable || (row.classification === "needs_approval" && approvals.has(row.code)))
    .map((row) => row.code);
}

function waveEntry(code: string, rowsByCode: ReadonlyMap<string, WorkQueuePlanRow>, previousSkip: string | undefined) {
  const row = rowsByCode.get(code);
  if (row?.classification === "after_queued_task" && row.related && row.related.length > 0) {
    return `${code} after ${row.related.join(", ")}`;
  }
  return previousSkip ? `${code} (${previousSkip})` : code;
}

/**
 * One line per lane: "Wave 1: BIT-92, BIT-93 · Wave 2: BIT-94 after BIT-92". A task held back in an
 * earlier wave for a reason other than a dependency carries that reason (e.g. overlapping touches).
 */
export function describeLaneWaves(lane: WorkQueuePlanLane, rows: readonly WorkQueuePlanRow[]): string {
  const rowsByCode = new Map(rows.map((row) => [row.code, row]));
  const skipMessages = new Map<string, string>();
  const parts: string[] = [];
  for (const wave of lane.waves) {
    if (wave.codes.length > 0) {
      const entries = wave.codes.map((code) => waveEntry(code, rowsByCode, skipMessages.get(code)));
      parts.push(`Wave ${String(wave.number)}: ${entries.join(", ")}`);
    }
    for (const skip of wave.skipped) {
      if (skip.reason !== "dependency") skipMessages.set(skip.code, skip.message);
    }
  }
  return parts.join(" · ");
}

/** The capability of a model, matched by provider instance and model. */
export function findCapability(
  capabilities: readonly T3ModelCapability[],
  providerInstanceId: string | null | undefined,
  model: string | null | undefined,
): T3ModelCapability | undefined {
  if (!providerInstanceId || !model) return undefined;
  return capabilities.find((cap) => cap.providerInstanceId === providerInstanceId && cap.model === model);
}

/** Effort values a model accepts, or none when it has no effort option. */
export function effortValues(capability: T3ModelCapability | undefined): string[] {
  const option = capability?.options?.find((candidate) => EFFORT_OPTION_IDS.has(candidate.id));
  return (option?.values ?? []).filter((value): value is string => typeof value === "string");
}

/** Overrides for the rows a confirm would queue, leaving out rows nobody edited. */
export function buildOverrides(
  drafts: ReadonlyMap<string, RowOverrideDraft>,
  codes: readonly string[],
): WorkQueueRunOverride[] {
  return codes.flatMap((code) => {
    const draft = drafts.get(code);
    if (!draft) return [];
    const override: WorkQueueRunOverride = {
      code,
      ...(draft.level !== undefined ? { level: draft.level } : {}),
      ...(draft.effort !== undefined ? { effort: draft.effort } : {}),
      ...(draft.selection !== undefined ? { selection: draft.selection } : {}),
    };
    return Object.keys(override).length > 1 ? [override] : [];
  });
}

/** Warnings from parsing and routing a person should see before they confirm. */
export function planWarnings(plan: WorkQueuePlanView): string[] {
  const warnings = [...plan.parse.warnings];
  if (plan.parse.unparsed.length > 0) {
    warnings.push(`Not understood: ${plan.parse.unparsed.join(", ")}`);
  }
  if (plan.routing.failed > 0) {
    const count = plan.routing.failed;
    warnings.push(
      `The AI router could not suggest a level for ${String(count)} ${count === 1 ? "task" : "tasks"}; the default level applies.`,
    );
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Queue panel (#BIT-206)
// ---------------------------------------------------------------------------

export const QUEUE_STATE_LABELS: Record<WorkQueueState, string> = {
  planning: "Planning",
  active: "Active",
  paused: "Paused",
  done: "Done",
  cancelled: "Cancelled",
};

export const ENTRY_STATE_LABELS: Record<WorkQueueEntryState, string> = {
  waiting: "Waiting",
  ready: "Ready",
  running: "Running",
  merged: "Merged",
  done: "Done",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
};

/** Longest prompt shown as a queue's title before it is cut. */
export const QUEUE_TITLE_MAX_LENGTH = 80;
const ELLIPSIS = "…";

/** Which queue-level controls a queue in this state accepts; mirrors the worker's queue transitions. */
export function queueControls(state: WorkQueueState): { pause: boolean; resume: boolean; cancel: boolean } {
  return {
    pause: state === "active",
    resume: state === "paused",
    cancel: state === "planning" || state === "active" || state === "paused",
  };
}

/** Skip is offered only while the task has not started. */
export function canSkipEntry(state: WorkQueueEntryState): boolean {
  return state === "waiting" || state === "ready";
}

/** Retry is offered only for terminal entries that did not finish their work. */
export function canRetryEntry(state: WorkQueueEntryState): boolean {
  return state === "failed" || state === "skipped" || state === "cancelled";
}

/** A prompt cut to a title, with the ellipsis counted inside the limit. */
export function queueTitle(prompt: string): string {
  const text = prompt.replace(/\s+/g, " ").trim();
  if (text.length <= QUEUE_TITLE_MAX_LENGTH) return text;
  return `${text.slice(0, QUEUE_TITLE_MAX_LENGTH - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

export interface LaneProgress {
  /** Stable key: the lane's project id. */
  readonly lane: string;
  /** Project key for the label, e.g. `BIT`. */
  readonly projectKey: string;
  readonly running: number;
  /** Waiting plus ready: queued but not started. */
  readonly waiting: number;
  readonly merged: number;
  readonly done: number;
  readonly failed: number;
  /** "BIT: 2 running, 3 waiting, 1 merged"; "BIT: nothing active" when every entry is closed. */
  readonly label: string;
}

/**
 * Per-lane counts for one queue. `formatUmbrellaProgress` is not used here: it reads "2 of 5 running"
 * and has no waiting count, while the queue panel shows queued-but-not-started work too.
 */
export function laneProgress(entries: readonly WorkQueueEntryView[]): LaneProgress[] {
  const byLane = new Map<string, WorkQueueEntryView[]>();
  for (const entry of entries) {
    const bucket = byLane.get(entry.lane) ?? [];
    bucket.push(entry);
    byLane.set(entry.lane, bucket);
  }
  return [...byLane.entries()].map(([lane, laneEntries]) => {
    const count = (states: readonly WorkQueueEntryState[]) =>
      laneEntries.filter((entry) => states.includes(entry.state)).length;
    const running = count(["running"]);
    const waiting = count(["waiting", "ready"]);
    const merged = count(["merged"]);
    const done = count(["done"]);
    const failed = count(["failed"]);
    const projectKey = laneEntries.map((entry) => entry.taskCode).find((code) => code !== undefined);
    const key = projectKey ? projectKeyOf(projectKey) : lane;
    const parts: string[] = [];
    if (running > 0) parts.push(`${String(running)} running`);
    if (waiting > 0) parts.push(`${String(waiting)} waiting`);
    if (merged > 0) parts.push(`${String(merged)} merged`);
    if (done > 0) parts.push(`${String(done)} done`);
    if (failed > 0) parts.push(`${String(failed)} failed`);
    const detail = parts.length > 0 ? parts.join(", ") : "nothing active";
    return { lane, projectKey: key, running, waiting, merged, done, failed, label: `${key}: ${detail}` };
  });
}

/**
 * The run level one step above the entry's current one, or null when the current level is unknown
 * or already the highest. The entry stores a model selection, so the level is found by matching it.
 */
export function nextLevelUp(levels: readonly RunLevel[], selection: T3ModelSelection | null): RunLevel | null {
  if (!selection) return null;
  const current = levels.find(
    (level) =>
      level.selection?.providerInstanceId === selection.providerInstanceId && level.selection.model === selection.model,
  );
  if (!current) return null;
  const higher = levels
    .filter((level) => level.order > current.order)
    .sort((a, b) => a.order - b.order);
  return higher[0] ?? null;
}

/** Replaces the queue with the same id, or adds it when open; drops it when it has closed. Null when unknown. */
export function applyQueueUpdate(queues: readonly WorkQueueView[], queue: WorkQueue): readonly WorkQueueView[] | null {
  const index = queues.findIndex((candidate) => candidate.id === queue.id);
  if (!isOpenWorkQueueState(queue.state)) {
    return index < 0 ? queues : queues.filter((candidate) => candidate.id !== queue.id);
  }
  if (index < 0) return null;
  const current = queues[index];
  if (!current) return null;
  return queues.map((candidate, position) => (position === index ? { ...current, ...queue } : candidate));
}

/**
 * Replaces an entry in its queue, keeping the task code and title the list already had when the
 * update does not carry them. Null when the entry's queue is not in the list.
 */
export function applyEntryUpdate(queues: readonly WorkQueueView[], entry: WorkQueueEntryView): readonly WorkQueueView[] | null {
  const index = queues.findIndex((candidate) => candidate.id === entry.queueId);
  const queue = queues[index];
  if (index < 0 || !queue) return null;
  const existing = queue.entries.find((candidate) => candidate.id === entry.id);
  const next: WorkQueueEntryView = {
    ...entry,
    taskCode: entry.taskCode ?? existing?.taskCode,
    taskTitle: entry.taskTitle ?? existing?.taskTitle,
  };
  const entries = existing
    ? queue.entries.map((candidate) => (candidate.id === entry.id ? next : candidate))
    : [...queue.entries, next];
  return queues.map((candidate, position) => (position === index ? { ...queue, entries } : candidate));
}

/**
 * Applies one realtime event to the panel's list. Returns the list unchanged for events the panel
 * does not show, and null when the event refers to a queue the list does not have (the caller reloads).
 */
export function applyRealtimeEvent(queues: readonly WorkQueueView[], event: RealtimeEvent): readonly WorkQueueView[] | null {
  switch (event.type) {
    case "work_queue.updated":
      return applyQueueUpdate(queues, event.queue);
    case "work_queue_item.updated":
      return applyEntryUpdate(queues, event.entry);
    default:
      return queues;
  }
}
