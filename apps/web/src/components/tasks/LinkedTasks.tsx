import type { DependencyLinks, TaskLinks, TaskLinkSummary } from "@bitig/core";
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

interface TaskLinkSectionProps {
  readonly id: string;
  readonly heading: string;
  readonly lists: readonly { readonly label: string; readonly tasks: readonly TaskLinkSummary[] }[];
}

/** A detail-view section of task lists shown as links; nothing when every list is empty. */
function TaskLinkSection({ id, heading, lists }: TaskLinkSectionProps) {
  if (lists.every((list) => list.tasks.length === 0)) return null;
  return (
    <section aria-labelledby={id} className="mb-5">
      <h3 id={id} className="m-0 mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
        {heading}
      </h3>
      <div className="flex flex-col gap-3">
        {lists.map((list) => (
          <LinkedTaskList key={list.label} label={list.label} tasks={list.tasks} />
        ))}
      </div>
    </section>
  );
}

/** The tasks a task mentions and the tasks that mention it, both as links; nothing when there are none. */
export function LinkedTasks({ links }: { readonly links: TaskLinks }) {
  return (
    <TaskLinkSection
      id="task-detail-links"
      heading="Linked tasks"
      lists={[
        { label: "Mentions", tasks: links.mentions },
        { label: "Mentioned in", tasks: links.mentionedIn },
      ]}
    />
  );
}

/** The tasks a task depends on and the tasks waiting on it, both as links; nothing when there are none. */
export function TaskDependencies({ dependencies }: { readonly dependencies: DependencyLinks }) {
  return (
    <TaskLinkSection
      id="task-detail-dependencies"
      heading="Dependencies"
      lists={[
        { label: "Depends on", tasks: dependencies.dependsOn },
        { label: "Blocks", tasks: dependencies.dependents },
      ]}
    />
  );
}
