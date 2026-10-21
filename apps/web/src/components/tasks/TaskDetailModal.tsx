import { useEffect, useRef, useState } from "react";
import {
  Bot,
  Calendar,
  CheckCircle2,
  Clock,
  Edit2,
  Globe,
  Lock,
  PlayCircle,
  Tag,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  formatDuration,
  getTaskTiming,
  type ChecklistItem,
  type Project,
  type StorageProvider,
  type Task,
  type TaskActivityEntry,
  type TaskPriority,
  type DependencyLinks,
  type TaskLinks,
  type TaskStatus,
} from "@bitig/core";
import { useFeatureFlags } from "../../hooks/useFeatureFlags";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Markdown } from "../Markdown";
import { ChecklistProgressBadge, ChecklistView } from "./Checklist";
import { ApprovalNote } from "./Approval";
import { NeedsHumanNote } from "./NeedsHuman";
import { TaskCode } from "./TaskCode";
import { TaskComments } from "./TaskComments";
import { LinkedTasks, TaskDependencies } from "./LinkedTasks";

interface TaskDetailModalProps {
  readonly task: Task | null;
  readonly projects: Project[];
  readonly onClose: () => void;
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  /** Saves a checked or unchecked subtask; omit to show the checklist read-only. */
  readonly onChecklistChange?: ((task: Task, checklist: ChecklistItem[]) => Promise<unknown>) | undefined;
  /** Clears the needs-human flag once a person has answered; omit to show it read-only. */
  readonly onNeedsHumanResolve?: ((task: Task) => void) | undefined;
  /** Approves a task an agent or webhook created; omit to show the flag read-only. */
  readonly onApprove?: ((task: Task) => void) | undefined;
  /** Loads and saves the task's comments; omit to hide them. */
  readonly storage?: StorageProvider | undefined;
  /** The tasks this task mentions and the tasks that mention it; omit to hide them. */
  readonly links?: TaskLinks | undefined;
  /** The tasks this task depends on and the tasks waiting on it; omit to hide them. */
  readonly dependencies?: DependencyLinks | undefined;
}

const ICON_SIZE = 16;

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  archived: "Archived",
};

const PRIORITY_BADGES: Record<TaskPriority, string> = {
  urgent: "bg-danger-soft text-danger border-danger/30 font-bold",
  high: "bg-accent-soft text-accent-ink border-accent/30 font-semibold",
  medium: "bg-rule-strong text-ink border-rule",
  low: "bg-paper-3 text-ink-2 border-rule",
  trivial: "bg-paper-3 text-ink-3 border-rule",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
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

function Field({
  label,
  icon: Icon,
  children,
}: {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </dt>
      <dd className="m-0 mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function TaskDetailModal({
  task,
  projects,
  onClose,
  onEdit,
  onDelete,
  onComplete,
  onChecklistChange,
  onNeedsHumanResolve,
  onApprove,
  storage,
  links,
  dependencies,
}: TaskDetailModalProps) {
  const { taskVisibility } = useFeatureFlags();
  const isOpen = task !== null;
  // A toggled checklist shows at once and gives way to the saved task once the save settles
  // (or reverts if it fails). Only the latest toggle clears it, so quick clicks don't flicker.
  const [pendingChecklist, setPendingChecklist] = useState<{
    readonly taskId: string;
    readonly items: ChecklistItem[];
  } | null>(null);
  const latestToggle = useRef(0);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!task) return null;

  const project = projects.find((p) => p.id === task.projectId);
  const isDone = task.status === "done" || task.status === "archived";
  const checklist = pendingChecklist?.taskId === task.id ? pendingChecklist.items : task.checklist;
  const timing = getTaskTiming(task);
  const spentMs =
    task.startedAt !== undefined || task.completedAt !== undefined ? timing.spentMs : undefined;

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

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-detail-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-rule bg-paper p-6 shadow-lg outline-none"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-4 pr-6">
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <TaskCode task={task} project={project} />
            {project && (
              <span className="rounded-md bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink-2">
                {project.name}
              </span>
            )}
            <span className="rounded-pill border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink-2">
              {STATUS_LABELS[task.status]}
            </span>
            {task.priority && (
              <span
                className={`rounded-pill border px-2 py-0.5 text-2xs uppercase tracking-wider ${
                  PRIORITY_BADGES[task.priority]
                }`}
              >
                {task.priority}
              </span>
            )}
            {spentMs !== undefined && (
              <span
                title="Active time spent on this task"
                className="inline-flex items-center gap-1 rounded-pill border border-accent/30 bg-accent-soft px-2 py-0.5 font-mono text-2xs font-semibold text-accent-ink"
              >
                <Clock size={11} aria-hidden="true" />
                {formatDuration(spentMs)}
              </span>
            )}
          </div>
          <h2
            id="task-detail-title"
            className={`m-0 font-display text-lg font-bold text-ink ${
              isDone ? "line-through text-ink-3" : ""
            }`}
          >
            {task.title}
          </h2>
        </div>

        {task.pendingApproval === true && (
          <div className="mb-5">
            <ApprovalNote
              pending
              onApprove={
                onApprove
                  ? () => {
                      onApprove(task);
                    }
                  : undefined
              }
              onReject={() => {
                onDelete(task);
              }}
            />
          </div>
        )}

        {task.needsHuman !== undefined && (
          <div className="mb-5">
            <NeedsHumanNote
              reason={task.needsHuman}
              onResolve={
                onNeedsHumanResolve
                  ? () => {
                      onNeedsHumanResolve(task);
                    }
                  : undefined
              }
            />
          </div>
        )}

        <div className="mb-5">
          {task.description ? (
            <Markdown content={task.description} />
          ) : (
            <p className="m-0 text-sm text-ink-3">No description</p>
          )}
        </div>

        {(Boolean(checklist && checklist.length > 0) || Boolean(onChecklistChange)) && (
          <section aria-labelledby="task-detail-checklist" className="mb-5">
            <h3
              id="task-detail-checklist"
              className="m-0 mb-2 flex items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-ink-3"
            >
              Subtasks <ChecklistProgressBadge checklist={checklist} />
            </h3>
            <ChecklistView
              checklist={checklist}
              task={task}
              onToggle={
                onChecklistChange
                  ? (next) => {
                      toggleChecklist(task, next);
                    }
                  : undefined
              }
            />
          </section>
        )}

        {dependencies && <TaskDependencies dependencies={dependencies} />}
        {links && <LinkedTasks links={links} />}

        <dl className="m-0 mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Due date" icon={Calendar}>
            {task.dueDate ? <span className="font-mono">{task.dueDate}</span> : "—"}
          </Field>
          {taskVisibility && (
            <Field label="Visibility" icon={task.isPublic ? Globe : Lock}>
              {task.isPublic ? "Public (visible on Nostr relays)" : "Private (NIP-44 encrypted)"}
            </Field>
          )}
          <Field label="Labels" icon={Tag}>
            {task.labels && task.labels.length > 0 ? (
              <span className="flex flex-wrap gap-1">
                {task.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-pill bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2"
                  >
                    #{label}
                  </span>
                ))}
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Time spent" icon={Clock}>
            {spentMs !== undefined ? (
              <span className="font-mono text-xs font-semibold text-ink">
                {formatDuration(spentMs)}
                {task.status === "in_progress" ? " (in progress)" : ""}
              </span>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Created">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs">{formatTimestamp(task.createdAt)}</span>
              {task.createdBy && (
                <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
                  <Bot size={11} aria-hidden="true" />
                  <span>
                    by <strong className="font-semibold text-ink-2">{task.createdBy}</strong>
                  </span>
                </span>
              )}
            </div>
          </Field>
          <Field label="Started" icon={PlayCircle}>
            {task.startedAt ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs">{formatTimestamp(task.startedAt)}</span>
                {task.startedBy && (
                  <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
                    <Bot size={11} aria-hidden="true" />
                    <span>
                      by <strong className="font-semibold text-ink-2">{task.startedBy}</strong>
                    </span>
                  </span>
                )}
                {timing.leadTimeMs !== undefined && timing.leadTimeMs > 0 && (
                  <span className="text-2xs text-ink-3">
                    Started {formatDuration(timing.leadTimeMs)} after creation
                  </span>
                )}
              </div>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Completed" icon={CheckCircle2}>
            {task.completedAt ? (
              <div className="flex flex-col gap-0.5">
                <span className="text-xs">{formatTimestamp(task.completedAt)}</span>
                {task.completedBy && (
                  <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
                    <Bot size={11} aria-hidden="true" />
                    <span>
                      by <strong className="font-semibold text-ink-2">{task.completedBy}</strong>
                    </span>
                  </span>
                )}
                {timing.spentMs !== undefined && (
                  <span className="text-2xs text-ink-3">
                    Completed in {formatDuration(timing.spentMs)}
                  </span>
                )}
              </div>
            ) : (
              "—"
            )}
          </Field>
          <Field label="Updated">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs">{formatTimestamp(task.updatedAt)}</span>
              {task.updatedBy && (
                <span className="inline-flex items-center gap-1 text-2xs text-ink-3">
                  <Bot size={11} aria-hidden="true" />
                  <span>
                    by <strong className="font-semibold text-ink-2">{task.updatedBy}</strong>
                  </span>
                </span>
              )}
            </div>
          </Field>
        </dl>

        {task.activity && task.activity.length > 0 && (
          <section aria-labelledby="task-detail-activity" className="mb-5">
            <h3
              id="task-detail-activity"
              className="m-0 mb-2 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3"
            >
              <Bot size={12} aria-hidden="true" />
              Activity ({String(task.activity.length)})
            </h3>
            <ol className="m-0 flex list-none flex-col gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-2">
              {task.activity.map((entry, idx) => (
                <li
                  key={`${entry.timestamp}-${entry.actor}-${entry.action}-${String(idx)}`}
                  className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Bot size={11} aria-hidden="true" className="shrink-0 text-ink-3" />
                    <span className="font-semibold text-ink">{entry.actor}</span>
                    <span>{formatActivityAction(entry)}</span>
                  </span>
                  <time dateTime={entry.timestamp} className="font-mono text-2xs text-ink-3">
                    {formatTimestamp(entry.timestamp)}
                  </time>
                </li>
              ))}
            </ol>
          </section>
        )}

        {/* Keyed so a draft never carries over to another task. */}
        {storage && (
          <TaskComments
            key={task.id}
            storage={storage}
            taskId={task.id}
            onResolve={
              task.needsHuman !== undefined && onNeedsHumanResolve
                ? () => {
                    onNeedsHumanResolve(task);
                  }
                : undefined
            }
          />
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-4">
          <button
            type="button"
            onClick={() => {
              onDelete(task);
            }}
            className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger-soft"
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
          {!isDone && (
            <button
              type="button"
              onClick={() => {
                onComplete(task);
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
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
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90"
          >
            <Edit2 size={14} aria-hidden="true" />
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}
