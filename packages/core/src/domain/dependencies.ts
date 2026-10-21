/**
 * Task dependencies: `dependsOn` lists the IDs of the tasks a task waits on. The schema
 * rejects duplicates; the rules here need the other tasks, so every adapter runs them
 * against its stored tasks before it writes.
 */
import { ValidationError } from "./errors";
import type { Task } from "./types";

/** The part of a task the dependency graph needs. */
export type DependencyNode = Pick<Task, "id" | "dependsOn">;

function dependencyError(context: string, message: string, input: unknown): ValidationError {
  return new ValidationError(context, [{ code: "custom", path: ["dependsOn"], message, input }]);
}

/**
 * Whether `next` waits on a task that `previous` did not. Only an added dependency can be
 * missing or close a cycle, so adapters skip loading the graph when this is false.
 */
export function hasNewDependencies(previous: DependencyNode | undefined, next: DependencyNode): boolean {
  if (next.dependsOn === undefined) return false;
  const before = new Set(previous?.dependsOn);
  return next.dependsOn.some((id) => !before.has(id));
}

/**
 * Rejects with `ValidationError` when `task` depends on itself, on a task that is not in `tasks`,
 * or on a task that (directly or through others) already depends on it. `tasks` is every stored
 * task; a stored copy of `task` itself is ignored in favour of `task`.
 */
export function assertTaskDependencies(
  task: DependencyNode,
  tasks: Iterable<DependencyNode>,
  context: string,
): void {
  const dependsOn = task.dependsOn ?? [];
  if (dependsOn.includes(task.id)) {
    throw dependencyError(context, `Task ${task.id} cannot depend on itself`, task.id);
  }

  const graph = new Map<string, readonly string[]>();
  for (const other of tasks) graph.set(other.id, other.dependsOn ?? []);
  graph.set(task.id, dependsOn);

  const missing = dependsOn.filter((id) => !graph.has(id));
  if (missing.length > 0) {
    throw dependencyError(context, `Unknown task ${missing.join(", ")}`, missing);
  }

  const cycle = findCycleThrough(task.id, graph);
  if (cycle !== undefined) {
    throw dependencyError(context, `Dependency cycle: ${cycle.join(" → ")}`, cycle);
  }
}

/** A path `start → … → start` along dependencies, or `undefined` when there is none. */
function findCycleThrough(start: string, graph: ReadonlyMap<string, readonly string[]>): string[] | undefined {
  const visited = new Set<string>();
  const path: string[] = [start];

  const visit = (id: string): boolean => {
    for (const next of graph.get(id) ?? []) {
      if (next === start) {
        path.push(start);
        return true;
      }
      if (visited.has(next)) continue;
      visited.add(next);
      path.push(next);
      if (visit(next)) return true;
      path.pop();
    }
    return false;
  };

  return visit(start) ? path : undefined;
}

/**
 * `task` without any dependency on `removedIds`, or `undefined` when it had none. Used when
 * tasks are deleted; `updatedAt` stays, since nobody edited the task.
 */
export function withoutDependencies(task: Task, removedIds: ReadonlySet<string>): Task | undefined {
  if (!task.dependsOn?.some((id) => removedIds.has(id))) return undefined;
  const { dependsOn = [], ...rest } = task;
  const kept = dependsOn.filter((id) => !removedIds.has(id));
  return kept.length > 0 ? { ...rest, dependsOn: kept } : rest;
}
