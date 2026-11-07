import { useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Edit2,
  ExternalLink,
  FolderKanban,
  ListTodo,
  MessageSquare,
  Play,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import type { ActiveAgentRunState, Project, ProjectKind, Task } from "@bitig/core";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import { Link } from "../../routing/Link";
import { taskHref, useLocationHref } from "../../routing/router";
import { dispatchTaskT3Run, stopTaskT3Run } from "../../services/t3";
import { T3GitBadges } from "../tasks/T3GitBadges";
import type { ResolvedProjectActiveSession } from "./activeSessions";
import { ResourceLinks } from "./Resources";

const SESSION_STATE_LABELS: Record<ActiveAgentRunState, string> = {
  queued: "queued",
  working: "working",
  waiting_for_approval: "waiting for approval",
  waiting_subagent: "waiting for subagent",
};

const SESSION_BADGE_CLASSES: Record<ActiveAgentRunState, string> = {
  queued: "border-accent/40 bg-accent-soft text-accent-ink",
  working: "border-accent/40 bg-accent-soft text-accent-ink",
  waiting_for_approval: "border-danger/40 bg-danger-soft text-danger",
  waiting_subagent: "border-accent/40 bg-accent-soft text-accent-ink",
};

export function ProjectActiveSessionsList({
  projectId,
  sessions,
  onNavigateTask,
}: {
  readonly projectId: string;
  readonly sessions: readonly ResolvedProjectActiveSession[];
  readonly onNavigateTask?: (() => void) | undefined;
}) {
  const locationHref = useLocationHref();
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);
  if (sessions.length === 0) return null;

  async function handleDispatchQueued(taskId: string) {
    setBusyTaskId(taskId);
    try {
      const updated = await dispatchTaskT3Run(taskId);
      if (updated.run) {
        dispatchRealtimeEvent({ type: "agent_run.updated", run: updated.run });
      }
    } catch {
      // Errors surface on the task page or next refresh
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleCancelQueued(taskId: string) {
    setBusyTaskId(taskId);
    try {
      const updated = await stopTaskT3Run(taskId);
      if (updated.run) {
        dispatchRealtimeEvent({ type: "agent_run.updated", run: updated.run });
      }
    } catch {
      // Errors surface on the task page or next refresh
    } finally {
      setBusyTaskId(null);
    }
  }

  return (
    <div
      data-testid={`project-t3-sessions-${projectId}`}
      className="mt-3 flex flex-col gap-1.5 rounded-md border border-rule bg-paper-2 p-2.5"
    >
      <div className="flex items-center justify-between gap-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
        <span className="inline-flex items-center gap-1">
          <Terminal size={12} aria-hidden="true" />
          {sessions.length === 1
            ? "Active T3 session"
            : `Active T3 sessions (${String(sessions.length)})`}
        </span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {sessions.map((session) => {
          const sessionTaskId = session.taskId;
          const waitingCode = session.waitingForTaskCode;
          const waitingRef = waitingCode ?? session.waitingForTaskId;
          const isTaskBusy = sessionTaskId !== undefined && busyTaskId === sessionTaskId;
          return (
            <li
              key={session.threadId}
              className="flex flex-wrap items-center justify-between gap-2 text-xs"
            >
              <div className="flex min-w-0 flex-wrap items-baseline gap-1.5">
                {sessionTaskId ? (
                  <Link
                    href={taskHref(session.taskCode ?? sessionTaskId, locationHref)}
                    onClick={() => {
                      onNavigateTask?.();
                    }}
                    className="flex min-w-0 items-baseline gap-1.5 font-semibold text-ink hover:text-accent-ink hover:underline"
                  >
                    {session.taskCode && (
                      <span className="shrink-0 font-mono text-2xs text-ink-3">
                        {session.taskCode}
                      </span>
                    )}
                    <span className="truncate">{session.title}</span>
                  </Link>
                ) : (
                  <span className="truncate font-semibold text-ink">{session.title}</span>
                )}
                {session.state === "waiting_subagent" && waitingRef && (
                  <span className="inline-flex items-baseline gap-1 text-2xs text-ink-3">
                    <span>waiting on</span>
                    <Link
                      href={taskHref(waitingRef, locationHref)}
                      onClick={() => {
                        onNavigateTask?.();
                      }}
                      className="font-mono font-semibold text-accent-ink hover:underline"
                    >
                      {waitingCode ? `#${waitingCode}` : waitingRef}
                    </Link>
                    {session.waitingForThreadLink && (
                      <a
                        href={session.waitingForThreadLink}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${waitingCode ?? waitingRef} in T3`}
                        className="inline-flex items-center gap-0.5 text-accent-ink hover:underline"
                      >
                        <span>thread</span>
                        <ExternalLink size={10} aria-hidden="true" />
                      </a>
                    )}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <T3GitBadges
                  branch={session.branch}
                  headSha={session.headSha}
                  diffStat={session.diffStat}
                  pullRequestUrls={session.pullRequestUrls}
                />
                <span
                  className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 text-2xs font-semibold ${SESSION_BADGE_CLASSES[session.state]}`}
                >
                  {SESSION_STATE_LABELS[session.state]}
                  {session.model ? ` · ${session.model}` : ""}
                </span>
                {session.state === "queued" && sessionTaskId && (
                  <>
                    <button
                      type="button"
                      disabled={isTaskBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleDispatchQueued(sessionTaskId);
                      }}
                      className="inline-flex items-center gap-0.5 rounded-pill border border-accent/40 bg-paper px-2 py-0.5 text-2xs font-semibold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
                    >
                      <Play size={10} aria-hidden="true" />
                      <span>Dispatch now</span>
                    </button>
                    <button
                      type="button"
                      disabled={isTaskBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleCancelQueued(sessionTaskId);
                      }}
                      className="inline-flex items-center gap-0.5 rounded-pill border border-danger/40 bg-paper px-2 py-0.5 text-2xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
                    >
                      <Square size={10} aria-hidden="true" />
                      <span>Cancel queued run</span>
                    </button>
                  </>
                )}
                {session.link && (
                  <a
                    href={session.link}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`Open ${session.taskCode ?? session.title} in T3`}
                    title="Open in T3"
                    className="inline-flex items-center gap-0.5 rounded-pill border border-rule bg-paper px-1.5 py-0.5 text-2xs font-medium text-accent-ink hover:bg-paper-3"
                  >
                    <span>T3</span>
                    <ExternalLink size={10} aria-hidden="true" />
                  </a>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface ProjectCardProps {
  readonly project: Project;
  readonly tasks: Task[];
  readonly activeSessions?: readonly ResolvedProjectActiveSession[];
  readonly onEdit: (project: Project) => void;
  readonly onDelete: (project: Project) => void;
  readonly onSelect: (projectId: string) => void;
  readonly onView?: (project: Project) => void;
  /** Opens the project with its T3 message box focused (#BIT-127). */
  readonly onMessage?: (project: Project) => void;
  readonly onArchive?: (project: Project) => void;
  readonly onRecover?: (project: Project) => void;
}

const KIND_COLORS: Record<ProjectKind, string> = {
  hobby: "bg-paper-3 text-ink-2",
  paid: "bg-ok-soft text-ok",
  open_source: "bg-accent-soft text-accent-ink",
  personal: "bg-paper-3 text-ink",
  internal: "bg-rule-strong text-ink",
};

const ICON_SIZE = 14;

export function ProjectCard({
  project,
  tasks,
  activeSessions = [],
  onEdit,
  onDelete,
  onSelect,
  onView,
  onMessage,
  onArchive,
  onRecover,
}: ProjectCardProps) {
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const doneTasks = projectTasks.filter((t) => t.status === "done" || t.status === "archived");
  const isArchived = project.archived === true;

  if (isArchived) {
    return (
      <article className="group flex w-4/5 flex-col justify-between rounded-lg border border-rule/60 bg-paper px-3.5 py-2.5 opacity-80 transition-all hover:w-full hover:border-rule-strong hover:p-4 hover:opacity-100 hover:shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`shrink-0 rounded-pill px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
                KIND_COLORS[project.kind]
              }`}
            >
              {project.kind.replace("_", " ")}
            </span>
            {project.key && (
              <span className="shrink-0 font-mono text-2xs font-semibold text-ink-3" title="Key for ticket codes">
                {project.key}
              </span>
            )}
            <h3 className="m-0 truncate font-display text-sm font-bold text-ink">
              <button
                type="button"
                onClick={() => {
                  onView?.(project);
                }}
                title="View project details"
                className="cursor-pointer truncate text-left font-[inherit] text-[inherit] hover:underline focus-visible:outline-focus"
              >
                {project.name}
              </button>
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100">
            {onRecover && (
              <button
                type="button"
                onClick={() => {
                  onRecover(project);
                }}
                title="Recover project"
                aria-label={`Recover ${project.name}`}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper-2 px-2 py-1 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus"
              >
                <ArchiveRestore size={ICON_SIZE} />
                <span>Recover</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onDelete(project);
              }}
              title="Delete project"
              aria-label={`Delete ${project.name}`}
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </div>
        </div>

        <div className="mt-2 hidden items-center justify-between border-t border-rule pt-2 text-2xs text-ink-3 group-hover:flex">
          <div className="flex items-center gap-1">
            <ListTodo size={12} />
            <span>
              <strong className="font-semibold text-ink">{doneTasks.length}</strong> / {projectTasks.length} tasks
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect(project.id);
            }}
            className="flex items-center gap-1 text-2xs font-semibold text-accent-ink hover:underline focus-visible:outline-focus"
          >
            <FolderKanban size={12} />
            View tasks
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="flex flex-col justify-between rounded-lg border border-rule bg-paper p-5 transition-all hover:border-rule-strong hover:shadow-xs">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-pill px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                KIND_COLORS[project.kind]
              }`}
            >
              {project.kind.replace("_", " ")}
            </span>
            {project.key && (
              <span className="font-mono text-xs font-semibold text-ink-3" title="Key for ticket codes">
                {project.key}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            {onMessage && (
              <button
                type="button"
                onClick={() => {
                  onMessage(project);
                }}
                title="Message T3 without a task"
                aria-label={`Message ${project.name} in T3`}
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
              >
                <MessageSquare size={ICON_SIZE} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onEdit(project);
              }}
              title="Edit project"
              aria-label={`Edit ${project.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              <Edit2 size={ICON_SIZE} />
            </button>
            {onArchive && (
              <button
                type="button"
                onClick={() => {
                  onArchive(project);
                }}
                title="Archive project"
                aria-label={`Archive ${project.name}`}
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
              >
                <Archive size={ICON_SIZE} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onDelete(project);
              }}
              title="Delete project"
              aria-label={`Delete ${project.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </div>
        </div>

        <h3 className="m-0 mt-3 font-display text-base font-bold text-ink">
          <button
            type="button"
            onClick={() => {
              onView?.(project);
            }}
            title="View project details"
            className="cursor-pointer text-left font-[inherit] text-[inherit] hover:underline focus-visible:outline-focus"
          >
            {project.name}
          </button>
        </h3>
        {project.description ? (
          <p className="m-0 mt-1 line-clamp-2 text-xs text-ink-2">{project.description}</p>
        ) : (
          <p className="m-0 mt-1 text-xs italic text-ink-3">No description</p>
        )}
        <ResourceLinks resources={project.resources} />
        <ProjectActiveSessionsList projectId={project.id} sessions={activeSessions} />
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-rule pt-3">
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <ListTodo size={ICON_SIZE} />
          <span>
            <strong className="text-ink font-semibold">{doneTasks.length}</strong> / {projectTasks.length} tasks
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            onSelect(project.id);
          }}
          className="flex items-center gap-1 text-xs font-semibold text-accent-ink hover:underline focus-visible:outline-focus"
        >
          <FolderKanban size={ICON_SIZE} />
          View tasks
        </button>
      </div>
    </article>
  );
}

