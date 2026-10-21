import type { TaskLinks, TaskLinkSummary } from "@bitig/core";
import { Link } from "../../routing/Link";
import { hrefFor } from "../../routing/router";

const STATUS_LABELS: Record<TaskLinkSummary["status"], string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

function LinkedTaskList({ label, tasks }: { readonly label: string; readonly tasks: readonly TaskLinkSummary[] }) {
  if (tasks.length === 0) return null;
  return (
    <div>
      <h4 className="m-0 mb-1 text-xs font-semibold text-ink-2">{label}</h4>
      <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
        {tasks.map((task) => {
          const closed = task.status === "done" || task.status === "archived";
          return (
            <li key={task.id} className="flex min-w-0 items-baseline gap-2 text-sm">
              <Link
                href={hrefFor({ name: "tasks", taskRef: task.code ?? task.id })}
                className={`min-w-0 truncate text-ink hover:text-accent-ink focus-visible:outline-focus ${
                  closed ? "text-ink-3 line-through" : ""
                }`}
              >
                {task.code !== undefined && (
                  <span className="mr-1.5 font-mono text-xs font-semibold text-ink-3">{task.code}</span>
                )}
                {task.title}
              </Link>
              <span className="shrink-0 text-2xs text-ink-3">{STATUS_LABELS[task.status]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The tasks a task mentions and the tasks that mention it, both as links; nothing when there are none. */
export function LinkedTasks({ links }: { readonly links: TaskLinks }) {
  if (links.mentions.length === 0 && links.mentionedIn.length === 0) return null;
  return (
    <section aria-labelledby="task-detail-links" className="mb-5">
      <h3
        id="task-detail-links"
        className="m-0 mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3"
      >
        Linked tasks
      </h3>
      <div className="flex flex-col gap-3">
        <LinkedTaskList label="Mentions" tasks={links.mentions} />
        <LinkedTaskList label="Mentioned in" tasks={links.mentionedIn} />
      </div>
    </section>
  );
}
