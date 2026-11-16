/**
 * Umbrella task child resolution, progress summaries, and API contracts (#BIT-191).
 *
 * Environment-neutral: no Node, DOM or Workers APIs.
 */
import { z } from "zod";
import { DEFAULT_HIERARCHY_MODE } from "./constants";
import { compareTasks } from "./entities";
import { extractTaskMentions } from "./mentions";
import {
  MAX_PARALLEL_CHILDREN_MAX,
  type AgentRunChild,
  type AgentRunChildState,
  type ParallelSkipReason,
  type RunSelectionSource,
} from "./run-profile";
import { IdSchema } from "./schemas";
import { isActiveAgentRunState, type AgentRun, type AgentRunState } from "./t3";
import { formatTaskCode, parseTaskCode, taskCode } from "./ticket-codes";
import type { HierarchyMode, Project, Task, TaskStatus } from "./types";

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
  readonly mode?: HierarchyMode | undefined;
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

function computeProgressForChildren(
  parentTaskId: string,
  children: readonly Task[],
  runByTaskId: ReadonlyMap<string, AgentRun>,
  runChildByParent: ReadonlyMap<string, ReadonlyMap<string, AgentRunChild>>,
): UmbrellaProgressSummary {
  const childRows = runChildByParent.get(parentTaskId);
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

  return {
    total: children.length,
    running,
    merged,
    done,
  };
}

/**
 * Resolves umbrella tasks and their children across a workspace.
 *
 * - In `"explicit"` mode (default, post-cutoff #BIT-193/#BIT-195), containment is determined strictly
 *   from persisted same-project `task.parentId` links; mentions, checklists, `dependsOn`, and run
 *   ancestry never create containment.
 * - In `"legacy"` mode, retains the pre-cutoff heuristic inference across `agent_run_children`,
 *   `agent_runs.parentTaskId`, `agent_runs.waitingForTaskId`, checklist/description mentions, and
 *   reverse `dependsOn` links.
 */
export function buildUmbrellaIndex(input: BuildUmbrellaIndexInput): UmbrellaIndex {
  const mode = input.mode ?? DEFAULT_HIERARCHY_MODE;
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));

  const runByTaskId = new Map<string, AgentRun>();
  for (const run of input.runs ?? []) {
    runByTaskId.set(run.taskId, run);
  }

  const runChildByParent = new Map<string, Map<string, AgentRunChild>>();
  for (const childRow of input.runChildren ?? []) {
    if (!taskById.has(childRow.parentTaskId) || !taskById.has(childRow.childTaskId)) continue;
    let byChild = runChildByParent.get(childRow.parentTaskId);
    if (!byChild) {
      byChild = new Map<string, AgentRunChild>();
      runChildByParent.set(childRow.parentTaskId, byChild);
    }
    byChild.set(childRow.childTaskId, childRow);
  }

  const resolvedChildrenByParent = new Map<string, readonly Task[]>();
  const progressByParent = new Map<string, UmbrellaProgressSummary>();

  if (mode === "explicit") {
    const grouped = new Map<string, Task[]>();
    for (const task of input.tasks) {
      if (!task.parentId || task.parentId === task.id) continue;
      const parent = taskById.get(task.parentId);
      if (parent?.projectId !== task.projectId) continue;
      let list = grouped.get(parent.id);
      if (!list) {
        list = [];
        grouped.set(parent.id, list);
      }
      list.push(task);
    }
    for (const [parentId, list] of grouped) {
      const children = [...list].sort(compareTasks);
      resolvedChildrenByParent.set(parentId, children);
      progressByParent.set(parentId, computeProgressForChildren(parentId, children, runByTaskId, runChildByParent));
    }
    return {
      childrenFor: (parentTaskId) => resolvedChildrenByParent.get(parentTaskId) ?? [],
      isUmbrella: (taskId) => resolvedChildrenByParent.has(taskId),
      progressFor: (parentTaskId) => progressByParent.get(parentTaskId),
    };
  }

  const taskByCode = new Map<string, Task>();
  for (const task of input.tasks) {
    const code = normalizedTaskCode(task, projectById);
    if (code) {
      taskByCode.set(code, task);
    }
  }

  const recordedChildrenByParent = new Map<string, Set<string>>();
  const knownParentsByChild = new Map<string, Set<string>>();

  for (const childRow of input.runChildren ?? []) {
    if (!taskById.has(childRow.parentTaskId) || !taskById.has(childRow.childTaskId)) continue;
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
    progressByParent.set(parent.id, computeProgressForChildren(parent.id, children, runByTaskId, runChildByParent));
  }

  return {
    childrenFor: (parentTaskId) => resolvedChildrenByParent.get(parentTaskId) ?? [],
    isUmbrella: (taskId) => resolvedChildrenByParent.has(taskId),
    progressFor: (parentTaskId) => progressByParent.get(parentTaskId),
  };
}

// ---------------------------------------------------------------------------
// Legacy Inferred Hierarchy Inventory & Human-Confirmed Import (#BIT-195)
// ---------------------------------------------------------------------------

export type LegacyHierarchyProvenance =
  | "run_child"
  | "run_parent_task"
  | "run_waiting_for"
  | "checklist_mention"
  | "description_mention"
  | "reverse_dependency";

export type LegacyHierarchyConflictReason =
  | "multiple_parents"
  | "cross_project"
  | "cycle"
  | "parent_dependency"
  | "already_parented";

export interface LegacyHierarchyCandidate {
  readonly childTaskId: string;
  readonly childCode?: string | undefined;
  readonly childTitle: string;
  readonly childProjectId: string;
  readonly childStatus: TaskStatus;
  readonly currentParentId?: string | undefined;
  readonly currentParentCode?: string | undefined;
  readonly proposedParentId: string;
  readonly proposedParentCode?: string | undefined;
  readonly proposedParentTitle: string;
  readonly proposedParentProjectId: string;
  readonly provenance: readonly LegacyHierarchyProvenance[];
  readonly alternateParentIds?: readonly string[] | undefined;
  readonly conflicts: readonly LegacyHierarchyConflictReason[];
  readonly importable: boolean;
}

export interface LegacyHierarchyInventoryResponse {
  readonly hierarchyMode: HierarchyMode;
  readonly totalTasks: number;
  readonly alreadyParentedCount: number;
  readonly candidates: readonly LegacyHierarchyCandidate[];
}

export const HierarchyImportPairSchema = z.strictObject({
  childTaskId: IdSchema,
  parentTaskId: IdSchema,
});

export const ImportHierarchyInputSchema = z.strictObject({
  edges: z.array(HierarchyImportPairSchema).min(1).max(500),
});

export type ImportHierarchyInput = z.input<typeof ImportHierarchyInputSchema>;

export interface ImportedHierarchyEdge {
  readonly childTaskId: string;
  readonly parentTaskId: string;
  readonly childCode?: string | undefined;
  readonly parentCode?: string | undefined;
}

export interface RejectedHierarchyEdge {
  readonly childTaskId: string;
  readonly parentTaskId: string;
  readonly reason: string;
}

export interface ImportHierarchyResponse {
  readonly imported: readonly ImportedHierarchyEdge[];
  readonly rejected: readonly RejectedHierarchyEdge[];
}

function createsExplicitCycle(
  childId: string,
  parentId: string,
  explicitParentById: ReadonlyMap<string, string | undefined>,
): boolean {
  if (childId === parentId) return true;
  const visited = new Set<string>([childId]);
  let cursor: string | undefined = parentId;
  while (cursor) {
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = explicitParentById.get(cursor);
  }
  return false;
}

/**
 * Produces a read-only inventory of legacy inferred parent-child relationships with full provenance
 * and conflict annotations so a person can explicitly review and confirm which edges to import
 * into `task.parentId`. Never mutates tasks or auto-promotes inferred links.
 */
export function buildLegacyHierarchyInventory(input: {
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly runs?: readonly AgentRun[] | undefined;
  readonly runChildren?: readonly AgentRunChild[] | undefined;
  readonly hierarchyMode?: HierarchyMode | undefined;
  readonly projectId?: string | undefined;
}): LegacyHierarchyInventoryResponse {
  const projectById = new Map(input.projects.map((p) => [p.id, p]));
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  const taskByCode = new Map<string, Task>();
  const explicitParentById = new Map<string, string | undefined>();
  for (const task of input.tasks) {
    explicitParentById.set(task.id, task.parentId);
    const code = normalizedTaskCode(task, projectById);
    if (code) {
      taskByCode.set(code, task);
    }
  }

  const edgeProvenance = new Map<string, Set<LegacyHierarchyProvenance>>();
  const recordProvenance = (
    parentId: string,
    childId: string,
    source: LegacyHierarchyProvenance,
  ): void => {
    if (parentId === childId) return;
    if (!taskById.has(parentId) || !taskById.has(childId)) return;
    const key = `${parentId}\n${childId}`;
    let set = edgeProvenance.get(key);
    if (!set) {
      set = new Set<LegacyHierarchyProvenance>();
      edgeProvenance.set(key, set);
    }
    set.add(source);
  };

  const recordedChildrenByParent = new Map<string, Set<string>>();
  const knownParentsByChild = new Map<string, Set<string>>();

  for (const childRow of input.runChildren ?? []) {
    if (!taskById.has(childRow.parentTaskId) || !taskById.has(childRow.childTaskId)) continue;
    addEdge(recordedChildrenByParent, childRow.parentTaskId, childRow.childTaskId);
    addEdge(knownParentsByChild, childRow.childTaskId, childRow.parentTaskId);
    recordProvenance(childRow.parentTaskId, childRow.childTaskId, "run_child");
  }

  for (const run of input.runs ?? []) {
    if (run.parentTaskId && taskById.has(run.parentTaskId) && taskById.has(run.taskId)) {
      addEdge(recordedChildrenByParent, run.parentTaskId, run.taskId);
      addEdge(knownParentsByChild, run.taskId, run.parentTaskId);
      recordProvenance(run.parentTaskId, run.taskId, "run_parent_task");
    }
    if (run.waitingForTaskId && taskById.has(run.taskId) && taskById.has(run.waitingForTaskId)) {
      addEdge(recordedChildrenByParent, run.taskId, run.waitingForTaskId);
      addEdge(knownParentsByChild, run.waitingForTaskId, run.taskId);
      recordProvenance(run.taskId, run.waitingForTaskId, "run_waiting_for");
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
        recordProvenance(task.id, target.id, "checklist_mention");
      }
    }
  }

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

    for (const mention of extractTaskMentions(parent.description)) {
      const target = taskByCode.get(mention.code);
      if (!target || target.id === parent.id) continue;
      if (parentOwnDeps.has(target.id)) continue;
      if (parentsOfParent?.has(target.id)) continue;
      recordProvenance(parent.id, target.id, "description_mention");
    }

    for (const candidate of input.tasks) {
      if (candidate.id === parent.id) continue;
      if (!(candidate.dependsOn ?? []).includes(parent.id)) continue;
      if (parentsOfParent?.has(candidate.id)) continue;
      if (sharesElement(parentsOfParent, knownParentsByChild.get(candidate.id))) continue;
      recordProvenance(parent.id, candidate.id, "reverse_dependency");
    }
  }

  // Group proposed parents per child so we can detect multiple_parents and reciprocal cycles.
  const proposedParentsByChild = new Map<string, Set<string>>();
  for (const key of edgeProvenance.keys()) {
    const [parentId, childId] = key.split("\n");
    if (!parentId || !childId) continue;
    addEdge(proposedParentsByChild, childId, parentId);
  }

  const scopedTasks = input.projectId
    ? input.tasks.filter((t) => t.projectId === input.projectId)
    : input.tasks;
  const alreadyParentedCount = scopedTasks.filter((t) => Boolean(t.parentId)).length;

  const candidates: LegacyHierarchyCandidate[] = [];
  for (const [key, sources] of edgeProvenance) {
    const [parentId, childId] = key.split("\n");
    if (!parentId || !childId) continue;
    const child = taskById.get(childId);
    const parent = taskById.get(parentId);
    if (!child || !parent) continue;
    if (input.projectId && child.projectId !== input.projectId && parent.projectId !== input.projectId) {
      continue;
    }

    const conflicts: LegacyHierarchyConflictReason[] = [];
    const proposedSet = proposedParentsByChild.get(child.id);
    const alternates = proposedSet ? [...proposedSet].filter((id) => id !== parent.id) : [];
    if (alternates.length > 0) {
      conflicts.push("multiple_parents");
    }
    if (child.projectId !== parent.projectId) {
      conflicts.push("cross_project");
    }
    const mutualInferred = Boolean(proposedParentsByChild.get(parent.id)?.has(child.id));
    if (mutualInferred || createsExplicitCycle(child.id, parent.id, explicitParentById)) {
      conflicts.push("cycle");
    }
    if ((child.dependsOn ?? []).includes(parent.id)) {
      conflicts.push("parent_dependency");
    }
    if (child.parentId !== undefined) {
      conflicts.push("already_parented");
    }

    const currentParent = child.parentId ? taskById.get(child.parentId) : undefined;
    const childCode = taskCode(child, projectById.get(child.projectId));
    const currentParentCode = currentParent
      ? taskCode(currentParent, projectById.get(currentParent.projectId))
      : undefined;
    const proposedParentCode = taskCode(parent, projectById.get(parent.projectId));

    const hasHardConflict = conflicts.some(
      (c) => c === "cross_project" || c === "cycle" || c === "already_parented",
    );

    candidates.push({
      childTaskId: child.id,
      ...(childCode ? { childCode } : {}),
      childTitle: child.title,
      childProjectId: child.projectId,
      childStatus: child.status,
      ...(child.parentId ? { currentParentId: child.parentId } : {}),
      ...(currentParentCode ? { currentParentCode } : {}),
      proposedParentId: parent.id,
      ...(proposedParentCode ? { proposedParentCode } : {}),
      proposedParentTitle: parent.title,
      proposedParentProjectId: parent.projectId,
      provenance: [...sources],
      ...(alternates.length > 0 ? { alternateParentIds: alternates } : {}),
      conflicts,
      importable: !hasHardConflict,
    });
  }

  candidates.sort((a, b) => {
    const childA = taskById.get(a.childTaskId);
    const childB = taskById.get(b.childTaskId);
    if (childA && childB && childA.id !== childB.id) {
      return compareTasks(childA, childB);
    }
    return a.proposedParentId.localeCompare(b.proposedParentId);
  });

  return {
    hierarchyMode: input.hierarchyMode ?? DEFAULT_HIERARCHY_MODE,
    totalTasks: scopedTasks.length,
    alreadyParentedCount,
    candidates,
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
