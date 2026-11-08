import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Edit2,
  ExternalLink,
  Hand,
  Link2,
  MoreHorizontal,
  ShieldCheck,
  ShieldQuestionMark,
  Trash2,
} from "lucide-react";
import {
  checklistProgress,
  formatDuration,
  getTaskTiming,
  taskCode,
  type AgentRun,
  type Checkpoint,
  type ChecklistItem,
  type Comment,
  type DependencyLinks,
  type Project,
  type StorageProvider,
  type T3ModelCapability,
  type Task,
  type TaskActivityEntry,
  type TaskLinks,
  type TaskPriority,
  type TaskStatus,
} from "@bitig/core";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { taskRef } from "../../domain/task-ref";
import { useCheckpoints } from "../../hooks/useCheckpoints";
import { useComments } from "../../hooks/useComments";
import { Link } from "../../routing/Link";
import { hrefFor, taskHref, taskPageHref, useLocationHref } from "../../routing/router";
import { Markdown } from "../Markdown";
import { ChecklistView } from "./Checklist";
import { TaskAttachments } from "./TaskAttachments";
import {
  agentNameForT3,
  TaskComposer,
  type TaskCommentsT3Context,
} from "./TaskComments";
import { TaskT3Section } from "./TaskT3Section";
import { STATE_LABELS } from "./t3-run-state";

export interface TaskDetailPageProps {
  readonly task: Task;
  readonly projects: Project[];
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
  readonly onArchive?: ((task: Task) => void) | undefined;
  readonly onMoveToBacklog?: ((task: Task) => void) | undefined;
  readonly onChecklistChange?: ((task: Task, checklist: ChecklistItem[]) => Promise<unknown>) | undefined;
  readonly onNeedsHumanResolve?: ((task: Task) => void) | undefined;
  readonly onApprove?: ((task: Task) => void) | undefined;
  readonly storage?: StorageProvider | undefined;
  readonly links?: TaskLinks | undefined;
  readonly dependencies?: DependencyLinks | undefined;
  readonly agentRun?: AgentRun | null | undefined;
  readonly onTaskUpdated?: ((task: Task) => void) | undefined;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  archived: "Archived",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  trivial: "Trivial",
};

const PRIORITY_BADGES: Record<TaskPriority, string> = {
  urgent: "bg-danger-soft text-danger border-danger/30 font-bold",
  high: "bg-accent-soft text-accent-ink border-accent/30 font-semibold",
  medium: "bg-rule-strong text-ink border-rule",
  low: "bg-paper-3 text-ink-2 border-rule",
  trivial: "bg-paper-3 text-ink-3 border-rule",
};

function initialsFor(name: string): string {
  const parts = name
    .trim()
    .split(/[\s_-]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  }
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

function formatActivityAction(entry: TaskActivityEntry): string {
  switch (entry.action) {
    case "created":
      return entry.toStatus && entry.toStatus !== "todo"
        ? `created task in ${STATUS_LABELS[entry.toStatus]}`
        : "created task";
    case "status_changed":
      if (entry.fromStatus && entry.toStatus) {
        return `moved from ${STATUS_LABELS[entry.fromStatus]} to ${STATUS_LABELS[entry.toStatus]}`;
      }
      return entry.toStatus ? `moved to ${STATUS_LABELS[entry.toStatus]}` : "changed status";
    case "completed":
      return "completed task";
    case "updated":
      return "updated task";
    case "dependency_override": {
      const verb = entry.toStatus === "done" ? "completed" : "started";
      return `${verb} despite unfinished ${entry.blockedBy?.join(", ") ?? "dependencies"}`;
    }
  }
}

type TimelineItem =
  | {
      readonly kind: "comment";
      readonly id: string;
      readonly timestamp: string;
      readonly sortOrder: number;
      readonly comment: Comment;
    }
  | {
      readonly kind: "event";
      readonly id: string;
      readonly timestamp: string;
      readonly sortOrder: number;
      readonly eventType:
        | "run_started"
        | "run_ended"
        | "checkpoint"
        | "activity"
        | "needs_human_set"
        | "needs_human_cleared";
      readonly actor?: string | undefined;
      readonly text: string;
      readonly monoDetail?: string | undefined;
    };

function parseTimeMs(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Dedicated full-page task detail view (#BIT-168) structured as a chat-style thread:
 * description with subtasks first, followed by comments and inline events in chronological order,
 * a pinned composer and action bar at the bottom, and a side rail that collapses on narrow screens.
 */
export function TaskDetailPage({
  task,
  projects,
  onEdit,
  onDelete,
  onComplete,
  onStatusChange,
  onArchive,
  onMoveToBacklog,
  onChecklistChange,
  onNeedsHumanResolve,
  onApprove,
  storage,
  links,
  dependencies,
  agentRun,
  onTaskUpdated,
}: TaskDetailPageProps) {
  const locationHref = useLocationHref();
  const [pendingChecklist, setPendingChecklist] = useState<{
    readonly taskId: string;
    readonly items: ChecklistItem[];
  } | null>(null);
  const latestToggle = useRef(0);
  const [t3Context, setT3Context] = useState<
    (TaskCommentsT3Context & { readonly taskId: string }) | null
  >(null);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [needsHumanClearedAt, setNeedsHumanClearedAt] = useState<string | null>(null);
  const prevNeedsHumanRef = useRef<string | undefined>(task.needsHuman);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (prevNeedsHumanRef.current !== undefined && task.needsHuman === undefined) {
      setNeedsHumanClearedAt(new Date().toISOString());
    }
    prevNeedsHumanRef.current = task.needsHuman;
  }, [task.needsHuman]);

  useEffect(() => {
    if (!moreMenuOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setMoreMenuOpen(false);
      }
    }
    function handlePointerDown(e: MouseEvent) {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("mousedown", handlePointerDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("mousedown", handlePointerDown);
    };
  }, [moreMenuOpen]);

  const handleT3ContextChange = useCallback(
    (context: { run: AgentRun | null; capabilities: T3ModelCapability[] }) => {
      const run = context.run;
      setT3Context(run ? { taskId: run.taskId, run, capabilities: context.capabilities } : null);
    },
    [],
  );

  const project = projects.find((p) => p.id === task.projectId);
  const code = taskCode(task, project) ?? task.id;
  const isDone = task.status === "done" || task.status === "archived";
  const checklist = pendingChecklist?.taskId === task.id ? pendingChecklist.items : task.checklist;
  const subtaskStats = checklistProgress(checklist);
  const timing = getTaskTiming(task);
  const spentMs =
    task.startedAt !== undefined || task.completedAt !== undefined ? timing.spentMs : undefined;

  const activeRun =
    t3Context?.taskId === task.id
      ? t3Context.run
      : agentRun?.taskId === task.id
        ? agentRun
        : null;
  const effectiveT3Context: TaskCommentsT3Context | undefined =
    t3Context?.taskId === task.id
      ? t3Context
      : activeRun
        ? { run: activeRun, capabilities: [] }
        : undefined;

  function toggleChecklist(current: Task, next: ChecklistItem[]) {
    if (!onChecklistChange) return;
    const toggle = ++latestToggle.current;
    setPendingChecklist({ taskId: current.id, items: next });
    void onChecklistChange(current, next)
      .catch(() => undefined)
      .finally(() => {
        if (latestToggle.current === toggle) setPendingChecklist(null);
      });
  }

  function handleCopyLink() {
    const shareUrl = new URL(taskPageHref( taskRef(task, projects) ), window.location.origin).href;
    void navigator.clipboard?.writeText(shareUrl).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  const creatorName = task.createdBy ?? "You";
  const isWaitingForHuman =
    activeRun?.state === "waiting_for_approval" || task.needsHuman !== undefined;

  return (
    <div
      data-testid="task-detail-page"
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2.5 border-b border-rule pb-3">
        <Link
          href={hrefFor({ name: "tasks" })}
          aria-label="Back to Tasks"
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-3 transition-colors hover:text-ink focus-visible:outline-focus"
        >
          <ChevronLeft size={14} aria-hidden="true" />
          <span>Tasks</span>
        </Link>
        <span className="min-w-0 truncate text-xs text-ink-3">
          {project ? `${project.name} / ` : ""}
          <strong className="font-mono font-semibold text-ink">{code}</strong>
        </span>

        <span className="flex-1" />

        {activeRun?.link && (
          <a
            href={activeRun.link}
            target="_blank"
            rel="noreferrer"
            className="hidden items-center gap-1.5 rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus sm:inline-flex"
          >
            <span>Open in T3</span>
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}

        <button
          type="button"
          onClick={handleCopyLink}
          aria-label="Copy link"
          title={copied ? "Copied!" : "Copy link"}
          className="inline-flex size-7 items-center justify-center rounded-md border border-rule bg-paper text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
        >
          {copied ? <Check size={13} aria-hidden="true" /> : <Link2 size={13} aria-hidden="true" />}
        </button>
      </div>

      {/* Header */}
      <header className="border-b border-rule py-3.5">
        <h1
          className={`m-0 mb-2 font-display text-xl font-bold tracking-tight text-ink ${
            isDone ? "line-through text-ink-3" : ""
          }`}
        >
          {task.title}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-pill border border-rule bg-paper-2 px-2.5 py-0.5 text-2xs font-semibold text-ink-2">
            {STATUS_LABELS[task.status]}
          </span>
          {task.priority && (
            <span
              className={`rounded-pill border px-2.5 py-0.5 text-2xs uppercase tracking-wider ${
                PRIORITY_BADGES[task.priority]
              }`}
            >
              {PRIORITY_LABELS[task.priority]}
            </span>
          )}
          {task.pendingApproval === true && (
            <span className="inline-flex items-center gap-1 rounded-pill border border-dashed border-rule-strong bg-paper-3 px-2.5 py-0.5 text-2xs font-semibold text-ink">
              <ShieldQuestionMark size={11} aria-hidden="true" />
              Awaiting approval
            </span>
          )}
          {isWaitingForHuman && (
            <WaitingChip t3={effectiveT3Context} needsHuman={task.needsHuman} />
          )}
          {spentMs !== undefined && (
            <span
              title="Active time spent on this task"
              className="inline-flex items-center gap-1 rounded-pill border border-accent/30 bg-accent-soft px-2.5 py-0.5 font-mono text-2xs font-semibold text-accent-ink"
            >
              <Clock size={11} aria-hidden="true" />
              {formatDuration(spentMs)}
            </span>
          )}
        </div>
      </header>

      {/* Shell: Main column (scrolling thread + pinned dock) and Side rail (collapsible on narrow screens) */}
      <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[minmax(0,1fr)_220px]">
        {/* Main column */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:border-r md:border-rule">
          {storage ? (
            <ThreadWithStorage
              key={task.id}
              task={task}
              storage={storage}
              creatorName={creatorName}
              checklist={checklist}
              onChecklistToggle={
                onChecklistChange
                  ? (next) => {
                      toggleChecklist(task, next);
                    }
                  : undefined
              }
              t3={effectiveT3Context}
              needsHumanClearedAt={needsHumanClearedAt}
              onNeedsHumanResolve={
                task.needsHuman !== undefined && onNeedsHumanResolve
                  ? () => {
                      onNeedsHumanResolve(task);
                    }
                  : undefined
              }
              actionRow={
                <ActionRow
                  task={task}
                  isDone={isDone}
                  moreMenuOpen={moreMenuOpen}
                  setMoreMenuOpen={setMoreMenuOpen}
                  moreMenuRef={moreMenuRef}
                  onStatusChange={onStatusChange}
                  onComplete={onComplete}
                  onEdit={onEdit}
                  onArchive={onArchive}
                  onMoveToBacklog={onMoveToBacklog}
                  onDelete={onDelete}
                  onApprove={onApprove}
                />
              }
            />
          ) : (
            <>
              <div
                data-testid="task-thread"
                className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4 md:pr-4"
              >
                <DescriptionMessage
                  task={task}
                  creatorName={creatorName}
                  checklist={checklist}
                  onChecklistToggle={
                    onChecklistChange
                      ? (next) => {
                          toggleChecklist(task, next);
                        }
                      : undefined
                  }
                />
                <TimelineList
                  items={buildTimelineItems({
                    task,
                    comments: [],
                    checkpoints: [],
                    run: activeRun,
                    agentName: agentNameForT3(effectiveT3Context),
                    needsHumanClearedAt,
                  })}
                  task={task}
                  agentName={agentNameForT3(effectiveT3Context)}
                  isWaitingForHuman={isWaitingForHuman}
                />
              </div>
              <div
                data-testid="task-dock"
                className="sticky bottom-0 z-sticky border-t border-rule bg-paper pt-2.5 md:pr-4"
              >
                <ActionRow
                  task={task}
                  isDone={isDone}
                  moreMenuOpen={moreMenuOpen}
                  setMoreMenuOpen={setMoreMenuOpen}
                  moreMenuRef={moreMenuRef}
                  onStatusChange={onStatusChange}
                  onComplete={onComplete}
                  onEdit={onEdit}
                  onArchive={onArchive}
                  onMoveToBacklog={onMoveToBacklog}
                  onDelete={onDelete}
                  onApprove={onApprove}
                />
              </div>
            </>
          )}
        </div>

        {/* Side rail (collapses into a details strip above the thread on narrow screens) */}
        <aside
          aria-label="Task details"
          className="order-first border-b border-rule md:order-none md:overflow-y-auto md:border-b-0 md:py-4 md:pl-4"
        >
          <button
            type="button"
            data-testid="mobile-details-toggle"
            aria-expanded={detailsOpen}
            onClick={() => {
              setDetailsOpen((prev) => !prev);
            }}
            className="flex w-full items-center justify-between gap-2 py-2.5 text-left text-xs font-semibold text-ink-2 md:hidden"
          >
            <span className="flex min-w-0 flex-wrap items-center gap-1.5">
              <span>Details</span>
              {project && <span className="text-ink-3">· {project.name}</span>}
              {subtaskStats.total > 0 && (
                <span className="font-mono text-2xs text-ink-3">
                  · {subtaskStats.done}/{subtaskStats.total} subtasks
                </span>
              )}
              {activeRun && (
                <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-2xs text-accent-ink">
                  {STATE_LABELS[activeRun.state]}
                </span>
              )}
            </span>
            {detailsOpen ? (
              <ChevronDown size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
            )}
          </button>

          <div
            data-testid="task-rail-content"
            className={`${detailsOpen ? "block pb-3" : "hidden"} md:block`}
          >
            <dl className="m-0 flex flex-col gap-3.5">
              <div>
                <dt className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Agent run
                </dt>
                <dd className="m-0">
                  {activeRun && (
                    <div
                      data-testid="rail-agent-run-card"
                      className="mb-2 flex flex-col gap-1 rounded-md border border-rule bg-paper-2 p-2.5 text-2xs text-ink-2"
                    >
                      <strong className="flex items-center gap-1.5 font-semibold text-ink">
                        <span
                          className={`size-1.5 rounded-full ${
                            activeRun.state === "waiting_for_approval" || task.needsHuman !== undefined
                              ? "bg-accent"
                              : activeRun.state === "working"
                                ? "bg-ok"
                                : "bg-ink-3"
                          }`}
                          aria-hidden="true"
                        />
                        {activeRun.state === "waiting_for_approval" ||
                        (task.needsHuman !== undefined && activeRun.state !== "working")
                          ? "Waiting for input"
                          : STATE_LABELS[activeRun.state]}
                      </strong>
                      <span>
                        {agentNameForT3(effectiveT3Context)}
                        {activeRun.model ? ` · ${activeRun.model}` : ""}
                      </span>
                      <span className="text-ink-3">
                        Started{" "}
                        <time
                          dateTime={activeRun.startedAt}
                          title={formatFullTimestamp(activeRun.startedAt)}
                        >
                          {formatTimeAgo(activeRun.startedAt)}
                        </time>
                        {activeRun.link && (
                          <>
                            {" · "}
                            <a
                              href={activeRun.link}
                              target="_blank"
                              rel="noreferrer"
                              className="font-medium text-accent-ink underline"
                            >
                              thread ↗
                            </a>
                          </>
                        )}
                      </span>
                    </div>
                  )}
                  {storage ? (
                    <TaskT3Section
                      key={`t3-${task.id}`}
                      task={task}
                      project={project}
                      projects={projects}
                      storage={storage}
                      initialRun={agentRun}
                      hasUnfinishedDependencies={Boolean(
                        dependencies?.dependsOn.some(
                          (dep) => dep.status !== "done" && dep.status !== "archived",
                        ),
                      )}
                      onTaskUpdated={onTaskUpdated}
                      onT3ContextChange={handleT3ContextChange}
                    />
                  ) : !activeRun ? (
                    <span className="text-xs text-ink-3">No active run</span>
                  ) : null}
                </dd>
              </div>

              <div>
                <dt className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Project
                </dt>
                <dd className="m-0 text-xs text-ink">{project?.name ?? "—"}</dd>
              </div>

              <div>
                <dt className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Priority
                </dt>
                <dd className="m-0 text-xs text-ink">
                  {task.priority ? PRIORITY_LABELS[task.priority] : "—"}
                </dd>
              </div>

              <div>
                <dt className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Subtasks
                </dt>
                <dd className="m-0 text-xs text-ink">
                  {subtaskStats.total > 0 ? (
                    <div className="w-full">
                      <span className="tabular-nums">
                        {subtaskStats.done} of {subtaskStats.total}
                      </span>
                      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-paper-2">
                        <i
                          className="block h-full bg-ok transition-all"
                          style={{
                            width: `${String(Math.round((subtaskStats.done / subtaskStats.total) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="text-ink-3">None</span>
                  )}
                </dd>
              </div>

              {task.dueDate && (
                <div>
                  <dt className="mb-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                    Due date
                  </dt>
                  <dd className="m-0 font-mono text-xs text-ink">{task.dueDate}</dd>
                </div>
              )}

              {task.labels && task.labels.length > 0 && (
                <div>
                  <dt className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                    Labels
                  </dt>
                  <dd className="m-0 flex flex-wrap gap-1">
                    {task.labels.map((label) => (
                      <span
                        key={label}
                        className="rounded-pill bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2"
                      >
                        #{label}
                      </span>
                    ))}
                  </dd>
                </div>
              )}

              <div>
                <dt className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  Depends on
                </dt>
                <dd className="m-0 flex flex-col gap-1 text-xs">
                  {dependencies && dependencies.dependsOn.length > 0 ? (
                    dependencies.dependsOn.map((dep) => {
                      const closed = dep.status === "done" || dep.status === "archived";
                      return (
                        <Link
                          key={dep.id}
                          href={taskHref(dep.code ?? dep.id, locationHref)}
                          className={`inline-flex items-center gap-1.5 text-ink hover:text-accent-ink focus-visible:outline-focus ${
                            closed ? "line-through text-ink-3" : ""
                          }`}
                        >
                          {closed ? (
                            <Check size={12} aria-hidden="true" className="shrink-0 text-ok" />
                          ) : (
                            <Clock size={12} aria-hidden="true" className="shrink-0 text-ink-3" />
                          )}
                          <span className="font-mono font-semibold">{dep.code ?? dep.id}</span>
                          <span className="truncate">{dep.title}</span>
                        </Link>
                      );
                    })
                  ) : (
                    <span className="text-ink-3">None</span>
                  )}
                </dd>
              </div>

              {dependencies && dependencies.dependents.length > 0 && (
                <div>
                  <dt className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                    Blocks
                  </dt>
                  <dd className="m-0 flex flex-col gap-1 text-xs">
                    {dependencies.dependents.map((dep) => (
                      <Link
                        key={dep.id}
                        href={taskHref(dep.code ?? dep.id, locationHref)}
                        className="inline-flex items-center gap-1.5 text-ink hover:text-accent-ink focus-visible:outline-focus"
                      >
                        <span className="font-mono font-semibold">{dep.code ?? dep.id}</span>
                        <span className="truncate">{dep.title}</span>
                      </Link>
                    ))}
                  </dd>
                </div>
              )}

              {links && (links.mentions.length > 0 || links.mentionedIn.length > 0) && (
                <div>
                  <dt className="mb-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                    Linked tasks
                  </dt>
                  <dd className="m-0 flex flex-col gap-1 text-xs">
                    {[...links.mentions, ...links.mentionedIn].map((linked) => (
                      <Link
                        key={linked.id}
                        href={taskHref(linked.code ?? linked.id, locationHref)}
                        className="inline-flex items-center gap-1.5 text-ink hover:text-accent-ink focus-visible:outline-focus"
                      >
                        <span className="font-mono font-semibold">{linked.code ?? linked.id}</span>
                        <span className="truncate">{linked.title}</span>
                      </Link>
                    ))}
                  </dd>
                </div>
              )}

              <div>
                <dt className="sr-only">Attachments</dt>
                <dd className="m-0">
                  {storage ? (
                    <TaskAttachments
                      key={`attachments-${task.id}`}
                      storage={storage}
                      taskId={task.id}
                    />
                  ) : (
                    <span className="text-xs text-ink-3">No attachments</span>
                  )}
                </dd>
              </div>
            </dl>

            <div className="mt-4 border-t border-rule pt-3 text-2xs text-ink-3">
              <div>
                Created{task.createdBy ? ` by ${task.createdBy}` : ""} ·{" "}
                <time dateTime={task.createdAt} title={formatFullTimestamp(task.createdAt)}>
                  {formatTimeAgo(task.createdAt)}
                </time>
              </div>
              <div className="mt-0.5">
                Updated{task.updatedBy ? ` by ${task.updatedBy}` : ""} ·{" "}
                <time dateTime={task.updatedAt} title={formatFullTimestamp(task.updatedAt)}>
                  {formatTimeAgo(task.updatedAt)}
                </time>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

function WaitingChip({
  t3,
  needsHuman,
}: {
  readonly t3: TaskCommentsT3Context | undefined;
  readonly needsHuman: string | undefined;
}) {
  const agentName = agentNameForT3(t3);
  const label =
    t3 !== undefined ? `${agentName} is waiting for you` : needsHuman ? `Needs you: ${needsHuman}` : "Waiting for you";
  return (
    <span
      data-testid="task-waiting-chip"
      className="inline-flex items-center gap-1.5 rounded-pill border border-accent/30 bg-accent-soft px-2.5 py-0.5 text-2xs font-semibold text-accent-ink"
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      <span>{label}</span>
    </span>
  );
}

function DescriptionMessage({
  task,
  creatorName,
  checklist,
  onChecklistToggle,
}: {
  readonly task: Task;
  readonly creatorName: string;
  readonly checklist: readonly ChecklistItem[] | undefined;
  readonly onChecklistToggle?: ((next: ChecklistItem[]) => void) | undefined;
}) {
  return (
    <article
      aria-label="Task description"
      className="grid grid-cols-[28px_minmax(0,1fr)] gap-2.5"
    >
      <div
        aria-hidden="true"
        className="grid size-7 place-items-center rounded-md border border-rule bg-paper-2 text-2xs font-bold text-ink-2"
      >
        {initialsFor(creatorName)}
      </div>
      <div className="min-w-0">
        <div className="mb-1 flex flex-wrap items-baseline gap-2 text-2xs text-ink-3">
          <strong className="text-xs font-semibold text-ink">{creatorName}</strong>
          <span className="rounded bg-paper-2 px-1.5 py-0.5 text-2xs font-medium text-ink-3">
            Description
          </span>
          <time dateTime={task.createdAt} title={formatFullTimestamp(task.createdAt)}>
            {formatTimeAgo(task.createdAt)}
          </time>
        </div>
        <div className="rounded-md border border-rule bg-paper-2/40 p-3">
          {task.description ? (
            <Markdown content={task.description} className="text-sm text-ink" />
          ) : (
            <p className="m-0 text-sm text-ink-3">No description</p>
          )}
          {(Boolean(checklist && checklist.length > 0) || Boolean(onChecklistToggle)) && (
            <div className="mt-3 border-t border-rule pt-2.5">
              <ChecklistView
                checklist={checklist}
                task={task}
                onToggle={onChecklistToggle}
              />
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

function buildTimelineItems({
  task,
  comments,
  checkpoints,
  run,
  agentName,
  needsHumanClearedAt,
}: {
  readonly task: Task;
  readonly comments: readonly Comment[];
  readonly checkpoints: readonly Checkpoint[];
  readonly run: AgentRun | null;
  readonly agentName: string;
  readonly needsHumanClearedAt: string | null;
}): TimelineItem[] {
  const items: TimelineItem[] = [];

  if (run) {
    const details = [
      ...(run.model ? [run.model] : []),
      ...(run.workspaceStrategy === "worktree" ? ["worktree"] : []),
    ].join(" · ");
    items.push({
      kind: "event",
      id: `run-started-${run.id}`,
      timestamp: run.startedAt,
      sortOrder: 1,
      eventType: "run_started",
      actor: agentName,
      text: "started a T3 run",
      ...(details ? { monoDetail: details } : {}),
    });

    if (run.state === "finished" || run.state === "failed" || run.state === "stopped") {
      items.push({
        kind: "event",
        id: `run-ended-${run.id}-${run.state}`,
        timestamp: run.updatedAt,
        sortOrder: 4,
        eventType: "run_ended",
        actor: agentName,
        text: `run ${STATE_LABELS[run.state]}`,
      });
    }
  }

  for (const [idx, entry] of (task.activity ?? []).entries()) {
    if (entry.action === "created") continue;
    items.push({
      kind: "event",
      id: `activity-${entry.timestamp}-${entry.action}-${String(idx)}`,
      timestamp: entry.timestamp,
      sortOrder: 2,
      eventType: "activity",
      actor: entry.actor,
      text: formatActivityAction(entry),
    });
  }

  for (const cp of checkpoints) {
    items.push({
      kind: "event",
      id: `checkpoint-${cp.id}`,
      timestamp: cp.createdAt,
      sortOrder: 3,
      eventType: "checkpoint",
      actor: cp.createdBy,
      text: `Checkpoint saved: “${cp.stateSnapshot.summary}”`,
    });
  }

  if (task.needsHuman !== undefined) {
    items.push({
      kind: "event",
      id: `needs-human-set-${task.id}`,
      timestamp: task.updatedAt,
      sortOrder: 3,
      eventType: "needs_human_set",
      text: `Needs-human set: ${task.needsHuman}`,
    });
  } else if (needsHumanClearedAt !== null) {
    items.push({
      kind: "event",
      id: `needs-human-cleared-${task.id}`,
      timestamp: needsHumanClearedAt,
      sortOrder: 5,
      eventType: "needs_human_cleared",
      text: "Needs-human cleared",
    });
  }

  for (const comment of comments) {
    items.push({
      kind: "comment",
      id: `comment-${comment.id}`,
      timestamp: comment.createdAt,
      sortOrder: 3,
      comment,
    });
  }

  return items.sort((a, b) => {
    const diff = parseTimeMs(a.timestamp) - parseTimeMs(b.timestamp);
    if (diff !== 0) return diff;
    return a.sortOrder - b.sortOrder;
  });
}

function TimelineList({
  items,
  task,
  agentName,
  isWaitingForHuman,
  onDeleteComment,
}: {
  readonly items: readonly TimelineItem[];
  readonly task: Task;
  readonly agentName: string;
  readonly isWaitingForHuman: boolean;
  readonly onDeleteComment?: ((id: string) => void) | undefined;
}) {
  // Highlight the latest agent comment when the task/run is waiting on a person.
  const waitingCommentId = useMemo(() => {
    if (!isWaitingForHuman) return undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === "comment" && item.comment.authorType === "agent") {
        return item.comment.id;
      }
    }
    return undefined;
  }, [items, isWaitingForHuman]);

  return (
    <>
      {items.map((item) => {
        if (item.kind === "event") {
          return (
            <div
              key={item.id}
              data-testid="thread-event"
              className="ml-9 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3"
            >
              {item.eventType === "checkpoint" ? (
                <Check size={12} aria-hidden="true" className="shrink-0 text-ok" />
              ) : item.eventType === "needs_human_set" ? (
                <Hand size={12} aria-hidden="true" className="shrink-0 text-accent-ink" />
              ) : (
                <span className="size-1.5 shrink-0 rounded-full bg-ink-3" aria-hidden="true" />
              )}
              {item.actor && <strong className="font-semibold text-ink-2">{item.actor}</strong>}
              <span>{item.text}</span>
              {item.monoDetail && (
                <code className="rounded bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-2">
                  {item.monoDetail}
                </code>
              )}
              <span>·</span>
              <time dateTime={item.timestamp} title={formatFullTimestamp(item.timestamp)}>
                {formatTimeAgo(item.timestamp)}
              </time>
            </div>
          );
        }

        const { comment } = item;
        const isAgent = comment.authorType === "agent";
        const name = comment.author ?? (isAgent ? agentName : "You");
        const isWaitingQuestion = comment.id === waitingCommentId;

        return (
          <article
            key={item.id}
            data-testid={isWaitingQuestion ? "highlighted-agent-question" : "thread-comment"}
            className="grid grid-cols-[28px_minmax(0,1fr)] gap-2.5"
          >
            <div
              aria-hidden="true"
              className={`grid size-7 place-items-center rounded-md text-2xs font-bold ${
                isAgent
                  ? "bg-accent-soft text-accent-ink"
                  : "border border-rule bg-paper-2 text-ink-2"
              }`}
            >
              {initialsFor(name)}
            </div>
            <div className="min-w-0">
              <div className="mb-1 flex flex-wrap items-baseline gap-2 text-2xs text-ink-3">
                <strong className="text-xs font-semibold text-ink">{name}</strong>
                {isWaitingQuestion ? (
                  <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold text-accent-ink">
                    Needs you
                  </span>
                ) : isAgent ? (
                  <span className="rounded bg-paper-2 px-1.5 py-0.5 text-2xs font-medium text-ink-3">
                    Agent
                  </span>
                ) : null}
                <time dateTime={comment.createdAt} title={formatFullTimestamp(comment.createdAt)}>
                  {formatTimeAgo(comment.createdAt)}
                </time>
                {onDeleteComment && (
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteComment(comment.id);
                    }}
                    aria-label={`Delete comment by ${name}`}
                    className="ml-auto text-ink-3 transition-colors hover:text-danger focus-visible:outline-focus"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                )}
              </div>
              <div
                className={
                  isWaitingQuestion
                    ? "rounded-r-md border-l-2 border-accent bg-accent-soft/50 px-3 py-2"
                    : ""
                }
              >
                <Markdown content={comment.body} className="text-sm text-ink" />
                {isWaitingQuestion &&
                  task.needsHuman !== undefined &&
                  !comment.body.includes(task.needsHuman) && (
                    <p className="m-0 mt-1.5 text-xs font-semibold text-accent-ink">
                      Needs you: {task.needsHuman}
                    </p>
                  )}
              </div>
            </div>
          </article>
        );
      })}

      {/* When needsHuman is set without an agent comment yet, highlight the question directly */}
      {isWaitingForHuman && waitingCommentId === undefined && task.needsHuman !== undefined && (
        <article
          data-testid="highlighted-agent-question"
          className="grid grid-cols-[28px_minmax(0,1fr)] gap-2.5"
        >
          <div
            aria-hidden="true"
            className="grid size-7 place-items-center rounded-md bg-accent-soft text-2xs font-bold text-accent-ink"
          >
            {initialsFor(agentName)}
          </div>
          <div className="min-w-0">
            <div className="mb-1 flex flex-wrap items-baseline gap-2 text-2xs text-ink-3">
              <strong className="text-xs font-semibold text-ink">{agentName}</strong>
              <span className="rounded bg-accent-soft px-1.5 py-0.5 text-2xs font-semibold text-accent-ink">
                Needs you
              </span>
            </div>
            <div className="rounded-r-md border-l-2 border-accent bg-accent-soft/50 px-3 py-2 text-sm text-ink">
              {task.needsHuman}
            </div>
          </div>
        </article>
      )}
    </>
  );
}

function ThreadWithStorage({
  task,
  storage,
  creatorName,
  checklist,
  onChecklistToggle,
  t3,
  needsHumanClearedAt,
  onNeedsHumanResolve,
  actionRow,
}: {
  readonly task: Task;
  readonly storage: StorageProvider;
  readonly creatorName: string;
  readonly checklist: readonly ChecklistItem[] | undefined;
  readonly onChecklistToggle?: ((next: ChecklistItem[]) => void) | undefined;
  readonly t3?: TaskCommentsT3Context | undefined;
  readonly needsHumanClearedAt: string | null;
  readonly onNeedsHumanResolve?: (() => void) | undefined;
  readonly actionRow: React.ReactNode;
}) {
  const { comments, addComment, deleteComment } = useComments(storage, task.id);
  const { checkpoints } = useCheckpoints(storage, task.id);

  const lastAgentAuthor = useMemo(() => {
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (c?.authorType === "agent" && c.author) return c.author;
    }
    return undefined;
  }, [comments]);

  const agentName = agentNameForT3(t3, lastAgentAuthor);
  const isWaitingForHuman =
    t3?.run.state === "waiting_for_approval" || task.needsHuman !== undefined;

  const timelineItems = useMemo(
    () =>
      buildTimelineItems({
        task,
        comments,
        checkpoints,
        run: t3?.run ?? null,
        agentName,
        needsHumanClearedAt,
      }),
    [task, comments, checkpoints, t3?.run, agentName, needsHumanClearedAt],
  );

  return (
    <>
      <div
        data-testid="task-thread"
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4 md:pr-4"
      >
        <DescriptionMessage
          task={task}
          creatorName={creatorName}
          checklist={checklist}
          onChecklistToggle={onChecklistToggle}
        />

        <TimelineList
          items={timelineItems}
          task={task}
          agentName={agentName}
          isWaitingForHuman={isWaitingForHuman}
          onDeleteComment={(id) => {
            void deleteComment(id).catch(() => undefined);
          }}
        />
      </div>

      <div
        data-testid="task-dock"
        className="sticky bottom-0 z-sticky border-t border-rule bg-paper pt-2.5 md:pr-4"
      >
        <TaskComposer
          key={task.id}
          taskId={task.id}
          addComment={addComment}
          t3={t3}
          needsHuman={task.needsHuman !== undefined}
          onResolve={onNeedsHumanResolve}
          agentName={agentName}
        />
        {actionRow}
      </div>
    </>
  );
}

function ActionRow({
  task,
  isDone,
  moreMenuOpen,
  setMoreMenuOpen,
  moreMenuRef,
  onStatusChange,
  onComplete,
  onEdit,
  onArchive,
  onMoveToBacklog,
  onDelete,
  onApprove,
}: {
  readonly task: Task;
  readonly isDone: boolean;
  readonly moreMenuOpen: boolean;
  readonly setMoreMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  readonly moreMenuRef: React.RefObject<HTMLDivElement | null>;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
  readonly onComplete: (task: Task) => void;
  readonly onEdit: (task: Task) => void;
  readonly onArchive?: ((task: Task) => void) | undefined;
  readonly onMoveToBacklog?: ((task: Task) => void) | undefined;
  readonly onDelete: (task: Task) => void;
  readonly onApprove?: ((task: Task) => void) | undefined;
}) {
  return (
    <div
      data-testid="task-action-row"
      className="flex flex-wrap items-center gap-1.5 py-2.5"
    >
      <select
        aria-label="Change status"
        value={task.status}
        onChange={(e) => {
          onStatusChange(task, e.target.value as TaskStatus);
        }}
        className="rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs font-semibold text-ink focus-visible:outline-focus"
      >
        <option value="todo">To Do</option>
        <option value="in_progress">In Progress</option>
        <option value="done">Done</option>
        <option value="archived">Archived</option>
      </select>

      {task.pendingApproval === true && (
        <>
          {onApprove && (
            <button
              type="button"
              onClick={() => {
                onApprove(task);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-ok/30 bg-ok-soft px-3 py-1.5 text-xs font-semibold text-ok transition-colors hover:bg-paper-2 focus-visible:outline-focus"
            >
              <ShieldCheck size={14} aria-hidden="true" />
              Approve
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              onDelete(task);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-paper-2 focus-visible:outline-focus"
          >
            <Trash2 size={14} aria-hidden="true" />
            Reject
          </button>
        </>
      )}

      {!isDone && (
        <button
          type="button"
          onClick={() => {
            onComplete(task);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
        >
          <CheckCircle2 size={14} aria-hidden="true" />
          Complete
        </button>
      )}

      <button
        type="button"
        onClick={() => {
          onEdit(task);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
      >
        <Edit2 size={14} aria-hidden="true" />
        Edit
      </button>

      {task.status !== "archived" && onArchive && (
        <button
          type="button"
          onClick={() => {
            onArchive(task);
          }}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
        >
          <Archive size={14} aria-hidden="true" />
          Archive
        </button>
      )}

      <span className="flex-1" />

      <div ref={moreMenuRef} className="relative">
        <button
          type="button"
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={moreMenuOpen}
          onClick={() => {
            setMoreMenuOpen((prev) => !prev);
          }}
          className="inline-flex items-center justify-center rounded-md border border-rule p-1.5 text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
        >
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>

        {moreMenuOpen && (
          <div
            role="menu"
            aria-label="More actions"
            className="absolute right-0 bottom-full z-overlay mb-1.5 flex min-w-[160px] flex-col rounded-md border border-rule bg-paper p-1 shadow-lg"
          >
            {task.pendingApproval !== true && onMoveToBacklog && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMoreMenuOpen(false);
                  onMoveToBacklog(task);
                }}
                className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
              >
                Move to backlog
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMoreMenuOpen(false);
                onDelete(task);
              }}
              className="flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs font-medium text-danger transition-colors hover:bg-danger-soft focus-visible:outline-focus"
            >
              <Trash2 size={13} aria-hidden="true" />
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
