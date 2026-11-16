import type { Project, T3ModelCapability, T3ModelSelection } from "@bitig/core";
import type {
  WorkQueuePlanLane,
  WorkQueuePlanRow,
  WorkQueuePlanView,
  WorkQueueRunOverride,
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
