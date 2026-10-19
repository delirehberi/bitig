/**
 * Pure domain rules shared by every storage adapter. Adapters persist the
 * entities these functions return; they never construct entities themselves,
 * so defaults, validation and timestamp rules live in exactly one place.
 */
import { COMPLETED_TASK_STATUS } from "./constants";
import { parseOrThrow } from "./errors";
import {
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  ProjectSchema,
  TaskSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
} from "./schemas";
import type {
  ChecklistItem,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  Task,
  TaskPriority,
  UpdateProjectInput,
  UpdateTaskInput,
} from "./types";
import { toTimestamp, type RuntimeDeps } from "../runtime/ids";

type TaskRequiredFields = Omit<Task, "dueDate" | "priority" | "labels" | "order" | "checklist">;

interface TaskOptionalValues {
  readonly dueDate: string | undefined;
  readonly priority: TaskPriority | undefined;
  readonly labels: readonly string[] | undefined;
  readonly order: number | undefined;
  readonly checklist: readonly ChecklistItem[] | undefined;
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

export function buildProject(input: CreateProjectInput, deps: RuntimeDeps): Project {
  const parsed = parseOrThrow(CreateProjectInputSchema, input, "createProject");
  const now = toTimestamp(deps.clock());
  return parseOrThrow(
    ProjectSchema,
    {
      id: deps.generateId(),
      name: parsed.name,
      description: parsed.description,
      kind: parsed.kind,
      createdAt: now,
      updatedAt: now,
    },
    "createProject result",
  );
}

export function applyProjectPatch(
  project: Project,
  patch: UpdateProjectInput,
  now: Date,
): Project {
  const parsed = parseOrThrow(UpdateProjectInputSchema, patch, "updateProject");
  return parseOrThrow(
    ProjectSchema,
    {
      ...project,
      name: parsed.name ?? project.name,
      description: parsed.description ?? project.description,
      kind: parsed.kind ?? project.kind,
      updatedAt: nextUpdatedAt(project.updatedAt, now),
    },
    "updateProject result",
  );
}

export function buildTask(input: CreateTaskInput, deps: RuntimeDeps): Task {
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
    },
  );
  return parseOrThrow(TaskSchema, task, "saveTask result");
}

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
    },
  );
  return parseOrThrow(TaskSchema, next, "updateTask result");
}

/**
 * Marks a task done. Idempotent: an already-done task is returned unchanged
 * (same `updatedAt`), so repeated MCP calls don't churn timestamps.
 */
export function completeTaskEntity(task: Task, now: Date): Task {
  if (task.status === COMPLETED_TASK_STATUS) return task;
  return { ...task, status: COMPLETED_TASK_STATUS, updatedAt: nextUpdatedAt(task.updatedAt, now) };
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

