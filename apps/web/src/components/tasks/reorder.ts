import type { Task } from "@bitig/core";

export interface OrderChange {
  readonly task: Task;
  readonly order: number;
}

/**
 * The `order` values to write so `task` lands at `index` in `column`, a board
 * column in `compareTasks` order (it may or may not contain `task` already).
 * Usually one write: the moved task takes a value between its new neighbours.
 * When the neighbours leave no room (unset orders, or equal values), the whole
 * column is renumbered 0..n-1 and only the tasks whose order changes are written.
 * `index` counts positions in the column without `task`; dropping a task where
 * it already is returns no changes.
 */
export function planMove(column: readonly Task[], task: Task, index: number): OrderChange[] {
  const rest = column.filter((t) => t.id !== task.id);
  const at = Math.max(0, Math.min(index, rest.length));
  if (column.findIndex((t) => t.id === task.id) === at) return [];
  const prev = rest[at - 1]?.order;
  const next = rest[at]?.order;
  const hasPrev = at > 0;
  const hasNext = at < rest.length;

  if (!hasPrev && !hasNext) return [{ task, order: task.order ?? 0 }];
  if (!hasPrev && next !== undefined) return [{ task, order: next - 1 }];
  if (!hasNext && prev !== undefined) return [{ task, order: prev + 1 }];
  if (prev !== undefined && next !== undefined) {
    const mid = (prev + next) / 2;
    if (mid > prev && mid < next) return [{ task, order: mid }];
  }

  const final = [...rest.slice(0, at), task, ...rest.slice(at)];
  return final.flatMap((t, i) => (t.id === task.id || t.order !== i ? [{ task: t, order: i }] : []));
}
