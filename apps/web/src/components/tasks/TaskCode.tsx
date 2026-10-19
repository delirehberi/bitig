import { taskCode, type Project, type Task } from "@bitig/core";

/** The task's ticket code (`BIT-12`), or nothing while the task has none. */
export function TaskCode({ task, project }: { readonly task: Task; readonly project: Project | undefined }) {
  const code = taskCode(task, project);
  if (code === undefined) return null;
  return (
    <span className="font-mono text-xs font-semibold text-ink-3" title="Ticket code">
      {code}
    </span>
  );
}
