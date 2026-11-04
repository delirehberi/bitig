import {
  taskCode,
  whereYouLeftOff,
  type LeftOffTouch,
  type Project,
  type Task,
  type TaskStatus,
  type TaskTouchKind,
} from "@bitig/core";
import { History } from "lucide-react";
import { useMemo } from "react";
import { Link } from "../routing/Link";
import { hrefFor, taskHref, useLocationHref } from "../routing/router";
import { formatDayLabel, formatTimeAgo } from "../domain/time-ago";

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

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  archived: "Archived",
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

function TaskTitleLink({
  task,
  project,
  locationHref,
}: {
  readonly task: Task;
  readonly project: Project | undefined;
  readonly locationHref: string;
}) {
  const code = taskCode(task, project);
  return (
    <Link
      href={taskHref(code ?? task.id, locationHref)}
      className="flex min-w-0 items-baseline gap-2 text-ink hover:text-accent-ink hover:underline"
    >
      {code !== undefined && <span className="shrink-0 font-mono text-xs font-semibold text-ink-3">{code}</span>}
      <span className="truncate font-semibold">{task.title}</span>
    </Link>
  );
}

/** The project and tasks touched most recently, so a person can pick up where they stopped. */
export function WhereYouLeftOff({ projects, tasks, now = new Date() }: WhereYouLeftOffProps) {
  const locationHref = useLocationHref();
  const summary = useMemo(() => whereYouLeftOff(projects, tasks), [projects, tasks]);
  // In-progress work is listed by "Agents working now" and "Stalled" on the dashboard.
  const { lastProject, recent } = summary;
  if (lastProject === undefined) return null;

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
                      <div className="flex min-w-0 items-center justify-between gap-3">
                        <TaskTitleLink task={task} project={project} locationHref={locationHref} />
                        <span className="shrink-0 rounded-pill border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink-2">
                          {STATUS_LABELS[task.status]}
                        </span>
                      </div>
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
