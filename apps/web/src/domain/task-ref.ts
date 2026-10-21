import { findTaskByCode, parseTaskCode, taskCode, type Project, type Task } from "@bitig/core";

/**
 * How a URL names a task: its ticket code (`BIT-64`), or its ID while the task has no code
 * yet, so every task can still be linked to.
 */
export function taskRef(task: Task, projects: readonly Project[]): string {
  return taskCode(task, projects.find((p) => p.id === task.projectId)) ?? task.id;
}

/** Finds the task a ticket code (any case) or task ID points at, among the loaded tasks. */
export function findTaskByRef(ref: string, projects: readonly Project[], tasks: readonly Task[]): Task | undefined {
  const code = parseTaskCode(ref);
  return (code === null ? undefined : findTaskByCode(code, projects, tasks)) ?? tasks.find((t) => t.id === ref);
}
