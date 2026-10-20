import {
  Bot,
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  Edit2,
  Globe,
  GripVertical,
  Lock,
  MessageSquare,
  Tag,
  Trash2,
} from "lucide-react";
import {
  TASK_STATUSES,
  formatDuration,
  getTaskTiming,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@bitig/core";
import { useFeatureFlags } from "../../hooks/useFeatureFlags";
import { ChecklistProgressBadge } from "./Checklist";
import { NeedsHumanNote } from "./NeedsHuman";
import { TaskCode } from "./TaskCode";

interface TaskCardProps {
  readonly task: Task;
  readonly projects: Project[];
  readonly onView: (task: Task) => void;
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
  /** Shows a reorder handle; arrow keys on it move the card up (-1) or down (1). */
  readonly onReorder?: (direction: -1 | 1) => void;
  /** Whether to show the project name badge; defaults to true. */
  readonly showProject?: boolean;
}

const PRIORITY_BADGES: Record<TaskPriority, string> = {
  urgent: "bg-danger-soft text-danger border-danger/30 font-bold",
  high: "bg-accent-soft text-accent-ink border-accent/30 font-semibold",
  medium: "bg-rule-strong text-ink border-rule",
  low: "bg-paper-3 text-ink-2 border-rule",
  trivial: "bg-paper-3 text-ink-3 border-rule",
};

const ICON_SIZE = 14;

export function TaskCard({
  task,
  projects,
  onView,
  onEdit,
  onDelete,
  onComplete,
  onStatusChange,
  onReorder,
  showProject = true,
}: TaskCardProps) {
  const { taskVisibility } = useFeatureFlags();
  const project = projects.find((p) => p.id === task.projectId);
  const isDone = task.status === "done";
  const isArchived = task.status === "archived";
  const hasRecordedTime = task.startedAt !== undefined || task.completedAt !== undefined;
  const spentMs = hasRecordedTime ? getTaskTiming(task).spentMs : undefined;
  const actor =
    task.updatedBy ??
    task.completedBy ??
    task.startedBy ??
    task.createdBy ??
    task.activity?.at(-1)?.actor;

  return (
    <article
      className={`group relative flex flex-col justify-between rounded-lg border bg-paper transition-all hover:border-rule-strong hover:shadow-xs ${
        isArchived
          ? "w-4/5 border-rule/60 px-3 py-2 opacity-75 hover:w-full hover:p-4 hover:opacity-100"
          : isDone
            ? "border-rule/60 p-4 opacity-80"
            : "border-rule p-4"
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <TaskCode task={task} project={project} />
            {showProject && project && (
              <span className="rounded-md bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink-2">
                {project.name}
              </span>
            )}
            {taskVisibility &&
              (task.isPublic ? (
                <span
                  className="flex items-center gap-1 rounded-pill border border-rule bg-paper-2 px-1.5 py-0.5 text-2xs text-ink-3"
                  title="Public task (visible on Nostr relays)"
                >
                  <Globe size={11} aria-hidden="true" />
                  public
                </span>
              ) : (
                <span
                  className="flex items-center gap-1 rounded-pill border border-rule bg-paper-2 px-1.5 py-0.5 text-2xs text-ink-3"
                  title="Private task (NIP-44 encrypted)"
                >
                  <Lock size={11} aria-hidden="true" />
                  private
                </span>
              ))}
            {task.priority && (
              <span
                className={`rounded-pill border px-2 py-0.5 text-2xs uppercase tracking-wider ${
                  PRIORITY_BADGES[task.priority]
                }`}
              >
                {task.priority}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
            {onReorder && (
              <button
                type="button"
                data-reorder-handle={task.id}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                  e.preventDefault();
                  onReorder(e.key === "ArrowUp" ? -1 : 1);
                }}
                title="Drag to reorder, or focus and press the arrow keys"
                aria-label={`Reorder ${task.title}`}
                className="cursor-grab rounded-md p-1 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus active:cursor-grabbing"
              >
                <GripVertical size={ICON_SIZE} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onEdit(task);
              }}
              title="Edit task"
              aria-label={`Edit ${task.title}`}
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              <Edit2 size={ICON_SIZE} />
            </button>
            <button
              type="button"
              onClick={() => {
                onDelete(task);
              }}
              title="Delete task"
              aria-label={`Delete ${task.title}`}
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </div>
        </div>

        <div className="mt-2.5 flex items-start gap-2.5">
          <button
            type="button"
            onClick={() => {
              if (task.status !== "done") {
                onComplete(task);
              } else {
                onStatusChange(task, "todo");
              }
            }}
            title={isDone ? "Mark as To Do" : "Mark as Done"}
            aria-label={isDone ? "Mark as To Do" : "Mark as Done"}
            className="mt-0.5 text-ink-3 transition-colors hover:text-ok focus-visible:outline-focus"
          >
            {isDone ? (
              <CheckCircle2 size={18} className="text-ok" />
            ) : (
              <Circle size={18} className="text-ink-3 hover:text-ok" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <h4
              className={`m-0 font-display text-sm font-semibold text-ink ${
                isDone ? "line-through text-ink-3" : ""
              }`}
            >
              <button
                type="button"
                onClick={() => {
                  onView(task);
                }}
                title="View task details"
                className="cursor-pointer text-left font-[inherit] text-[inherit] [text-decoration:inherit] hover:underline focus-visible:outline-focus"
              >
                {task.title}
              </button>
            </h4>
            {!isDone && !isArchived && task.description && (
              <p className="m-0 mt-1 line-clamp-2 text-xs text-ink-2">{task.description}</p>
            )}
          </div>
        </div>

        {task.needsHuman !== undefined && (
          <div className="mt-3">
            <NeedsHumanNote reason={task.needsHuman} compact />
          </div>
        )}

        {!isArchived && task.labels && task.labels.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1">
            <Tag size={12} className="text-ink-3" />
            {task.labels.map((label) => (
              <span
                key={label}
                className="rounded-pill bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2"
              >
                #{label}
              </span>
            ))}
          </div>
        )}
      </div>

      <div
        className={`mt-4 items-center justify-between border-t border-rule pt-2.5 text-xs text-ink-3 ${
          isArchived ? "hidden group-hover:flex" : "flex"
        }`}
      >
        <div className="flex items-center gap-2">
          {task.dueDate && (
            <div className="flex items-center gap-1 font-mono text-2xs">
              <Calendar size={12} />
              <span>{task.dueDate}</span>
            </div>
          )}
          {spentMs !== undefined && (
            <div
              className="flex items-center gap-1 font-mono text-2xs"
              title="Time spent"
            >
              <Clock size={12} aria-hidden="true" />
              <span>{formatDuration(spentMs)}</span>
            </div>
          )}
          {actor !== undefined && (
            <div
              className="flex items-center gap-1 rounded-pill bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-2"
              title={`Last touched by ${actor}`}
            >
              <Bot size={11} aria-hidden="true" />
              <span>{actor}</span>
            </div>
          )}
          <ChecklistProgressBadge checklist={task.checklist} />
          {task.commentCount !== undefined && task.commentCount > 0 && (
            <div
              className="flex items-center gap-1 font-mono text-2xs"
              title={`${String(task.commentCount)} ${task.commentCount === 1 ? "comment" : "comments"}`}
            >
              <MessageSquare size={12} aria-hidden="true" />
              <span>{task.commentCount}</span>
            </div>
          )}
        </div>

        <select
          value={task.status}
          onChange={(e) => {
            onStatusChange(task, e.target.value as TaskStatus);
          }}
          aria-label="Change status"
          className="rounded-md border border-rule bg-paper-2 px-2 py-1 text-2xs font-semibold text-ink focus-visible:outline-focus"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace("_", " ")}
            </option>
          ))}
        </select>
      </div>
    </article>
  );
}

