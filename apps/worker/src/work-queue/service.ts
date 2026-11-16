/**
 * Work queue service (#BIT-202): turns a dashboard prompt into a plan preview,
 * confirms a plan into a persisted queue, and exposes the queue controls.
 *
 * The plan is always computed on the server from live task state. The confirm
 * step never trusts a plan sent by the client: it only accepts ticket codes,
 * approval ticks and run overrides, and re-runs the planner itself.
 */

import {
  NotFoundError,
  ValidationError,
  defaultIdGenerator,
  isActiveAgentRunState,
  isActiveWorkQueueEntryState,
  parseWorkQueuePrompt,
  planWorkQueue,
  resolveRunSelection,
  sortRunLevels,
  taskCode,
  type OperationOptions,
  type Project,
  type ProjectRunSettings,
  type ResolvedRunSelection,
  type RunLevel,
  type RunProfileSource,
  type T3ModelSelection,
  type Task,
  type WorkQueue,
  type WorkQueueClassification,
  type WorkQueueEntry,
  type WorkQueueEntryState,
  type WorkQueueItem,
  type WorkQueuePlan,
  type WorkQueuePlanProject,
  type WorkQueuePlanTask,
  type WorkQueueProjectRef,
  type WorkQueueState,
  type WorkQueueUnknownKey,
  type WorkQueueWaveSkip,
} from "@bitig/core";
import type { D1WorkQueueStore, StoredTaskRunProfile } from "@bitig/storage-d1";
import {
  assertHierarchyMutationAllowed,
  createOrgRunProfileRouter,
  resolveTaskLaunchRunSelection,
  suggestTaskRunProfile,
  type T3ServiceDeps,
} from "../t3/service";
import {
  parseWorkQueuePromptWithFallback,
  resolveWorkQueueRouterState,
  type WorkQueueFallbackParseResult,
  type WorkQueueFallbackStatus,
} from "./parse-fallback";

/** Label on every queue umbrella task. */
export const WORK_QUEUE_LABEL = "work-queue";
/** Upper bound for the whole "route unprofiled tasks" phase of a plan request. */
export const WORK_QUEUE_ROUTING_TIMEOUT_MS = 10_000;
/** Shown on rows whose level is a fallback because no profile exists and the router gave none. */
export const WORK_QUEUE_DEFAULT_NOTE = "default, not routed";
/** Most queues returned by one list call (newest first). */
export const WORK_QUEUE_LIST_LIMIT = 50;
/** A lane gets a queue umbrella task from this many queued tasks. */
const QUEUE_UMBRELLA_MIN_TASKS = 2;
/** Above this many codes a non-contiguous umbrella title is shortened to a span. */
const QUEUE_UMBRELLA_TITLE_LIST_MAX = 5;
const EFFORT_OPTION_IDS: ReadonlySet<string> = new Set(["effort", "reasoningEffort", "thinkingEffort"]);

/** Classifications that are put on the queue at confirm time. */
const QUEUEABLE_CLASSIFICATIONS: ReadonlySet<WorkQueueClassification> = new Set(["ready", "after_queued_task"]);
/** Classifications that get a level, model and effort in the preview. */
const ROUTABLE_CLASSIFICATIONS: ReadonlySet<WorkQueueClassification> = new Set([
  "ready",
  "after_queued_task",
  "needs_approval",
]);
/** Entry states a person can still skip, and that a cancel sweeps up. */
const UNSTARTED_ENTRY_STATES: ReadonlySet<WorkQueueEntryState> = new Set(["waiting", "ready"]);
/** Terminal entry states a person can retry. */
const RETRYABLE_ENTRY_STATES: ReadonlySet<WorkQueueEntryState> = new Set(["failed", "skipped", "cancelled"]);

const QUEUE_ACTION_TARGET_STATE = {
  pause: "paused",
  resume: "active",
  cancel: "cancelled",
} as const satisfies Record<string, WorkQueueState>;
export type WorkQueueAction = keyof typeof QUEUE_ACTION_TARGET_STATE;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkQueueServiceDeps {
  readonly t3: T3ServiceDeps;
  readonly queueStore: D1WorkQueueStore;
  readonly idGenerator?: (() => string) | undefined;
}

/** The signed-in person a queue action is attributed to. */
export interface WorkQueueActor {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl?: string | undefined;
}

export interface WorkQueueRunChoice {
  readonly level: string | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Who chose the level: a stored profile's source, or `default` when no profile decided it. */
  readonly source: RunProfileSource | "default";
  /** `default, not routed` when the level is a fallback rather than a profile or router choice. */
  readonly note?: string | undefined;
  /** The exact selection snapshotted on the queue entry at confirm time. */
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

export interface WorkQueuePlanWaveView {
  readonly number: number;
  readonly codes: readonly string[];
  readonly skipped: readonly WorkQueueWaveSkip[];
}

export interface WorkQueuePlanLaneView {
  readonly projectId: string;
  readonly projectKey: string;
  readonly projectName: string;
  readonly needsQueueUmbrella: boolean;
  readonly codes: readonly string[];
  readonly waves: readonly WorkQueuePlanWaveView[];
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
  readonly lanes: readonly WorkQueuePlanLaneView[];
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

export interface WorkQueueRunOverride {
  readonly code: string;
  readonly level?: string | undefined;
  readonly effort?: string | undefined;
  readonly selection?: T3ModelSelection | undefined;
}

export interface PlanWorkQueueInput {
  readonly prompt: string;
  /** Explicit ticket codes; when given the prompt is not parsed and no parse model is called. */
  readonly items?: readonly string[] | undefined;
  readonly actor: WorkQueueActor;
  readonly cache?: Cache | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ConfirmWorkQueueInput {
  readonly prompt: string;
  readonly items: readonly string[];
  readonly approvals: readonly string[];
  readonly overrides: readonly WorkQueueRunOverride[];
  readonly actor: WorkQueueActor;
  /** Runs after each task this confirm approved (e.g. to settle linked feedback entries). */
  readonly onTaskApproved?: ((taskId: string) => Promise<void>) | undefined;
}

/** Thrown by confirm when the server-side plan has no task that can be queued. */
export class WorkQueueNothingToQueueError extends Error {
  readonly plan: WorkQueuePlanView;

  constructor(plan: WorkQueuePlanView) {
    super("No listed task can be queued: every task is already queued, running, finished, held or unknown.");
    this.name = "WorkQueueNothingToQueueError";
    this.plan = plan;
  }
}

// ---------------------------------------------------------------------------
// Plan context
// ---------------------------------------------------------------------------

interface PlanContext {
  readonly projects: readonly Project[];
  readonly projectsById: ReadonlyMap<string, Project>;
  readonly projectRefs: readonly WorkQueueProjectRef[];
  readonly tasksById: ReadonlyMap<string, Task>;
  readonly tasksByCode: ReadonlyMap<string, Task>;
  readonly codesByTaskId: ReadonlyMap<string, string>;
  readonly hostIdByProjectId: ReadonlyMap<string, string | undefined>;
  readonly connectedProjectIds: ReadonlySet<string>;
  readonly activeTaskIds: readonly string[];
  readonly queuedTaskIds: readonly string[];
  readonly profilesByTaskId: ReadonlyMap<string, StoredTaskRunProfile>;
}

function clock(deps: WorkQueueServiceDeps): number {
  return deps.t3.now ? deps.t3.now() : Date.now();
}

function newId(deps: WorkQueueServiceDeps): string {
  return (deps.idGenerator ?? defaultIdGenerator)();
}

function actorOptions(actor: WorkQueueActor): OperationOptions {
  return {
    actor: actor.name,
    userId: actor.id,
    ...(actor.avatarUrl !== undefined ? { userAvatarUrl: actor.avatarUrl } : {}),
  };
}

function itemCode(item: WorkQueueItem): string {
  return `${item.key.toUpperCase()}-${String(item.number)}`;
}

function normalizeCode(code: string): string {
  return code.trim().replace(/^#/, "").toUpperCase();
}

/** Task IDs that already hold an active entry in one of the organisation's open queues. */
async function listQueuedTaskIds(queueStore: D1WorkQueueStore): Promise<string[]> {
  const queues = await queueStore.listQueues({ openOnly: true });
  const entries = await Promise.all(queues.map((queue) => queueStore.listEntries(queue.id)));
  return entries
    .flat()
    .filter((entry) => isActiveWorkQueueEntryState(entry.state))
    .map((entry) => entry.taskId);
}

async function loadPlanContext(deps: WorkQueueServiceDeps): Promise<PlanContext> {
  const { storage, store } = deps.t3;
  const [allProjects, tasks, mappings, runs, profiles, queuedTaskIds] = await Promise.all([
    storage.getProjects(),
    storage.getTasks(),
    store.listProjectMappings(),
    store.listAgentRuns(),
    store.listTaskRunProfiles(),
    listQueuedTaskIds(deps.queueStore),
  ]);
  const projects = allProjects.filter((project) => project.archived !== true && project.key !== undefined);
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const tasksByCode = new Map<string, Task>();
  const codesByTaskId = new Map<string, string>();
  for (const task of tasks) {
    const code = taskCode(task, projectsById.get(task.projectId));
    if (code === undefined) continue;
    tasksByCode.set(code.toUpperCase(), task);
    codesByTaskId.set(task.id, code);
  }
  return {
    projects,
    projectsById,
    projectRefs: projects.flatMap((project) => (project.key ? [{ key: project.key, name: project.name }] : [])),
    tasksById: new Map(tasks.map((task) => [task.id, task])),
    tasksByCode,
    codesByTaskId,
    hostIdByProjectId: new Map(mappings.map((mapping) => [mapping.projectId, mapping.hostId ?? undefined])),
    connectedProjectIds: new Set(mappings.map((mapping) => mapping.projectId)),
    activeTaskIds: runs.filter((run) => isActiveAgentRunState(run.state)).map((run) => run.taskId),
    queuedTaskIds,
    profilesByTaskId: new Map(profiles.map((profile) => [profile.taskId, profile])),
  };
}

/** Run settings of every project that has a listed task; other projects never form a lane. */
async function loadLaneSettings(
  deps: WorkQueueServiceDeps,
  context: PlanContext,
  items: readonly WorkQueueItem[],
): Promise<Map<string, ProjectRunSettings | undefined>> {
  const projectIds = new Set<string>();
  for (const item of items) {
    const task = context.tasksByCode.get(itemCode(item));
    if (task) projectIds.add(task.projectId);
  }
  const loaded = await Promise.all(
    [...projectIds].map(
      async (projectId) => [projectId, await deps.t3.store.getProjectRunSettings(projectId)] as const,
    ),
  );
  return new Map(loaded);
}

function buildPlan(
  context: PlanContext,
  items: readonly WorkQueueItem[],
  settings: ReadonlyMap<string, ProjectRunSettings | undefined>,
): WorkQueuePlan {
  const planProjects = context.projects.map((project): WorkQueuePlanProject => {
    const projectSettings = settings.get(project.id);
    return {
      id: project.id,
      key: project.key ?? project.id,
      connected: context.connectedProjectIds.has(project.id),
      ...(projectSettings ? { serialPaths: projectSettings.serialPaths } : {}),
      ...(projectSettings ? { maxParallelChildren: projectSettings.maxParallelChildren } : {}),
    };
  });
  const planTasks: WorkQueuePlanTask[] = [];
  for (const task of context.tasksById.values()) {
    const code = context.codesByTaskId.get(task.id);
    if (code === undefined) continue;
    const profile = context.profilesByTaskId.get(task.id);
    // A dependency on a task that no longer exists cannot hold anything back.
    const dependsOn = (task.dependsOn ?? []).filter((id) => context.tasksById.has(id));
    planTasks.push({
      id: task.id,
      code,
      projectId: task.projectId,
      status: task.status,
      parentId: task.parentId,
      dependsOn,
      pendingApproval: task.pendingApproval,
      needsHuman: task.needsHuman,
      order: task.order,
      profile: profile ?? null,
    });
  }
  return planWorkQueue({
    items,
    tasks: planTasks,
    projects: planProjects,
    activeTaskIds: context.activeTaskIds,
    queuedTaskIds: context.queuedTaskIds,
  });
}

// ---------------------------------------------------------------------------
// Level, model and effort per row
// ---------------------------------------------------------------------------

type LevelLoader = (hostId: string | undefined) => Promise<readonly RunLevel[]>;

function createLevelLoader(deps: WorkQueueServiceDeps): LevelLoader {
  const now = clock(deps);
  const cache = new Map<string, Promise<readonly RunLevel[]>>();
  return (hostId) => {
    const cacheKey = hostId ?? "";
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const loading = deps.t3.store.listRunLevels({ ...(hostId ? { hostId } : {}), now });
    cache.set(cacheKey, loading);
    return loading;
  };
}

function effortOf(selection: T3ModelSelection | undefined, profile: StoredTaskRunProfile | undefined): string | null {
  const option = selection?.options?.find((candidate) => EFFORT_OPTION_IDS.has(candidate.id));
  if (option && typeof option.value === "string") return option.value;
  return profile?.effort ?? null;
}

/**
 * Resolves a task's level, model and effort the way a launch would, with the
 * queue's extra rule: when neither a profile nor the project default names a
 * level, the organisation's lowest level is used and the row is marked.
 */
function resolveRunChoice(
  profile: StoredTaskRunProfile | undefined,
  projectDefaultLevel: string | undefined,
  levels: readonly RunLevel[],
): WorkQueueRunChoice {
  let resolved: ResolvedRunSelection = resolveRunSelection({ profile, projectDefaultLevel, levels });
  let level = resolved.levelKey ?? null;
  if (resolved.source === "default") {
    const lowest = sortRunLevels(levels)[0];
    if (lowest) {
      resolved = resolveRunSelection({ explicitLevel: lowest.key, levels });
      level = lowest.key;
    }
  }
  const source = resolved.profileSource ?? "default";
  return {
    level,
    providerInstanceId: resolved.selection?.providerInstanceId ?? null,
    model: resolved.selection?.model ?? null,
    effort: effortOf(resolved.selection, profile),
    source,
    ...(source === "default" ? { note: WORK_QUEUE_DEFAULT_NOTE } : {}),
    selection: resolved.selection ?? null,
  };
}

async function buildRows(
  context: PlanContext,
  plan: WorkQueuePlan,
  settings: ReadonlyMap<string, ProjectRunSettings | undefined>,
  loadLevels: LevelLoader,
): Promise<WorkQueuePlanRow[]> {
  return await Promise.all(
    plan.items.map(async (entry): Promise<WorkQueuePlanRow> => {
      const base = {
        code: entry.code,
        raw: entry.item.raw,
        classification: entry.classification,
        queueable: QUEUEABLE_CLASSIFICATIONS.has(entry.classification),
        ...(entry.related ? { related: entry.related } : {}),
      };
      const task = entry.task ? context.tasksById.get(entry.task.id) : undefined;
      if (!task) return base;
      const described = {
        ...base,
        taskId: task.id,
        title: task.title,
        projectId: task.projectId,
        ...(entry.isUmbrella ? { isUmbrella: true } : {}),
      };
      if (!ROUTABLE_CLASSIFICATIONS.has(entry.classification)) return described;
      const levels = await loadLevels(context.hostIdByProjectId.get(task.projectId));
      const run = resolveRunChoice(
        context.profilesByTaskId.get(task.id),
        settings.get(task.projectId)?.defaultRunLevel,
        levels,
      );
      return { ...described, run };
    }),
  );
}

function buildLanes(context: PlanContext, plan: WorkQueuePlan): WorkQueuePlanLaneView[] {
  return plan.lanes.map((lane) => ({
    projectId: lane.project.id,
    projectKey: lane.project.key,
    projectName: context.projectsById.get(lane.project.id)?.name ?? lane.project.key,
    needsQueueUmbrella: lane.needsQueueUmbrella,
    codes: lane.items.map((entry) => entry.code),
    waves: lane.waves.map((wave) => ({
      number: wave.number,
      codes: wave.tasks.map((task) => task.code),
      skipped: wave.skipped,
    })),
  }));
}

// ---------------------------------------------------------------------------
// AI router
// ---------------------------------------------------------------------------

interface RouteTasksOptions {
  readonly actor: WorkQueueActor;
  readonly cache?: Cache | undefined;
  readonly signal?: AbortSignal | undefined;
}

const ROUTING_NOT_ATTEMPTED: WorkQueueRoutingSummary = { enabled: false, attempted: 0, failed: 0 };

/**
 * Asks the organisation's AI router for a profile for each unprofiled task, in
 * parallel. Suggestions are stored with source `router`; `suggestTaskRunProfile`
 * never overwrites a `manual` or `agent` profile. A failure only counts: the
 * caller falls back to the project default or the lowest level.
 */
async function routeUnprofiledTasks(
  deps: WorkQueueServiceDeps,
  taskIds: readonly string[],
  options: RouteTasksOptions,
): Promise<WorkQueueRoutingSummary> {
  const creation = await createOrgRunProfileRouter(deps.t3);
  if (!creation.ok) return ROUTING_NOT_ATTEMPTED;
  if (taskIds.length === 0) return { enabled: true, attempted: 0, failed: 0 };

  // One router instance for the whole batch, so the stored token is decrypted once.
  const routedDeps: T3ServiceDeps = { ...deps.t3, runProfileRouter: creation.router };
  const timeout = AbortSignal.timeout(WORK_QUEUE_ROUTING_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const outcomes = await Promise.allSettled(
    taskIds.map((taskId) =>
      suggestTaskRunProfile(routedDeps, taskId, {
        onlyWhenUnprofiled: true,
        actor: options.actor.id,
        signal,
        ...(options.cache ? { cache: options.cache } : {}),
      }),
    ),
  );
  let failed = 0;
  outcomes.forEach((outcome, index) => {
    if (outcome.status === "rejected") {
      failed += 1;
      console.error("routing a work queue task failed", { taskId: taskIds[index], error: outcome.reason as unknown });
      return;
    }
    if (outcome.value.suggestionFailure) failed += 1;
  });
  return { enabled: true, attempted: taskIds.length, failed };
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** Parses explicit ticket codes with the core rules, so unknown keys and the item cap apply. */
function parseExplicitCodes(
  codes: readonly string[],
  projects: readonly WorkQueueProjectRef[],
): WorkQueueFallbackParseResult {
  // A comma never forms a range, so each code stays a single item.
  const text = codes.map(normalizeCode).join(", ");
  return { ...parseWorkQueuePrompt(text, projects), fallback: "not_needed" };
}

async function parsePrompt(
  deps: WorkQueueServiceDeps,
  context: PlanContext,
  prompt: string,
  signal: AbortSignal | undefined,
): Promise<WorkQueueFallbackParseResult> {
  let record: Awaited<ReturnType<T3ServiceDeps["store"]["getAiRouterSettingsRecord"]>>;
  try {
    record = await deps.t3.store.getAiRouterSettingsRecord();
  } catch (error: unknown) {
    // The deterministic parser still answers; only the model fallback is lost.
    console.warn("reading AI router settings for the work queue parse failed", { error });
    record = undefined;
  }
  const router = await resolveWorkQueueRouterState(record, deps.t3.encryptionKey);
  return await parseWorkQueuePromptWithFallback({
    text: prompt,
    projects: context.projectRefs,
    router,
    fetchFn: deps.t3.fetchFn,
    signal,
  });
}

interface AssembleOptions {
  readonly route?: RouteTasksOptions | undefined;
}

async function assemblePlan(
  deps: WorkQueueServiceDeps,
  initialContext: PlanContext,
  parse: WorkQueueFallbackParseResult,
  options: AssembleOptions = {},
): Promise<WorkQueuePlanView> {
  let context = initialContext;
  const settings = await loadLaneSettings(deps, context, parse.items);
  let plan = buildPlan(context, parse.items, settings);
  let routing = ROUTING_NOT_ATTEMPTED;

  if (options.route) {
    const unprofiled = plan.items.flatMap((entry) =>
      entry.task && ROUTABLE_CLASSIFICATIONS.has(entry.classification) && !context.profilesByTaskId.has(entry.task.id)
        ? [entry.task.id]
        : [],
    );
    routing = await routeUnprofiledTasks(deps, unprofiled, options.route);
    if (routing.attempted > 0) {
      // New router profiles carry `touches`, which change the waves.
      const profiles = await deps.t3.store.listTaskRunProfiles();
      context = { ...context, profilesByTaskId: new Map(profiles.map((profile) => [profile.taskId, profile])) };
      plan = buildPlan(context, parse.items, settings);
    }
  }

  return {
    parse: {
      items: parse.items.map((item) => ({ code: itemCode(item), raw: item.raw })),
      unknownKeys: parse.unknownKeys,
      unparsed: parse.unparsed,
      warnings: parse.warnings,
      fallback: parse.fallback,
    },
    rows: await buildRows(context, plan, settings, createLevelLoader(deps)),
    lanes: buildLanes(context, plan),
    routing,
  };
}

/**
 * Builds the plan preview for a prompt. The only writes are AI router profiles
 * for tasks that had no profile.
 */
export async function planWorkQueuePrompt(
  deps: WorkQueueServiceDeps,
  input: PlanWorkQueueInput,
): Promise<WorkQueuePlanView> {
  const context = await loadPlanContext(deps);
  const parse = input.items
    ? parseExplicitCodes(input.items, context.projectRefs)
    : await parsePrompt(deps, context, input.prompt, input.signal);
  return await assemblePlan(deps, context, parse, {
    route: { actor: input.actor, cache: input.cache, signal: input.signal },
  });
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

function customIssue(context: string, path: string, message: string): ValidationError {
  return new ValidationError(context, [{ code: "custom", path: [path], message }]);
}

async function assertOverrideLevelsExist(
  deps: WorkQueueServiceDeps,
  overrides: readonly WorkQueueRunOverride[],
): Promise<void> {
  const requested = overrides.flatMap((override) => (override.level === undefined ? [] : [override.level]));
  if (requested.length === 0) return;
  const known = new Set((await deps.t3.store.listRunLevels({ now: clock(deps) })).map((level) => level.key));
  const missing = requested.find((level) => !known.has(level));
  if (missing !== undefined) {
    throw customIssue("workQueue", "overrides", `Run level "${missing}" does not exist in this organisation.`);
  }
}

/**
 * Saves a person's level, model or effort choice as a `manual` profile. A new
 * level replaces what the old one implied: the stored model override and effort
 * are cleared unless the same override sets them, so the level takes effect.
 */
async function saveRunOverride(
  deps: WorkQueueServiceDeps,
  taskId: string,
  override: WorkQueueRunOverride,
  actor: WorkQueueActor,
): Promise<void> {
  const changesLevel = override.level !== undefined;
  await deps.t3.store.saveTaskRunProfile({
    taskId,
    ...(changesLevel ? { level: override.level } : {}),
    ...(override.effort !== undefined ? { effort: override.effort } : changesLevel ? { effort: null } : {}),
    ...(override.selection !== undefined
      ? { selection: override.selection }
      : changesLevel
        ? { selection: null }
        : {}),
    source: "manual",
    updatedBy: actor.id,
    now: clock(deps),
  });
}

function isContiguous(numbers: readonly number[]): boolean {
  return numbers.every((value, index) => index === 0 || value === (numbers[index - 1] ?? value) + 1);
}

/** "Queue: BIT-92..BIT-102" for a run of codes; a short list is spelled out when it has gaps. */
function queueUmbrellaTitle(tasks: readonly Task[], codes: ReadonlyMap<string, string>): string {
  const sorted = [...tasks].sort((left, right) => (left.number ?? 0) - (right.number ?? 0));
  const sortedCodes = sorted.flatMap((task) => codes.get(task.id) ?? []);
  const first = sortedCodes[0] ?? "";
  const last = sortedCodes[sortedCodes.length - 1] ?? first;
  if (isContiguous(sorted.map((task) => task.number ?? 0))) return `Queue: ${first}..${last}`;
  if (sortedCodes.length <= QUEUE_UMBRELLA_TITLE_LIST_MAX) return `Queue: ${sortedCodes.join(", ")}`;
  return `Queue: ${first}..${last} (${String(sortedCodes.length)} tasks)`;
}

interface QueuedLaneTask {
  readonly task: Task;
  readonly code: string;
  readonly selection: T3ModelSelection | null;
}

interface QueuedLane {
  readonly projectId: string;
  readonly tasks: readonly QueuedLaneTask[];
}

/** Queueable rows per lane, in lane order and then wave order, so positions follow the plan. */
function queuedLanes(context: PlanContext, view: WorkQueuePlanView): QueuedLane[] {
  const queueable = new Map(view.rows.filter((row) => row.queueable).map((row) => [row.code, row]));
  const placed = new Set<string>();
  const lanes: QueuedLane[] = [];
  for (const lane of view.lanes) {
    const ordered = [...lane.waves.flatMap((wave) => wave.codes), ...lane.codes];
    const tasks: QueuedLaneTask[] = [];
    for (const code of ordered) {
      const row = queueable.get(code);
      const task = row?.taskId ? context.tasksById.get(row.taskId) : undefined;
      if (!row || !task || placed.has(code)) continue;
      placed.add(code);
      tasks.push({ task, code, selection: row.run?.selection ?? null });
    }
    if (tasks.length > 0) lanes.push({ projectId: lane.projectId, tasks });
  }
  return lanes;
}

interface ConfirmWrites {
  readonly umbrellaIds: string[];
  readonly attachedTaskIds: string[];
  readonly entryIds: string[];
  queueId?: string;
}

/**
 * Best-effort undo for a confirm that failed part-way (D1 has no transaction
 * spanning these writes). Each step is attempted; a failing step is logged and
 * the remaining steps still run. Approvals and manual profiles are kept: they
 * are the person's own decisions and stay valid without the queue.
 */
async function rollBackConfirm(
  deps: WorkQueueServiceDeps,
  writes: ConfirmWrites,
  actor: WorkQueueActor,
): Promise<void> {
  const { storage } = deps.t3;
  const now = clock(deps);
  const attempt = async (step: string, work: () => Promise<unknown>): Promise<void> => {
    try {
      await work();
    } catch (error: unknown) {
      console.error("rolling back a failed work queue confirm", { step, queueId: writes.queueId, error });
    }
  };
  for (const entryId of writes.entryIds) {
    await attempt("cancel entry", () => deps.queueStore.transitionEntry(entryId, { to: "cancelled", now }));
  }
  const queueId = writes.queueId;
  if (queueId !== undefined) {
    await attempt("cancel queue", () => deps.queueStore.transitionQueue(queueId, "cancelled", now));
  }
  for (const taskId of writes.attachedTaskIds) {
    await attempt("detach task", () => storage.updateTask(taskId, { parentId: null }, actorOptions(actor)));
  }
  for (const umbrellaId of writes.umbrellaIds) {
    await attempt("delete umbrella", () => storage.deleteTask(umbrellaId, actorOptions(actor)));
  }
}

async function decorateEntries(
  deps: WorkQueueServiceDeps,
  entries: readonly WorkQueueEntry[],
): Promise<WorkQueueEntryView[]> {
  if (entries.length === 0) return [];
  const { storage } = deps.t3;
  const [projects, tasks] = await Promise.all([storage.getProjects(), storage.getTasks()]);
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  return entries.map((entry) => {
    const task = tasksById.get(entry.taskId);
    const code = task ? taskCode(task, projectsById.get(task.projectId)) : undefined;
    return {
      ...entry,
      ...(code !== undefined ? { taskCode: code } : {}),
      ...(task ? { taskTitle: task.title } : {}),
    };
  });
}

/**
 * Confirms a queue. The plan is rebuilt here from the listed codes: nothing
 * the client says about classification, lanes or selections is used.
 *
 * Order of writes: approvals and manual profiles, then one umbrella per lane
 * with two or more queued tasks (and `parentId` on its tasks), then the queue
 * and its entries. Tasks that are already queued or running are never queued
 * again; the store's unique index backs that up under concurrency.
 */
export async function confirmWorkQueue(
  deps: WorkQueueServiceDeps,
  input: ConfirmWorkQueueInput,
): Promise<WorkQueueConfirmResult> {
  const { storage } = deps.t3;
  const { actor } = input;

  const previewContext = await loadPlanContext(deps);
  const requested = parseExplicitCodes(input.items, previewContext.projectRefs);
  const preview = await assemblePlan(deps, previewContext, requested);

  const ticked = new Set(input.approvals.map(normalizeCode));
  const approvable = preview.rows.filter(
    (row) => row.classification === "needs_approval" && ticked.has(row.code) && row.taskId !== undefined,
  );
  const expected = new Map(
    [...preview.rows.filter((row) => row.queueable), ...approvable].flatMap((row) =>
      row.taskId === undefined ? [] : [[row.code, row.taskId] as const],
    ),
  );
  if (expected.size === 0) throw new WorkQueueNothingToQueueError(preview);

  // Overrides and approvals only ever apply to tasks this confirm is about to queue.
  const overrides = input.overrides
    .map((override) => ({ ...override, code: normalizeCode(override.code) }))
    .filter((override) => expected.has(override.code));
  await assertOverrideLevelsExist(deps, overrides);

  const approved: string[] = [];
  for (const row of approvable) {
    if (row.taskId === undefined) continue;
    await storage.updateTask(row.taskId, { pendingApproval: null }, actorOptions(actor));
    await input.onTaskApproved?.(row.taskId);
    approved.push(row.code);
  }
  for (const override of overrides) {
    const taskId = expected.get(override.code);
    if (taskId !== undefined) await saveRunOverride(deps, taskId, override, actor);
  }

  // Tasks left pending approval are not queued, so they must not shape lanes or waves.
  const unapproved = new Set(
    preview.rows.filter((row) => row.classification === "needs_approval" && !ticked.has(row.code)).map((row) => row.code),
  );
  const finalCodes = requested.items.map(itemCode).filter((code) => !unapproved.has(code));
  const context = await loadPlanContext(deps);
  const plan = await assemblePlan(deps, context, parseExplicitCodes(finalCodes, context.projectRefs));
  const lanes = queuedLanes(context, plan);
  if (lanes.length === 0) throw new WorkQueueNothingToQueueError(plan);

  const umbrellaLanes = lanes.filter((lane) => lane.tasks.length >= QUEUE_UMBRELLA_MIN_TASKS);
  for (const lane of umbrellaLanes) {
    for (const { task } of lane.tasks) {
      await assertHierarchyMutationAllowed(deps.t3, { action: "reparent", taskId: task.id });
    }
  }

  const writes: ConfirmWrites = { umbrellaIds: [], attachedTaskIds: [], entryIds: [] };
  const umbrellas: WorkQueueUmbrellaView[] = [];
  const umbrellaIdByProject = new Map<string, string>();
  try {
    for (const lane of umbrellaLanes) {
      const laneTasks = lane.tasks.map((queued) => queued.task);
      const project = context.projectsById.get(lane.projectId);
      const umbrella = await storage.saveTask(
        {
          projectId: lane.projectId,
          title: queueUmbrellaTitle(laneTasks, context.codesByTaskId),
          description: `Queue umbrella for ${lane.tasks.map((queued) => `#${queued.code}`).join(", ")}, created from the dashboard work queue.`,
          labels: [WORK_QUEUE_LABEL],
        },
        actorOptions(actor),
      );
      writes.umbrellaIds.push(umbrella.id);
      umbrellaIdByProject.set(lane.projectId, umbrella.id);
      for (const { task } of lane.tasks) {
        await storage.updateTask(task.id, { parentId: umbrella.id }, actorOptions(actor));
        writes.attachedTaskIds.push(task.id);
      }
      const umbrellaCode = taskCode(umbrella, project);
      umbrellas.push({
        projectId: lane.projectId,
        taskId: umbrella.id,
        ...(umbrellaCode !== undefined ? { code: umbrellaCode } : {}),
        title: umbrella.title,
        children: lane.tasks.map((queued) => queued.code),
      });
    }

    const now = clock(deps);
    const queue = await deps.queueStore.createQueue({
      id: newId(deps),
      createdBy: actor.id,
      prompt: input.prompt,
      now,
    });
    writes.queueId = queue.id;
    const entries: WorkQueueEntry[] = [];
    let position = 0;
    for (const lane of lanes) {
      for (const queued of lane.tasks) {
        const entry = await deps.queueStore.addEntry({
          id: newId(deps),
          queueId: queue.id,
          taskId: queued.task.id,
          position,
          lane: lane.projectId,
          resolvedSelection: queued.selection,
          umbrellaTaskId: umbrellaIdByProject.get(lane.projectId) ?? null,
          now,
        });
        writes.entryIds.push(entry.id);
        entries.push(entry);
        position += 1;
      }
    }
    const active = await deps.queueStore.transitionQueue(queue.id, "active", now);
    return {
      queue: { ...active, entries: await decorateEntries(deps, entries) },
      umbrellas,
      approved,
      plan,
    };
  } catch (error: unknown) {
    await rollBackConfirm(deps, writes, actor);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Listing and controls
// ---------------------------------------------------------------------------

export interface ListWorkQueuesInput {
  /** Also list finished and cancelled queues. */
  readonly includeClosed?: boolean | undefined;
}

export async function listWorkQueues(
  deps: WorkQueueServiceDeps,
  input: ListWorkQueuesInput = {},
): Promise<WorkQueueView[]> {
  const queues = (await deps.queueStore.listQueues({ openOnly: input.includeClosed !== true })).slice(
    0,
    WORK_QUEUE_LIST_LIMIT,
  );
  const entryLists = await Promise.all(queues.map((queue) => deps.queueStore.listEntries(queue.id)));
  const decorated = await decorateEntries(deps, entryLists.flat());
  const byQueue = new Map<string, WorkQueueEntryView[]>();
  for (const entry of decorated) {
    const bucket = byQueue.get(entry.queueId) ?? [];
    bucket.push(entry);
    byQueue.set(entry.queueId, bucket);
  }
  return queues.map((queue) => ({ ...queue, entries: byQueue.get(queue.id) ?? [] }));
}

/**
 * Returns a task that never started to the backlog as it was: its queue
 * umbrella is removed as parent. A task that moved elsewhere is left alone, and
 * so is one whose delegation run is active (reparenting it is refused).
 */
async function detachFromQueueUmbrella(
  deps: WorkQueueServiceDeps,
  entry: WorkQueueEntry,
  actor: WorkQueueActor,
): Promise<void> {
  if (entry.umbrellaTaskId === null) return;
  const task = await deps.t3.storage.getTask(entry.taskId);
  if (task?.parentId !== entry.umbrellaTaskId) return;
  try {
    await assertHierarchyMutationAllowed(deps.t3, { action: "reparent", taskId: task.id });
  } catch (error: unknown) {
    if (!(error instanceof ValidationError)) throw error;
    console.warn("work queue task stays under its umbrella: its delegation run is active", {
      taskId: task.id,
      umbrellaTaskId: entry.umbrellaTaskId,
    });
    return;
  }
  await deps.t3.storage.updateTask(task.id, { parentId: null }, actorOptions(actor));
}

async function queueView(deps: WorkQueueServiceDeps, queue: WorkQueue): Promise<WorkQueueView> {
  return { ...queue, entries: await decorateEntries(deps, await deps.queueStore.listEntries(queue.id)) };
}

/**
 * Pauses, resumes or cancels a queue. Cancelling also cancels every entry that
 * has not started and detaches those tasks from their queue umbrella. Entries
 * that are running are left to the dispatcher's stop path.
 */
export async function changeWorkQueueState(
  deps: WorkQueueServiceDeps,
  queueId: string,
  action: WorkQueueAction,
  actor: WorkQueueActor,
): Promise<WorkQueueView> {
  const now = clock(deps);
  const queue = await deps.queueStore.transitionQueue(queueId, QUEUE_ACTION_TARGET_STATE[action], now);
  if (action === "cancel") {
    const entries = await deps.queueStore.listEntries(queue.id);
    for (const entry of entries.filter((candidate) => UNSTARTED_ENTRY_STATES.has(candidate.state))) {
      const cancelled = await deps.queueStore.transitionEntry(entry.id, {
        to: "cancelled",
        waitingReason: "Queue cancelled",
        now,
      });
      await detachFromQueueUmbrella(deps, cancelled, actor);
    }
  }
  return await queueView(deps, queue);
}

/** Skips an entry that has not started and returns its task to the backlog. */
export async function skipWorkQueueEntry(
  deps: WorkQueueServiceDeps,
  entryId: string,
  actor: WorkQueueActor,
): Promise<WorkQueueEntryView> {
  const skipped = await deps.queueStore.transitionEntry(entryId, {
    to: "skipped",
    waitingReason: "Skipped by a person",
    now: clock(deps),
  });
  await detachFromQueueUmbrella(deps, skipped, actor);
  const [view] = await decorateEntries(deps, [skipped]);
  return view ?? skipped;
}

interface LocatedEntry {
  readonly entry: WorkQueueEntry;
  readonly siblings: readonly WorkQueueEntry[];
}

/** Finds an entry in the organisation's open queues; a closed queue cannot take a retry. */
async function findEntryInOpenQueues(deps: WorkQueueServiceDeps, entryId: string): Promise<LocatedEntry | undefined> {
  const queues = await deps.queueStore.listQueues({ openOnly: true });
  for (const queue of queues) {
    const siblings = await deps.queueStore.listEntries(queue.id);
    const entry = siblings.find((candidate) => candidate.id === entryId);
    if (entry) return { entry, siblings };
  }
  return undefined;
}

export interface RetryWorkQueueEntryInput {
  /** Run the retry on this level instead of the task's current one (never chosen automatically). */
  readonly level?: string | undefined;
}

/**
 * Retries a failed, skipped or cancelled entry by adding a fresh entry for the
 * same task at the end of its queue. Terminal entries are never reopened, so
 * the history of the earlier attempt stays.
 */
export async function retryWorkQueueEntry(
  deps: WorkQueueServiceDeps,
  entryId: string,
  input: RetryWorkQueueEntryInput,
  actor: WorkQueueActor,
): Promise<WorkQueueEntryView> {
  const located = await findEntryInOpenQueues(deps, entryId);
  if (!located) throw new NotFoundError("work_queue_entry", entryId);
  const { entry, siblings } = located;
  if (!RETRYABLE_ENTRY_STATES.has(entry.state)) {
    throw customIssue("workQueueEntry", "state", `Cannot retry a ${entry.state} entry.`);
  }
  const { storage, store } = deps.t3;
  const task = await storage.getTask(entry.taskId);
  if (!task) throw new NotFoundError("task", entry.taskId);

  const now = clock(deps);
  const mapping = await store.getProjectMapping(task.projectId);
  if (input.level !== undefined) {
    const levels = await store.listRunLevels({ ...(mapping?.hostId ? { hostId: mapping.hostId } : {}), now });
    if (!levels.some((level) => level.key === input.level)) {
      throw customIssue("workQueueEntry", "level", `Run level "${input.level}" does not exist in this organisation.`);
    }
  }
  if (entry.umbrellaTaskId !== null && task.parentId !== undefined && task.parentId !== entry.umbrellaTaskId) {
    throw customIssue("workQueueEntry", "taskId", "The task was moved under another parent and cannot rejoin this queue.");
  }

  const resolved = await resolveTaskLaunchRunSelection(deps.t3, {
    taskId: task.id,
    projectId: task.projectId,
    hostId: mapping?.hostId ?? undefined,
    level: input.level,
    now,
  });
  const reattach = entry.umbrellaTaskId !== null && task.parentId === undefined;
  if (reattach) {
    // A skipped or cancelled task was detached; put it back under its queue umbrella.
    await assertHierarchyMutationAllowed(deps.t3, { action: "reparent", taskId: task.id });
    await storage.updateTask(task.id, { parentId: entry.umbrellaTaskId }, actorOptions(actor));
  }
  const position = siblings.reduce((highest, sibling) => Math.max(highest, sibling.position), -1) + 1;
  let retried: WorkQueueEntry;
  try {
    retried = await deps.queueStore.addEntry({
      id: newId(deps),
      queueId: entry.queueId,
      taskId: task.id,
      position,
      lane: entry.lane,
      resolvedSelection: resolved.selection ?? entry.resolvedSelection,
      umbrellaTaskId: entry.umbrellaTaskId,
      now,
    });
  } catch (error: unknown) {
    if (reattach) {
      try {
        await storage.updateTask(task.id, { parentId: null }, actorOptions(actor));
      } catch (detachError: unknown) {
        console.error("detaching a task after a failed work queue retry", { taskId: task.id, error: detachError });
      }
    }
    throw error;
  }
  const [view] = await decorateEntries(deps, [retried]);
  return view ?? retried;
}
