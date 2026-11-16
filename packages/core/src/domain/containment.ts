/**
 * Explicit task containment (`parentId`): single-parent, same-project, acyclic hierarchy.
 *
 * Rules here require inspecting existing tasks, so every storage adapter runs them
 * atomically or under lock before persisting changes.
 */
import { ValidationError } from "./errors";
import type { Task } from "./types";

/** The subset of task fields needed to validate explicit containment. */
export type ContainmentNode = Pick<Task, "id" | "projectId" | "parentId">;

function containmentError(
  context: string,
  path: readonly (string | number)[],
  message: string,
  input: unknown,
): ValidationError {
  return new ValidationError(context, [{ code: "custom", path: [...path], message, input }]);
}

/**
 * Validates that `task.parentId` (when set):
 * - does not reference `task.id` itself,
 * - references an existing task in `tasks`,
 * - belongs to the same `projectId` as `task`, and
 * - does not introduce a cycle in the parent chain.
 *
 * A stored copy of `task` in `tasks` is overridden by `task` itself.
 */
export function assertTaskContainment(
  task: ContainmentNode,
  tasks: Iterable<ContainmentNode>,
  context: string,
): void {
  if (task.parentId === undefined) return;
  if (task.parentId === task.id) {
    throw containmentError(
      context,
      ["parentId"],
      `Task ${task.id} cannot be its own parent`,
      task.parentId,
    );
  }

  const byId = new Map<string, ContainmentNode>();
  for (const other of tasks) {
    byId.set(other.id, other);
  }
  byId.set(task.id, task);

  const parent = byId.get(task.parentId);
  if (parent === undefined) {
    throw containmentError(
      context,
      ["parentId"],
      `Unknown parent task ${task.parentId}`,
      task.parentId,
    );
  }

  if (parent.projectId !== task.projectId) {
    throw containmentError(
      context,
      ["parentId"],
      `Parent task ${task.parentId} must belong to the same project`,
      task.parentId,
    );
  }

  const path: string[] = [task.id];
  const visited = new Set<string>([task.id]);
  let current: string | undefined = task.parentId;
  while (current !== undefined) {
    path.push(current);
    if (visited.has(current)) {
      throw containmentError(
        context,
        ["parentId"],
        `Task hierarchy cycle: ${path.join(" \u2192 ")}`,
        path,
      );
    }
    visited.add(current);
    const node = byId.get(current);
    if (node === undefined) break;
    current = node.parentId;
  }
}

/**
 * Rejects changing `existing.projectId` to `nextProjectId` while the task still has a parent or
 * any child tasks. Callers must explicitly detach parent/children first.
 */
export function assertTaskProjectMoveAllowed(
  existing: ContainmentNode,
  nextProjectId: string,
  tasks: Iterable<ContainmentNode>,
  context: string,
): void {
  if (existing.projectId === nextProjectId) return;
  if (existing.parentId !== undefined) {
    throw containmentError(
      context,
      ["projectId"],
      `Cannot move task ${existing.id} to another project while it has a parent; detach parentId first`,
      nextProjectId,
    );
  }
  for (const other of tasks) {
    if (other.id !== existing.id && other.parentId === existing.id) {
      throw containmentError(
        context,
        ["projectId"],
        `Cannot move task ${existing.id} to another project while it has child tasks; detach or reparent children first`,
        nextProjectId,
      );
    }
  }
}

/**
 * Rejects deleting `taskId` while any task in `tasks` has `parentId === taskId`.
 */
export function assertTaskDeletable(
  taskId: string,
  tasks: Iterable<Pick<Task, "id" | "parentId">>,
  context: string,
): void {
  for (const other of tasks) {
    if (other.id !== taskId && other.parentId === taskId) {
      throw containmentError(
        context,
        ["id"],
        `Cannot delete task ${taskId} while it still has child tasks; detach or reparent children first`,
        taskId,
      );
    }
  }
}
