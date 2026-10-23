/**
 * "Where you left off": the project and tasks touched most recently, so a person
 * coming back after a day or two can see what they (or their agents) were on.
 * Built only from what every task already carries (`updatedAt`, lifecycle
 * timestamps, `activity`), so it works the same over every storage backend.
 */
import { compareTasks, sortProjectsByActivity } from "./entities";
import type { Project, Task } from "./types";

/** In-progress tasks shown at most; the rest are only counted. */
export const LEFT_OFF_IN_PROGRESS_LIMIT = 5;
/** Recently touched tasks shown at most. */
export const LEFT_OFF_RECENT_LIMIT = 8;

/** What the last touch on a task did, as far as its timestamps tell. */
export type TaskTouchKind = "created" | "started" | "completed" | "updated";

export interface LeftOffProject {
  readonly project: Project;
  /** The newest `updatedAt` among the project and its tasks. */
  readonly lastActiveAt: string;
  readonly inProgressCount: number;
  /** Tasks still to do or in progress. */
  readonly openCount: number;
}

export interface LeftOffTask {
  readonly task: Task;
  readonly project: Project | undefined;
  /** The first unchecked subtask: usually the next thing to pick up. */
  readonly nextSubtask: string | undefined;
}

export interface LeftOffTouch {
  readonly task: Task;
  readonly project: Project | undefined;
  readonly at: string;
  readonly kind: TaskTouchKind;
  /** The agent or actor behind the touch, when one was recorded. */
  readonly actor: string | undefined;
}

export interface WhereYouLeftOff {
  readonly lastProject: LeftOffProject | undefined;
  /** Newest touch first, at most `LEFT_OFF_IN_PROGRESS_LIMIT`. */
  readonly inProgress: readonly LeftOffTask[];
  /** Every in-progress task, including the ones not listed. */
  readonly inProgressCount: number;
  /** Newest touch first, at most `LEFT_OFF_RECENT_LIMIT`. */
  readonly recent: readonly LeftOffTouch[];
}

function compareByLastTouch(a: Task, b: Task): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || compareTasks(a, b);
}

/** The last touch on a task: what it did and who did it. */
export function lastTouch(task: Task): Pick<LeftOffTouch, "at" | "kind" | "actor"> {
  const at = task.updatedAt;
  const kind: TaskTouchKind =
    at === task.createdAt
      ? "created"
      : at === task.completedAt
        ? "completed"
        : at === task.startedAt
          ? "started"
          : "updated";
  const entry = task.activity?.at(-1);
  return { at, kind, actor: entry?.timestamp === at ? entry.actor : undefined };
}

/**
 * Summarizes where work stopped. Archived projects, their tasks and archived
 * tasks are left out.
 */
export function whereYouLeftOff(projects: readonly Project[], tasks: readonly Task[]): WhereYouLeftOff {
  const activeProjects = projects.filter((project) => project.archived !== true);
  const projectsById = new Map(activeProjects.map((project) => [project.id, project]));
  const liveTasks = tasks.filter((task) => task.status !== "archived" && projectsById.has(task.projectId));

  const inProgressTasks = liveTasks.filter((task) => task.status === "in_progress").sort(compareByLastTouch);
  const inProgress = inProgressTasks.slice(0, LEFT_OFF_IN_PROGRESS_LIMIT).map((task): LeftOffTask => ({
    task,
    project: projectsById.get(task.projectId),
    nextSubtask: task.checklist?.find((item) => !item.done)?.text,
  }));

  const recent = [...liveTasks]
    .sort(compareByLastTouch)
    .slice(0, LEFT_OFF_RECENT_LIMIT)
    .map((task): LeftOffTouch => ({ task, project: projectsById.get(task.projectId), ...lastTouch(task) }));

  return {
    lastProject: summarizeLastProject(activeProjects, liveTasks),
    inProgress,
    inProgressCount: inProgressTasks.length,
    recent,
  };
}

function summarizeLastProject(projects: readonly Project[], tasks: readonly Task[]): LeftOffProject | undefined {
  const project = sortProjectsByActivity(projects, tasks)[0];
  if (project === undefined) return undefined;
  const own = tasks.filter((task) => task.projectId === project.id);
  const lastActiveAt = own.reduce(
    (latest, task) => (Date.parse(task.updatedAt) > Date.parse(latest) ? task.updatedAt : latest),
    project.updatedAt,
  );
  return {
    project,
    lastActiveAt,
    inProgressCount: own.filter((task) => task.status === "in_progress").length,
    openCount: own.filter((task) => task.status !== "done" && task.status !== "archived").length,
  };
}
