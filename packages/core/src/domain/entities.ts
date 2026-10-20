/**
 * Pure domain rules shared by every storage adapter. Adapters persist the
 * entities these functions return; they never construct entities themselves,
 * so defaults, validation and timestamp rules live in exactly one place.
 */
import { COMPLETED_TASK_STATUS } from "./constants";
import { parseOrThrow } from "./errors";
import {
  CommentSchema,
  CreateCommentInputSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  ProjectSchema,
  TaskSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
} from "./schemas";
import type {
  ChecklistItem,
  Comment,
  CreateCommentInput,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectResource,
  Task,
  TaskPriority,
  UpdateProjectInput,
  UpdateTaskInput,
} from "./types";
import { toTimestamp, type RuntimeDeps } from "../runtime/ids";
import { assertProjectKeyAvailable, deriveProjectKey } from "./ticket-codes";

type TaskRequiredFields = Omit<Task, "dueDate" | "priority" | "labels" | "order" | "checklist" | "needsHuman" | "number">;

interface TaskOptionalValues {
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
  const { resources, ...rest } = project;
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
      },
      resolveClearable(resources, parsed.resources),
    ),
    "updateProject result",
  );
}

/** `number` comes from `nextTaskNumber` over the target project's tasks. */
export function buildTask(input: CreateTaskInput, deps: RuntimeDeps, number: number): Task {
  const parsed = parseOrThrow(CreateTaskInputSchema, input, "saveTask");
  const now = toTimestamp(deps.clock());
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
      dueDate: parsed.dueDate,
      priority: parsed.priority,
      labels: parsed.labels,
      order: parsed.order,
      checklist: parsed.checklist,
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
export function applyTaskPatch(task: Task, patch: UpdateTaskInput, now: Date): Task {
  const parsed = parseOrThrow(UpdateTaskInputSchema, patch, "updateTask");
  const next = assembleTask(
    {
      id: task.id,
      projectId: parsed.projectId ?? task.projectId,
      title: parsed.title ?? task.title,
      description: parsed.description ?? task.description,
      status: parsed.status ?? task.status,
      isPublic: parsed.isPublic ?? task.isPublic,
      createdAt: task.createdAt,
      updatedAt: nextUpdatedAt(task.updatedAt, now),
    },
    {
      dueDate: resolveClearable(task.dueDate, parsed.dueDate),
      priority: resolveClearable(task.priority, parsed.priority),
      labels: resolveClearable(task.labels, parsed.labels),
      order: resolveClearable(task.order, parsed.order),
      checklist: resolveClearable(task.checklist, parsed.checklist),
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
export function completeTaskEntity(task: Task, now: Date): Task {
  if (task.status === COMPLETED_TASK_STATUS) return task;
  return { ...task, status: COMPLETED_TASK_STATUS, updatedAt: nextUpdatedAt(task.updatedAt, now) };
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
