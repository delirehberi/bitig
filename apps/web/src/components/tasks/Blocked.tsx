import { useContext } from "react";
import { Ban } from "lucide-react";
import type { Task } from "@bitig/core";
import { TaskBlockersContext } from "../../domain/task-mentions";

/** Pill for cards and rows naming the unfinished tasks this one waits on; nothing when it is free to start. */
export function BlockedBadge({ task }: { readonly task: Pick<Task, "dependsOn" | "status"> }) {
  const blockersOf = useContext(TaskBlockersContext);
  // A finished task no longer waits on anything.
  if (blockersOf === undefined || task.status === "done" || task.status === "archived") return null;
  const blockedBy = blockersOf(task);
  if (blockedBy.length === 0) return null;
  return (
    <span
      title={`Blocked by ${blockedBy.join(", ")}`}
      className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-danger/30 bg-danger-soft px-2 py-0.5 text-2xs font-semibold text-danger"
    >
      <Ban size={11} aria-hidden="true" />
      Blocked
    </span>
  );
}
