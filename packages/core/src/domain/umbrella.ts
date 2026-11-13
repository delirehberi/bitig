/**
 * Umbrella task child resolution, progress summaries, and API contracts (#BIT-191).
 *
 * Environment-neutral: no Node, DOM or Workers APIs.
 */
import { z } from "zod";
import { compareTasks } from "./entities";
import { extractTaskMentions } from "./mentions";
import {
  MAX_PARALLEL_CHILDREN_MAX,
  type AgentRunChild,
  type AgentRunChildState,
  type ParallelSkipReason,
  type RunSelectionSource,
} from "./run-profile";
import { isActiveAgentRunState, type AgentRun, type AgentRunState } from "./t3";
import { formatTaskCode, parseTaskCode, taskCode } from "./ticket-codes";
import type { Project, Task, TaskStatus } from "./types";

const EXPLICIT_UMBRELLA_TITLE_PATTERN = /(?:^umbrella(?:\s*[:\u2014-]|\s+)|\(umbrella\)|\bumbrella$)/i;

/**
 * Whether `task` carries an explicit umbrella marker (`#umbrella` label, `(umbrella)` in title, or
 * `Umbrella:` / `Umbrella ` title prefix). Does NOT match arbitrary uses of the word "umbrella" in
 * the middle of a leaf task's title (such as "umbrella children panel").
 */
export function hasExplicitUmbrellaMarker(
  task: Pick<Task, "title" | "labels">,
): boolean {
  if (task.labels?.some((label) => label.trim().toLowerCase() === "umbrella")) {
    return true;
  }
  return EXPLICIT_UMBRELLA_TITLE_PATTERN.test(task.title.trim());
}

export interface UmbrellaProgressSummary {
  readonly total: number;
  readonly running: number;
  readonly merged: number;
  readonly done: number;
}

/**
 * Formats umbrella progress for board cards and list rows (#BIT-191), e.g.:
 * - `"2 of 5 running, 1 merged"`
 * - `"2 of 5 running"`
 * - `"0 of 5 running, 3 merged"`
 * - `"0 of 5 running, 2 done"`
 * - `"0 of 5 running"`
 */
export function formatUmbrellaProgress(progress: UmbrellaProgressSummary): string {
  const base = `${String(progress.running)} of ${String(progress.total)} running`;
  if (progress.merged > 0) {
    return `${base}, ${String(progress.merged)} merged`;
  }
  if (progress.done > 0) {
    return `${base}, ${String(progress.done)} done`;
  }
  return base;
}

export interface BuildUmbrellaIndexInput {
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly runs?: readonly AgentRun[] | undefined;
  readonly runChildren?: readonly AgentRunChild[] | undefined;
}

export interface UmbrellaIndex {
  /** Ordered child tasks of `parentTaskId`, or `[]` when `parentTaskId` is not an umbrella task. */
  readonly childrenFor: (parentTaskId: string) => readonly Task[];
  /** Whether `taskId` is recognized as an umbrella task with at least one child task. */
  readonly isUmbrella: (taskId: string) => boolean;
  /** Progress counts for `parentTaskId`, or `undefined` when it is not an umbrella task. */
  readonly progressFor: (parentTaskId: string) => UmbrellaProgressSummary | undefined;
}

function normalizedTaskCode(task: Task, projectById: ReadonlyMap<string, Project>): string | undefined {
  const raw = taskCode(task, projectById.get(task.projectId));
  if (!raw) return undefined;
  const parsed = parseTaskCode(raw);
  return parsed ? formatTaskCode(parsed.key, parsed.number) : undefined;
}

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  if (from === to) return;
  let set = map.get(from);
  if (!set) {
    set = new Set<string>();
    map.set(from, set);
  }
  set.add(to);
}

function sharesElement(a: ReadonlySet<string> | undefined, b: ReadonlySet<string> | undefined): boolean {
  if (!a || !b || a.size === 0 || b.size === 0) return false;
  for (const item of a) {
    if (b.has(item)) return true;
  }
  return false;
}

/**
 * Resolves umbrella tasks and their children across a workspace without false positives when
 * child tasks mention their umbrella parent (`Plan attached to #BIT-183`) or depend on sibling
 * tasks (`#BIT-192` depending on `#BIT-191`).
 *
 * A task `P` is recognized as an umbrella when it has at least one child and any of:
 * 1. Recorded child sessions (`agent_run_children` row with `parentTaskId === P.id`, `agent_runs`
 *    with `parentTaskId === P.id`, or `P`'s `agent_run.waitingForTaskId`),
 * 2. Checklist items mentioning other task codes (`#KEY-N`, how Bitig umbrella checklists are written),
 * 3. An explicit umbrella marker (`#umbrella` label, `(umbrella)` in title, or `Umbrella:` prefix).
 */
export function buildUmbrellaIndex(input: BuildUmbrellaIndexInput): UmbrellaIndex {
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const taskByCode = new Map<string, Task>();
  for (const task of input.tasks) {
    const code = normalizedTaskCode(task, projectById);
    if (code) {
      taskByCode.set(code, task);
    }
  }

  const runByTaskId = new Map<string, AgentRun>();
  for (const run of input.runs ?? []) {
    runByTaskId.set(run.taskId, run);
  }

  const runChildByParent = new Map<string, Map<string, AgentRunChild>>();
  const recordedChildrenByParent = new Map<string, Set<string>>();
  const knownParentsByChild = new Map<string, Set<string>>();

  for (const childRow of input.runChildren ?? []) {
    if (!taskById.has(childRow.parentTaskId) || !taskById.has(childRow.childTaskId)) continue;
    let byChild = runChildByParent.get(childRow.parentTaskId);
    if (!byChild) {
      byChild = new Map<string, AgentRunChild>();
      runChildByParent.set(childRow.parentTaskId, byChild);
    }
    byChild.set(childRow.childTaskId, childRow);
    addEdge(recordedChildrenByParent, childRow.parentTaskId, childRow.childTaskId);
    addEdge(knownParentsByChild, childRow.childTaskId, childRow.parentTaskId);
  }

  for (const run of input.runs ?? []) {
    if (run.parentTaskId && taskById.has(run.parentTaskId) && taskById.has(run.taskId)) {
      addEdge(recordedChildrenByParent, run.parentTaskId, run.taskId);
      addEdge(knownParentsByChild, run.taskId, run.parentTaskId);
    }
    if (run.waitingForTaskId && taskById.has(run.taskId) && taskById.has(run.waitingForTaskId)) {
      addEdge(recordedChildrenByParent, run.taskId, run.waitingForTaskId);
      addEdge(knownParentsByChild, run.waitingForTaskId, run.taskId);
    }
  }

  const checklistChildrenByParent = new Map<string, Set<string>>();
  for (const task of input.tasks) {
    if (!task.checklist || task.checklist.length === 0) continue;
    const ownDeps = new Set(task.dependsOn ?? []);
    const recordedParents = knownParentsByChild.get(task.id);
    for (const item of task.checklist) {
      for (const mention of extractTaskMentions(item.text)) {
        const target = taskByCode.get(mention.code);
        if (!target || target.id === task.id) continue;
        if (ownDeps.has(target.id)) continue;
        if (recordedParents?.has(target.id)) continue;
        addEdge(checklistChildrenByParent, task.id, target.id);
        addEdge(knownParentsByChild, target.id, task.id);
      }
    }
  }

  const resolvedChildrenByParent = new Map<string, readonly Task[]>();
  const progressByParent = new Map<string, UmbrellaProgressSummary>();

  for (const parent of input.tasks) {
    const recorded = recordedChildrenByParent.get(parent.id);
    const checklistChildren = checklistChildrenByParent.get(parent.id);
    const explicitMarker = hasExplicitUmbrellaMarker(parent);

    const isCandidateUmbrella =
      (recorded !== undefined && recorded.size > 0) ||
      (checklistChildren !== undefined && checklistChildren.size > 0) ||
      explicitMarker;

    if (!isCandidateUmbrella) continue;

    const parentOwnDeps = new Set(parent.dependsOn ?? []);
    const parentsOfParent = knownParentsByChild.get(parent.id);
    const childIds = new Set<string>();

    for (const id of recorded ?? []) {
      childIds.add(id);
    }
    for (const id of checklistChildren ?? []) {
      childIds.add(id);
    }

    for (const mention of extractTaskMentions(parent.description)) {
      const target = taskByCode.get(mention.code);
      if (!target || target.id === parent.id) continue;
      if (parentOwnDeps.has(target.id)) continue;
      if (parentsOfParent?.has(target.id)) continue;
      childIds.add(target.id);
    }

    for (const candidate of input.tasks) {
      if (candidate.id === parent.id) continue;
      if (!(candidate.dependsOn ?? []).includes(parent.id)) continue;
      if (parentsOfParent?.has(candidate.id)) continue;
      // Sibling tasks under the same umbrella may depend on each other without making the earlier
      // sibling an umbrella over the later sibling.
      if (sharesElement(parentsOfParent, knownParentsByChild.get(candidate.id))) continue;
      childIds.add(candidate.id);
    }

    if (childIds.size === 0) continue;

    const children = [...childIds]
      .map((id) => taskById.get(id))
      .filter((t): t is Task => t !== undefined)
      .sort(compareTasks);

    if (children.length === 0) continue;

    resolvedChildrenByParent.set(parent.id, children);

    const childRows = runChildByParent.get(parent.id);
    let running = 0;
    let merged = 0;
    let done = 0;

    for (const child of children) {
      const row = childRows?.get(child.id);
      const run = runByTaskId.get(child.id);
      const finishedTask = child.status === "done" || child.status === "archived";
      const activeRun =
        !finishedTask &&
        ((run !== undefined && isActiveAgentRunState(run.state)) ||
          (row?.state === "running" && run === undefined));
      const isMerged = Boolean(row?.mergedAt ?? row?.mergedSha);
      const isDone = finishedTask || row?.state === "done" || isMerged;

      if (activeRun) running += 1;
      if (isMerged) merged += 1;
      if (isDone) done += 1;
    }

    progressByParent.set(parent.id, {
      total: children.length,
      running,
      merged,
      done,
    });
  }

  return {
    childrenFor: (parentTaskId) => resolvedChildrenByParent.get(parentTaskId) ?? [],
    isUmbrella: (taskId) => resolvedChildrenByParent.has(taskId),
    progressFor: (parentTaskId) => progressByParent.get(parentTaskId),
  };
}

// ---------------------------------------------------------------------------
// Umbrella Children API Contracts (#BIT-191)
// ---------------------------------------------------------------------------

export interface UmbrellaChildWaitingReason {
  readonly reason: ParallelSkipReason;
  readonly detail: string;
  readonly blockingTaskId?: string | undefined;
  readonly blockingTaskCode?: string | undefined;
  readonly overlappingPath?: string | undefined;
}

export interface UmbrellaChildItem {
  readonly taskId: string;
  readonly code?: string | undefined;
  readonly title: string;
  readonly taskStatus: TaskStatus;
  readonly pendingApproval?: boolean | undefined;
  readonly needsHuman?: string | undefined;
  readonly childState?: AgentRunChildState | undefined;
  readonly runState?: AgentRunState | undefined;
  readonly isRunning: boolean;
  readonly threadId?: string | undefined;
  readonly link?: string | undefined;
  readonly levelKey?: string | undefined;
  readonly levelLabel?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly profileSource?: RunSelectionSource | undefined;
  readonly touches?: readonly string[] | undefined;
  readonly parallelSafe?: boolean | undefined;
  readonly branch?: string | undefined;
  readonly headSha?: string | undefined;
  readonly diffStat?: NonNullable<AgentRun["diffStat"]> | undefined;
  readonly pullRequestUrls?: readonly string[] | undefined;
  readonly merged: boolean;
  readonly mergedAt?: string | undefined;
  readonly mergedSha?: string | undefined;
  readonly waitingReason?: UmbrellaChildWaitingReason | undefined;
  readonly inReadyBatch: boolean;
}

export interface UmbrellaReadyBatchItem {
  readonly taskId: string;
  readonly code?: string | undefined;
  readonly title: string;
  readonly levelKey?: string | undefined;
  readonly levelLabel?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly touches?: readonly string[] | undefined;
}

export interface UmbrellaLaunchReadiness {
  readonly ready: boolean;
  readonly reason?: string | undefined;
}

export interface UmbrellaChildrenStatusResponse {
  readonly parentTaskId: string;
  readonly children: UmbrellaChildItem[];
  readonly progress: UmbrellaProgressSummary;
  readonly readyBatch: UmbrellaReadyBatchItem[];
  readonly maxParallelChildren: number;
  readonly launchReadiness: UmbrellaLaunchReadiness;
}

export const StartUmbrellaReadyChildrenInputSchema = z.strictObject({
  max: z.number().int().min(1).max(MAX_PARALLEL_CHILDREN_MAX).exactOptional(),
});

export type StartUmbrellaReadyChildrenInput = z.input<typeof StartUmbrellaReadyChildrenInputSchema>;

export interface StopUmbrellaChildrenResponse {
  readonly stoppedTaskIds: string[];
}
