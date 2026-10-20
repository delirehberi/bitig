import { useEffect, useRef, useState } from "react";
import {
  Calendar,
  CheckCircle2,
  Edit2,
  Globe,
  Lock,
  Tag,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { ChecklistItem, Project, StorageProvider, Task, TaskPriority, TaskStatus } from "@bitig/core";
import { useFeatureFlags } from "../../hooks/useFeatureFlags";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Markdown } from "../Markdown";
import { ChecklistProgressBadge, ChecklistView } from "./Checklist";
import { NeedsHumanNote } from "./NeedsHuman";
import { TaskCode } from "./TaskCode";
import { TaskComments } from "./TaskComments";

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
  /** Loads and saves the task's comments; omit to hide them. */
  readonly storage?: StorageProvider | undefined;
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
  storage,
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
  const isDone = task.status === "done";
  const checklist = pendingChecklist?.taskId === task.id ? pendingChecklist.items : task.checklist;

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
          <Field label="Created">
            <span className="text-xs">{formatTimestamp(task.createdAt)}</span>
          </Field>
          <Field label="Updated">
            <span className="text-xs">{formatTimestamp(task.updatedAt)}</span>
          </Field>
        </dl>

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
