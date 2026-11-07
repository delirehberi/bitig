import { useState } from "react";
import { ExternalLink, Loader, Play, RefreshCw, Square } from "lucide-react";
import { taskCode, type Project, type Task } from "@bitig/core";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { taskHref, useLocationHref } from "../../routing/router";
import type { ResolvedProjectActiveSession } from "../projects/activeSessions";
import { ChecklistProgressBadge } from "../tasks/Checklist";
import { T3GitBadges } from "../tasks/T3GitBadges";
import { STATE_BADGE_CLASSES, STATE_LABELS } from "../tasks/t3-run-state";

interface WorkingNowProps {
  /** Active sessions (`queued`, `working`, or `waiting_subagent`), already ordered. */
  readonly sessions: readonly ResolvedProjectActiveSession[];
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly now: Date;
  readonly isLoading?: boolean | undefined;
  /** A failed load of T3 sessions; the list may be stale or empty because of it. */
  readonly error?: string | null | undefined;
  readonly onRetry?: (() => void) | undefined;
  readonly onDispatchQueuedRun?: ((taskId: string) => Promise<void>) | undefined;
  readonly onCancelQueuedRun?: ((taskId: string) => Promise<void>) | undefined;
}

function nextSubtask(task: Task | undefined): string | undefined {
  return task?.checklist?.find((item) => !item.done)?.text;
}

/** Every T3 thread an agent is working on, across projects. */
export function WorkingNow({
  sessions,
  projects,
  tasks,
  now,
  isLoading = false,
  error,
  onRetry,
  onDispatchQueuedRun,
  onCancelQueuedRun,
}: WorkingNowProps) {
  const locationHref = useLocationHref();
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string | undefined>>({});

  async function runQueuedAction(taskId: string, action: (id: string) => Promise<void>) {
    setBusyTaskId(taskId);
    setActionErrors((prev) => ({
      ...prev,
      [taskId]: undefined,
    }));
    try {
      await action(taskId);
    } catch (err) {
      setActionErrors((prev) => ({
        ...prev,
        [taskId]: err instanceof Error ? err.message : "Action failed",
      }));
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <section
      aria-labelledby="working-now-heading"
      className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <Loader size={18} className="text-ink-3" aria-hidden="true" />
        <h2 id="working-now-heading" className="m-0 font-display text-lg font-semibold text-ink">
          Agents working now
        </h2>
        <span className="rounded-pill bg-paper-3 px-2 py-0.5 font-mono text-xs font-semibold text-ink-2">
          {sessions.length}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/40 bg-danger-soft p-3 text-sm text-danger"
        >
          <span>Could not load T3 sessions: {error}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1 font-semibold hover:underline focus-visible:outline-focus"
            >
              <RefreshCw size={12} aria-hidden="true" />
              Retry
            </button>
          )}
        </div>
      )}

      {sessions.length === 0 ? (
        !error && (
          <p className="m-0 rounded-md border border-dashed border-rule bg-paper-2 p-4 text-sm text-ink-3">
            {isLoading ? "Checking T3 sessions…" : "No agent is working right now."}
          </p>
        )
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Agents working now">
          {sessions.map((session) => {
            const sessionTaskId = session.taskId;
            const task = sessionTaskId === undefined ? undefined : tasksById.get(sessionTaskId);
            const project = projectsById.get(session.projectId);
            const since = session.startedAt ?? session.updatedAt;
            const next = nextSubtask(task);
            const label = session.taskCode ? `${session.taskCode} ${session.title}` : session.title;
            const waitingForId = session.state === "waiting_subagent" ? session.waitingForTaskId : undefined;
            const waitingTask = waitingForId === undefined ? undefined : tasksById.get(waitingForId);
            const waitingProject =
              waitingTask === undefined ? undefined : projectsById.get(waitingTask.projectId);
            const waitingCode =
              session.waitingForTaskCode ??
              (waitingTask ? taskCode(waitingTask, waitingProject) : undefined);
            const waitingTitle = session.waitingForTaskTitle ?? waitingTask?.title;
            const waitingRef = waitingCode ?? waitingForId;
            const isTaskBusy = sessionTaskId !== undefined && busyTaskId === sessionTaskId;
            const taskError = sessionTaskId !== undefined ? actionErrors[sessionTaskId] : undefined;
            return (
              <li key={session.threadId} className="flex flex-col gap-1.5 rounded-md border border-rule bg-paper-2 p-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`shrink-0 rounded-pill border px-2 py-0.5 text-2xs font-semibold ${STATE_BADGE_CLASSES[session.state]}`}
                    >
                      {STATE_LABELS[session.state]}
                    </span>
                    {sessionTaskId === undefined ? (
                      <span className="truncate text-sm font-semibold text-ink">{session.title}</span>
                    ) : (
                      <Link
                        href={taskHref(session.taskCode ?? sessionTaskId, locationHref)}
                        aria-label={label}
                        className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-ink hover:text-accent-ink hover:underline"
                      >
                        {session.taskCode && (
                          <span className="shrink-0 font-mono text-xs text-ink-3">{session.taskCode}</span>
                        )}
                        <span className="truncate">{session.title}</span>
                      </Link>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ChecklistProgressBadge checklist={task?.checklist} />
                    {session.state === "queued" && sessionTaskId !== undefined && (
                      <>
                        {onDispatchQueuedRun && (
                          <button
                            type="button"
                            disabled={isTaskBusy}
                            onClick={() => {
                              void runQueuedAction(sessionTaskId, onDispatchQueuedRun);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-paper px-2 py-1 text-2xs font-semibold text-accent-ink transition-colors hover:bg-accent-soft focus-visible:outline-focus disabled:opacity-50"
                          >
                            <Play size={11} aria-hidden="true" />
                            <span>Dispatch now</span>
                          </button>
                        )}
                        {onCancelQueuedRun && (
                          <button
                            type="button"
                            disabled={isTaskBusy}
                            onClick={() => {
                              void runQueuedAction(sessionTaskId, onCancelQueuedRun);
                            }}
                            className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-paper px-2 py-1 text-2xs font-semibold text-danger transition-colors hover:bg-danger-soft focus-visible:outline-focus disabled:opacity-50"
                          >
                            <Square size={11} aria-hidden="true" />
                            <span>Cancel queued run</span>
                          </button>
                        )}
                      </>
                    )}
                    {session.link && (
                      <a
                        href={session.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${label} in T3`}
                        className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus"
                      >
                        <ExternalLink size={12} aria-hidden="true" />
                        <span>Open thread</span>
                      </a>
                    )}
                  </div>
                </div>
                {taskError && (
                  <p role="alert" className="m-0 text-xs text-danger">
                    {taskError}
                  </p>
                )}
                <span className="text-xs text-ink-3">
                  {project?.name ?? "Unknown project"}
                  {session.model && ` · ${session.model}`}
                  {since && (
                    <>
                      {session.state === "queued"
                        ? " · queued "
                        : session.startedAt
                          ? " · started "
                          : " · active "}
                      <time dateTime={since} title={formatFullTimestamp(since)}>
                        {formatTimeAgo(since, now)}
                      </time>
                    </>
                  )}
                </span>
                <T3GitBadges
                  branch={session.branch}
                  headSha={session.headSha}
                  diffStat={session.diffStat}
                  pullRequestUrls={session.pullRequestUrls}
                />
                {waitingRef !== undefined && (
                  <p className="m-0 flex flex-wrap items-center gap-1.5 text-sm text-ink-2">
                    <span className="font-semibold text-ink">Waiting on:</span>
                    <Link
                      href={taskHref(waitingRef, locationHref)}
                      className="inline-flex items-baseline gap-1 font-semibold text-accent-ink hover:underline"
                    >
                      <span className="font-mono text-xs">{waitingCode ? `#${waitingCode}` : waitingRef}</span>
                      {waitingTitle && <span>{waitingTitle}</span>}
                    </Link>
                    {session.waitingForThreadLink && (
                      <a
                        href={session.waitingForThreadLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-2xs font-medium text-accent-ink hover:underline"
                      >
                        <span>Child thread</span>
                        <ExternalLink size={11} aria-hidden="true" />
                      </a>
                    )}
                  </p>
                )}
                {next !== undefined && (
                  <p className="m-0 text-sm text-ink-2">
                    <span className="font-semibold text-ink">Next:</span> {next}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
