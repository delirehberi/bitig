import {
  taskCode,
  whereYouLeftOff,
  type LeftOffTouch,
  type Project,
  type Task,
  type TaskTouchKind,
} from "@bitig/core";
import { History } from "lucide-react";
import { useMemo } from "react";
import { Link } from "../routing/Link";
import { hrefFor } from "../routing/router";
import { formatDayLabel, formatTimeAgo } from "../domain/time-ago";
import { ChecklistProgressBadge } from "./tasks/Checklist";

interface WhereYouLeftOffProps {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  /** The current time; tests pass a fixed one. */
  readonly now?: Date;
}

const TOUCH_LABELS: Record<TaskTouchKind, string> = {
  created: "Created",
  started: "Started",
  completed: "Completed",
  updated: "Updated",
};

function groupByDay(touches: readonly LeftOffTouch[], now: Date): { label: string; touches: LeftOffTouch[] }[] {
  const groups: { label: string; touches: LeftOffTouch[] }[] = [];
  for (const touch of touches) {
    const label = formatDayLabel(touch.at, now);
    const last = groups.at(-1);
    if (last?.label === label) last.touches.push(touch);
    else groups.push({ label, touches: [touch] });
  }
  return groups;
}

function taskHref(task: Task, project: Project | undefined): string {
  return hrefFor({ name: "tasks", projectId: task.projectId, taskRef: taskCode(task, project) ?? task.id });
}

function TaskTitleLink({ task, project }: { readonly task: Task; readonly project: Project | undefined }) {
  const code = taskCode(task, project);
  return (
    <Link
      href={taskHref(task, project)}
      className="flex min-w-0 items-baseline gap-2 text-ink hover:text-accent-ink hover:underline"
    >
      {code !== undefined && <span className="shrink-0 font-mono text-xs font-semibold text-ink-3">{code}</span>}
      <span className="truncate font-semibold">{task.title}</span>
    </Link>
  );
}

/** The project and tasks touched most recently, so a person can pick up where they stopped. */
export function WhereYouLeftOff({ projects, tasks, now = new Date() }: WhereYouLeftOffProps) {
  const summary = useMemo(() => whereYouLeftOff(projects, tasks), [projects, tasks]);
  const { lastProject, inProgress, inProgressCount, recent } = summary;
  if (lastProject === undefined) return null;

  const hiddenInProgress = inProgressCount - inProgress.length;

  return (
    <section
      aria-labelledby="left-off-heading"
      className="flex flex-col gap-6 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <History size={18} className="text-ink-3" aria-hidden="true" />
        <h2 id="left-off-heading" className="m-0 font-display text-lg font-semibold text-ink">
          Pick up where you left off
        </h2>
      </div>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-start">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2" data-testid="left-off-project">
            <h3 className="m-0 font-display text-xs font-semibold uppercase tracking-wider text-ink-3">
              Last project
            </h3>
            <div className="flex flex-col gap-1 rounded-md border border-rule bg-paper-2 p-4">
              <Link
                href={hrefFor({ name: "tasks", projectId: lastProject.project.id })}
                className="font-display text-xl font-bold text-ink hover:text-accent-ink hover:underline"
              >
                {lastProject.project.name}
              </Link>
              <p className="m-0 text-sm text-ink-2">
                Active {formatTimeAgo(lastProject.lastActiveAt, now)}
                {" · "}
                {lastProject.inProgressCount} in progress
                {" · "}
                {lastProject.openCount} open
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-2" data-testid="left-off-in-progress">
            <h3 className="m-0 font-display text-xs font-semibold uppercase tracking-wider text-ink-3">
              In progress
            </h3>
            {inProgress.length === 0 ? (
              <p className="m-0 rounded-md border border-dashed border-rule bg-paper-2 p-4 text-sm text-ink-3">
                Nothing in progress. Start something from{" "}
                <Link href={hrefFor({ name: "tasks" })} className="font-semibold text-accent-ink hover:underline">
                  Tasks
                </Link>
                .
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {inProgress.map(({ task, project, nextSubtask }) => (
                  <li key={task.id} className="flex flex-col gap-1 rounded-md border border-rule bg-paper-2 p-3">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <TaskTitleLink task={task} project={project} />
                      <ChecklistProgressBadge checklist={task.checklist} />
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-ink-3">
                      <span>{project?.name}</span>
                      <span aria-hidden="true">·</span>
                      <span>{formatTimeAgo(task.updatedAt, now)}</span>
                    </div>
                    {nextSubtask !== undefined && (
                      <p className="m-0 text-sm text-ink-2">
                        <span className="font-semibold text-ink">Next:</span> {nextSubtask}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {hiddenInProgress > 0 && (
              <p className="m-0 text-xs text-ink-3">
                and {hiddenInProgress} more in progress
              </p>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2" data-testid="left-off-recent">
          <h3 className="m-0 font-display text-xs font-semibold uppercase tracking-wider text-ink-3">
            Recent activity
          </h3>
          <div className="flex flex-col gap-4">
            {groupByDay(recent, now).map((group) => (
              <div key={group.label} className="flex flex-col gap-1">
                <h4 className="m-0 text-sm font-semibold text-ink-2">{group.label}</h4>
                <ul className="m-0 flex list-none flex-col p-0">
                  {group.touches.map(({ task, project, at, kind, actor }) => (
                    <li
                      key={task.id}
                      className="flex flex-col gap-0.5 border-t border-rule py-2 first:border-t-0"
                    >
                      <TaskTitleLink task={task} project={project} />
                      <span className="text-xs text-ink-3">
                        {TOUCH_LABELS[kind]}
                        {actor !== undefined && ` by ${actor}`}
                        {" · "}
                        {new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
                        {project !== undefined && ` · ${project.name}`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
