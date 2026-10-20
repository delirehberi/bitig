/**
 * Pure domain rules shared by every storage adapter. Adapters persist the
 * entities these functions return; they never construct entities themselves,
 * so defaults, validation and timestamp rules live in exactly one place.
 */
import { COMPLETED_TASK_STATUS, TASK_ACTIVITY_MAX_ITEMS, WEBHOOK_TOKEN_PREFIX } from "./constants";
import { parseOrThrow } from "./errors";
import {
  CommentSchema,
  CreateCommentInputSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  CreateWebhookInputSchema,
  ProjectSchema,
  TaskActorSchema,
  TaskSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
  UpdateWebhookInputSchema,
  WebhookSchema,
} from "./schemas";
import type {
  ChecklistItem,
  Comment,
  CreateCommentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWebhookInput,
  Project,
  ProjectResource,
  Task,
  TaskActivityEntry,
  TaskPriority,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateWebhookInput,
  Webhook,
  WebhookMapping,
} from "./types";
import { toTimestamp, type RuntimeDeps } from "../runtime/ids";
import { assertProjectKeyAvailable, deriveProjectKey } from "./ticket-codes";

type TaskRequiredFields = Omit<
  Task,
  | "startedAt"
  | "completedAt"
  | "createdBy"
  | "startedBy"
  | "completedBy"
  | "updatedBy"
  | "activity"
  | "dueDate"
  | "priority"
  | "labels"
  | "order"
  | "checklist"
  | "needsHuman"
  | "number"
>;

interface TaskOptionalValues {
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;
  readonly createdBy: string | undefined;
  readonly startedBy: string | undefined;
  readonly completedBy: string | undefined;
  readonly updatedBy: string | undefined;
  readonly activity: readonly TaskActivityEntry[] | undefined;
  readonly dueDate: string | undefined;
  readonly priority: TaskPriority | undefined;
  readonly labels: readonly string[] | undefined;
  readonly order: number | undefined;
  readonly checklist: readonly ChecklistItem[] | undefined;
  readonly needsHuman: string | undefined;
  readonly number: number | undefined;
}

/** Builds a task that omits unset optional fields (exactOptionalPropertyTypes). */
function assembleTask(base: TaskRequiredFields, optional: TaskOptionalValues): Task {
  const task: Task = { ...base };
  if (optional.startedAt !== undefined) task.startedAt = optional.startedAt;
  if (optional.completedAt !== undefined) task.completedAt = optional.completedAt;
  if (optional.createdBy !== undefined) task.createdBy = optional.createdBy;
  if (optional.startedBy !== undefined) task.startedBy = optional.startedBy;
  if (optional.completedBy !== undefined) task.completedBy = optional.completedBy;
  if (optional.updatedBy !== undefined) task.updatedBy = optional.updatedBy;
  if (optional.activity !== undefined && optional.activity.length > 0) {
    task.activity = optional.activity.slice(-TASK_ACTIVITY_MAX_ITEMS).map((entry) => ({ ...entry }));
  }
  if (optional.dueDate !== undefined) task.dueDate = optional.dueDate;
  if (optional.priority !== undefined) task.priority = optional.priority;
  if (optional.labels !== undefined) task.labels = [...optional.labels];
  if (optional.order !== undefined) task.order = optional.order;
  // An empty checklist is the same as none, so every adapter stores it the same way.
  if (optional.checklist !== undefined && optional.checklist.length > 0) {
    task.checklist = optional.checklist.map((item) => ({ ...item }));
  }
  if (optional.needsHuman !== undefined) task.needsHuman = optional.needsHuman;
  if (optional.number !== undefined) task.number = optional.number;
  return task;
}

function stampChecklistOnCreate(
  checklist: readonly ChecklistItem[] | undefined,
  now: string,
): ChecklistItem[] | undefined {
  if (checklist === undefined || checklist.length === 0) return undefined;
  return checklist.map((item) => {
    const next: ChecklistItem = { text: item.text, done: item.done };
    if (item.startedAt !== undefined) next.startedAt = item.startedAt;
    if (item.done) next.completedAt = item.completedAt ?? now;
    return next;
  });
}

function stampChecklistOnUpdate(
  previous: readonly ChecklistItem[] | undefined,
  patch: readonly ChecklistItem[] | null | undefined,
  now: string,
): ChecklistItem[] | undefined {
  if (patch === undefined) return previous?.map((item) => ({ ...item }));
  if (patch === null || patch.length === 0) return undefined;

  const prevItems = previous ?? [];
  const usedPrev = new Set<number>();

  return patch.map((item, index) => {
    let matchedIndex: number | undefined;
    const sameSlot = prevItems[index];
    if (sameSlot !== undefined && !usedPrev.has(index) && sameSlot.text === item.text) {
      matchedIndex = index;
    } else {
      for (let j = 0; j < prevItems.length; j++) {
        if (!usedPrev.has(j) && prevItems[j]?.text === item.text) {
          matchedIndex = j;
          break;
        }
      }
      if (matchedIndex === undefined && prevItems.length === patch.length && !usedPrev.has(index)) {
        matchedIndex = index;
      }
    }

    if (matchedIndex !== undefined) usedPrev.add(matchedIndex);
    const matched = matchedIndex !== undefined ? prevItems[matchedIndex] : undefined;

    const next: ChecklistItem = { text: item.text, done: item.done };
    const startedAt = item.startedAt ?? matched?.startedAt;
    if (startedAt !== undefined) next.startedAt = startedAt;
    if (item.done) {
      next.completedAt = item.completedAt ?? (matched?.done ? matched.completedAt : undefined) ?? now;
    }
    return next;
  });
}

function resolveTaskLifecycleTimestamps(
  task: Task,
  nextStatus: Task["status"],
  updatedAt: string,
): { readonly startedAt: string | undefined; readonly completedAt: string | undefined } {
  switch (nextStatus) {
    case "todo":
      return { startedAt: undefined, completedAt: undefined };
    case "in_progress":
      return {
        startedAt: task.startedAt ?? updatedAt,
        completedAt: undefined,
      };
    case "done":
      return {
        startedAt: task.startedAt,
        completedAt: task.status === "done" ? (task.completedAt ?? updatedAt) : updatedAt,
      };
    case "archived":
      return {
        startedAt: task.startedAt,
        completedAt: task.completedAt,
      };
  }
}

function resolveTaskLifecycleActors(
  task: Task,
  nextStatus: Task["status"],
  actor: string | undefined,
): { readonly startedBy: string | undefined; readonly completedBy: string | undefined } {
  switch (nextStatus) {
    case "todo":
      return { startedBy: undefined, completedBy: undefined };
    case "in_progress":
      return {
        startedBy: task.startedBy ?? (task.startedAt === undefined ? actor : undefined),
        completedBy: undefined,
      };
    case "done":
      return {
        startedBy: task.startedBy,
        completedBy: task.status === "done" ? (task.completedBy ?? actor) : actor,
      };
    case "archived":
      return {
        startedBy: task.startedBy,
        completedBy: task.completedBy,
      };
  }
}

function buildUpdateActivityEntry(
  previousStatus: Task["status"],
  nextStatus: Task["status"],
  actor: string,
  timestamp: string,
): TaskActivityEntry {
  if (nextStatus !== previousStatus) {
    return {
      action: nextStatus === COMPLETED_TASK_STATUS ? "completed" : "status_changed",
      actor,
      timestamp,
      fromStatus: previousStatus,
      toStatus: nextStatus,
    };
  }
  return {
    action: "updated",
    actor,
    timestamp,
  };
}

/** `undefined` keeps the current value, `null` clears it, anything else replaces it. */
function resolveClearable<T>(current: T | undefined, patch: T | null | undefined): T | undefined {
  if (patch === undefined) return current;
  if (patch === null) return undefined;
  return patch;
}

/**
 * Returns the timestamp for a modification. Never earlier than the previous
 * `updatedAt`, so a clock that steps backwards cannot reorder history.
 */
function nextUpdatedAt(previous: string, now: Date): string {
  const candidate = toTimestamp(now);
  return Date.parse(candidate) >= Date.parse(previous) ? candidate : previous;
}

/** Adds resources only when there are some, as a copy; an empty list is the same as none. */
function withResources(
  project: Omit<Project, "resources">,
  resources: readonly ProjectResource[] | undefined,
): Project {
  const result: Project = { ...project };
  if (resources !== undefined && resources.length > 0) {
    result.resources = resources.map((resource) => ({ ...resource }));
  }
  return result;
}

/**
 * `takenKeys` are the keys of every existing project: a given key must not be among them, and a
 * derived one is made unique against them.
 */
export function buildProject(input: CreateProjectInput, deps: RuntimeDeps, takenKeys: Iterable<string>): Project {
  const parsed = parseOrThrow(CreateProjectInputSchema, input, "createProject");
  const taken = [...takenKeys];
  if (parsed.key !== undefined) assertProjectKeyAvailable(parsed.key, taken, "createProject");
  const now = toTimestamp(deps.clock());
  return parseOrThrow(
    ProjectSchema,
    withResources(
      {
        id: deps.generateId(),
        name: parsed.name,
        description: parsed.description,
        kind: parsed.kind,
        createdAt: now,
        updatedAt: now,
        key: parsed.key ?? deriveProjectKey(parsed.name, taken),
      },
      parsed.resources,
    ),
    "createProject result",
  );
}

/** `otherKeys` are the keys of every other project; a new key must not be among them. */
export function applyProjectPatch(
  project: Project,
  patch: UpdateProjectInput,
  now: Date,
  otherKeys: Iterable<string>,
): Project {
  const parsed = parseOrThrow(UpdateProjectInputSchema, patch, "updateProject");
  if (parsed.key !== undefined && parsed.key !== project.key) {
    assertProjectKeyAvailable(parsed.key, otherKeys, "updateProject");
  }
  const { resources, archived, ...rest } = project;
  const nextArchived =
    parsed.archived === undefined ? archived : parsed.archived === true ? (true as const) : undefined;
  return parseOrThrow(
    ProjectSchema,
    withResources(
      {
        ...rest,
        name: parsed.name ?? project.name,
        description: parsed.description ?? project.description,
        kind: parsed.kind ?? project.kind,
        updatedAt: nextUpdatedAt(project.updatedAt, now),
        ...(parsed.key !== undefined ? { key: parsed.key } : {}),
        ...(nextArchived !== undefined ? { archived: nextArchived } : {}),
      },
      resolveClearable(resources, parsed.resources),
    ),
    "updateProject result",
  );
}

/** `number` comes from `nextTaskNumber` over the target project's tasks. */
export function buildTask(
  input: CreateTaskInput,
  deps: RuntimeDeps,
  number: number,
  actor?: string,
): Task {
  const parsed = parseOrThrow(CreateTaskInputSchema, input, "saveTask");
  const validActor =
    actor === undefined ? undefined : parseOrThrow(TaskActorSchema, actor, "saveTask actor");
  const now = toTimestamp(deps.clock());
  const isStarted = parsed.status === "in_progress" || parsed.status === "done";
  const isCompleted = parsed.status === "done";
  const startedAt = isStarted ? now : undefined;
  const completedAt = isCompleted ? now : undefined;
  const activity: TaskActivityEntry[] | undefined =
    validActor === undefined
      ? undefined
      : [
          {
            action: "created",
            actor: validActor,
            timestamp: now,
            toStatus: parsed.status,
          },
        ];
  const task = assembleTask(
    {
      id: deps.generateId(),
      projectId: parsed.projectId,
      title: parsed.title,
      description: parsed.description,
      status: parsed.status,
      isPublic: parsed.isPublic,
      createdAt: now,
      updatedAt: now,
    },
    {
      startedAt,
      completedAt,
      createdBy: validActor,
      startedBy: isStarted ? validActor : undefined,
      completedBy: isCompleted ? validActor : undefined,
      updatedBy: validActor,
      activity,
      dueDate: parsed.dueDate,
      priority: parsed.priority,
      labels: parsed.labels,
      order: parsed.order,
      checklist: stampChecklistOnCreate(parsed.checklist, now),
      needsHuman: parsed.needsHuman,
      number,
    },
  );
  return parseOrThrow(TaskSchema, task, "saveTask result");
}

/**
 * Applies a patch. A task moved to another project keeps its old number here; adapters then give
 * it `nextTaskNumber` of the target project with `renumberTask`.
 */
export function applyTaskPatch(
  task: Task,
  patch: UpdateTaskInput,
  now: Date,
  actor?: string,
): Task {
  const parsed = parseOrThrow(UpdateTaskInputSchema, patch, "updateTask");
  const validActor =
    actor === undefined ? undefined : parseOrThrow(TaskActorSchema, actor, "updateTask actor");
  const updatedAt = nextUpdatedAt(task.updatedAt, now);
  const nextStatus = parsed.status ?? task.status;
  const { startedAt, completedAt } = resolveTaskLifecycleTimestamps(task, nextStatus, updatedAt);
  const { startedBy, completedBy } = resolveTaskLifecycleActors(task, nextStatus, validActor);
  const activity =
    validActor === undefined
      ? task.activity
      : [...(task.activity ?? []), buildUpdateActivityEntry(task.status, nextStatus, validActor, updatedAt)];
  const next = assembleTask(
    {
      id: task.id,
      projectId: parsed.projectId ?? task.projectId,
      title: parsed.title ?? task.title,
      description: parsed.description ?? task.description,
      status: nextStatus,
      isPublic: parsed.isPublic ?? task.isPublic,
      createdAt: task.createdAt,
      updatedAt,
    },
    {
      startedAt,
      completedAt,
      createdBy: task.createdBy,
      startedBy,
      completedBy,
      updatedBy: validActor,
      activity,
      dueDate: resolveClearable(task.dueDate, parsed.dueDate),
      priority: resolveClearable(task.priority, parsed.priority),
      labels: resolveClearable(task.labels, parsed.labels),
      order: resolveClearable(task.order, parsed.order),
      checklist: stampChecklistOnUpdate(task.checklist, parsed.checklist, updatedAt),
      needsHuman: resolveClearable(task.needsHuman, parsed.needsHuman),
      number: task.number,
    },
  );
  return parseOrThrow(TaskSchema, next, "updateTask result");
}

/** The task with a new number, e.g. after moving it to another project. */
export function renumberTask(task: Task, number: number): Task {
  return { ...cloneTask(task), number };
}

/**
 * Marks a task done. Idempotent: an already-done task is returned unchanged
 * (same `updatedAt`), so repeated MCP calls don't churn timestamps.
 */
export function completeTaskEntity(task: Task, now: Date, actor?: string): Task {
  const validActor =
    actor === undefined ? undefined : parseOrThrow(TaskActorSchema, actor, "completeTask actor");
  if (task.status === COMPLETED_TASK_STATUS) return task;
  const updatedAt = nextUpdatedAt(task.updatedAt, now);
  const activity =
    validActor === undefined
      ? task.activity
      : [
          ...(task.activity ?? []),
          buildUpdateActivityEntry(task.status, COMPLETED_TASK_STATUS, validActor, updatedAt),
        ];
  const next = assembleTask(
    {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      description: task.description,
      status: COMPLETED_TASK_STATUS,
      isPublic: task.isPublic,
      createdAt: task.createdAt,
      updatedAt,
    },
    {
      startedAt: task.startedAt,
      completedAt: updatedAt,
      createdBy: task.createdBy,
      startedBy: task.startedBy,
      completedBy: validActor,
      updatedBy: validActor,
      activity,
      dueDate: task.dueDate,
      priority: task.priority,
      labels: task.labels,
      order: task.order,
      checklist: task.checklist,
      needsHuman: task.needsHuman,
      number: task.number,
    },
  );
  return parseOrThrow(TaskSchema, next, "completeTask result");
}

export function buildComment(input: CreateCommentInput, deps: RuntimeDeps): Comment {
  const parsed = parseOrThrow(CreateCommentInputSchema, input, "addComment");
  const comment: Comment = {
    id: deps.generateId(),
    taskId: parsed.taskId,
    body: parsed.body,
    authorType: parsed.authorType,
    createdAt: toTimestamp(deps.clock()),
  };
  if (parsed.author !== undefined) comment.author = parsed.author;
  return parseOrThrow(CommentSchema, comment, "addComment result");
}

/** Comments carry no nested data, so a shallow copy is a full one. */
export function cloneComment(comment: Comment): Comment {
  return { ...comment };
}

/** Comments are listed oldest first, with `id` as a stable tiebreaker. */
export function compareComments(a: Comment, b: Comment): number {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** A deep copy: callers that mutate it never touch stored state. */
export function cloneProject(project: Project): Project {
  const copy = { ...project };
  if (project.resources !== undefined) {
    copy.resources = project.resources.map((resource) => ({ ...resource }));
  }
  return copy;
}

/** A deep copy: callers that mutate it never touch stored state. */
export function cloneTask(task: Task): Task {
  const copy = { ...task };
  if (task.labels !== undefined) copy.labels = [...task.labels];
  if (task.checklist !== undefined) copy.checklist = task.checklist.map((item) => ({ ...item }));
  if (task.activity !== undefined) copy.activity = task.activity.map((entry) => ({ ...entry }));
  return copy;
}

/**
 * Canonical task ordering every adapter must return: `order` ascending with
 * unset values last, then `createdAt`, then `id` as a stable tiebreaker.
 */
export function compareTasks(a: Task, b: Task): number {
  if (a.order !== b.order) {
    if (a.order === undefined) return 1;
    if (b.order === undefined) return -1;
    return a.order - b.order;
  }
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Projects are listed oldest first, with `id` as a stable tiebreaker. */
export function compareProjects(a: Project, b: Project): number {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function generateWebhookToken(deps: RuntimeDeps): string {
  const partA = deps.generateId().replaceAll("-", "");
  const partB = deps.generateId().replaceAll("-", "");
  return `${WEBHOOK_TOKEN_PREFIX}${partA}${partB}`;
}

function normalizeWebhookMapping(mapping: WebhookMapping | undefined): WebhookMapping | undefined {
  if (mapping === undefined) return undefined;
  const cleaned: WebhookMapping = {};
  if (mapping.title !== undefined) cleaned.title = mapping.title;
  if (mapping.description !== undefined) cleaned.description = mapping.description;
  if (mapping.priority !== undefined) cleaned.priority = mapping.priority;
  if (mapping.labels !== undefined) cleaned.labels = mapping.labels;
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function normalizeWebhookLabels(labels: readonly string[] | undefined): string[] | undefined {
  if (labels === undefined || labels.length === 0) return undefined;
  return [...labels];
}

export function buildWebhook(input: CreateWebhookInput, deps: RuntimeDeps): Webhook {
  const parsed = parseOrThrow(CreateWebhookInputSchema, input, "createWebhook");
  const now = toTimestamp(deps.clock());
  const id = deps.generateId();
  const token = generateWebhookToken(deps);
  const mapping = normalizeWebhookMapping(parsed.mapping);
  const defaultLabels = normalizeWebhookLabels(parsed.defaultLabels);

  const webhook: Webhook = {
    id,
    projectId: parsed.projectId,
    name: parsed.name,
    provider: parsed.provider,
    token,
    enabled: parsed.enabled,
    triggerCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  if (mapping !== undefined) webhook.mapping = mapping;
  if (parsed.defaultPriority !== undefined) webhook.defaultPriority = parsed.defaultPriority;
  if (defaultLabels !== undefined) webhook.defaultLabels = defaultLabels;
  return parseOrThrow(WebhookSchema, webhook, "createWebhook result");
}

export function applyWebhookPatch(webhook: Webhook, patch: UpdateWebhookInput, deps: RuntimeDeps): Webhook {
  const parsed = parseOrThrow(UpdateWebhookInputSchema, patch, "updateWebhook");
  const updatedAt = nextUpdatedAt(webhook.updatedAt, deps.clock());
  const mapping = normalizeWebhookMapping(resolveClearable(webhook.mapping, parsed.mapping));
  const defaultPriority = resolveClearable(webhook.defaultPriority, parsed.defaultPriority);
  const defaultLabels = normalizeWebhookLabels(resolveClearable(webhook.defaultLabels, parsed.defaultLabels));

  const next: Webhook = {
    id: webhook.id,
    projectId: parsed.projectId ?? webhook.projectId,
    name: parsed.name ?? webhook.name,
    provider: parsed.provider ?? webhook.provider,
    token: parsed.regenerateToken === true ? generateWebhookToken(deps) : webhook.token,
    enabled: parsed.enabled ?? webhook.enabled,
    triggerCount: webhook.triggerCount,
    createdAt: webhook.createdAt,
    updatedAt,
  };
  if (mapping !== undefined) next.mapping = mapping;
  if (defaultPriority !== undefined) next.defaultPriority = defaultPriority;
  if (defaultLabels !== undefined) next.defaultLabels = defaultLabels;
  if (webhook.lastTriggeredAt !== undefined) next.lastTriggeredAt = webhook.lastTriggeredAt;
  return parseOrThrow(WebhookSchema, next, "updateWebhook result");
}

export function recordWebhookTriggerEntity(webhook: Webhook, now: Date): Webhook {
  const triggeredAt = nextUpdatedAt(webhook.lastTriggeredAt ?? webhook.updatedAt, now);
  const next: Webhook = {
    ...cloneWebhook(webhook),
    triggerCount: webhook.triggerCount + 1,
    lastTriggeredAt: triggeredAt,
    updatedAt: nextUpdatedAt(webhook.updatedAt, now),
  };
  return parseOrThrow(WebhookSchema, next, "recordWebhookTrigger result");
}

export function cloneWebhook(webhook: Webhook): Webhook {
  const copy: Webhook = { ...webhook };
  if (webhook.mapping !== undefined) copy.mapping = { ...webhook.mapping };
  if (webhook.defaultLabels !== undefined) copy.defaultLabels = [...webhook.defaultLabels];
  return copy;
}

/** Webhooks are listed oldest first, with `id` as a stable tiebreaker. */
export function compareWebhooks(a: Webhook, b: Webhook): number {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}


/**
 * Projects most recently worked on first. A project's activity is the newest
 * `updatedAt` among the project and its tasks, so editing any task moves its
 * project up. Ties fall back to `compareProjects`.
 */
export function sortProjectsByActivity(
  projects: readonly Project[],
  tasks: readonly Task[],
): Project[] {
  const activity = new Map<string, number>();
  for (const project of projects) activity.set(project.id, Date.parse(project.updatedAt));
  for (const task of tasks) {
    const current = activity.get(task.projectId);
    if (current === undefined) continue;
    const touched = Date.parse(task.updatedAt);
    if (touched > current) activity.set(task.projectId, touched);
  }
  return [...projects].sort(
    (a, b) =>
      (activity.get(b.id) ?? 0) - (activity.get(a.id) ?? 0) || compareProjects(a, b),
  );
}
