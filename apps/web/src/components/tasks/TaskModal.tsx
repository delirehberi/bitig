import { useState, type SyntheticEvent } from "react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type CreateTaskInput,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@bitig/core";
import { CheckSquare, X } from "lucide-react";
import { useFeatureFlags } from "../../hooks/useFeatureFlags";

interface TaskModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateTaskInput) => Promise<void>;
  readonly task?: Task | null | undefined;
  readonly projects: Project[];
  readonly defaultProjectId?: string | undefined;
}

const ICON_SIZE = 16;

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  done: "Done",
  archived: "Archived",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

export function TaskModal({
  isOpen,
  onClose,
  onSubmit,
  task,
  projects,
  defaultProjectId,
}: TaskModalProps) {
  const { taskVisibility } = useFeatureFlags();
  const initialProjectId =
    task?.projectId ?? defaultProjectId ?? (projects.length > 0 ? (projects[0]?.id ?? "") : "");

  const [projectId, setProjectId] = useState(initialProjectId);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? "todo");
  const [priority, setPriority] = useState<TaskPriority | "">(task?.priority ?? "");
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [labelsInput, setLabelsInput] = useState(task?.labels ? task.labels.join(", ") : "");
  const [isPublic, setIsPublic] = useState(task?.isPublic ?? false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const isEditing = Boolean(task);

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim()) {
      setError("Task title is required");
      return;
    }
    if (!projectId) {
      setError("Please select a project");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const labels = labelsInput
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

    const payload: CreateTaskInput = {
      projectId,
      title: title.trim(),
      description: description.trim(),
      status,
      isPublic,
      ...(priority ? { priority } : {}),
      ...(dueDate ? { dueDate } : {}),
      ...(labels.length > 0 ? { labels } : {}),
    };

    try {
      await onSubmit(payload);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save task");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-modal-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <CheckSquare size={18} />
          </div>
          <div>
            <h2 id="task-modal-title" className="m-0 font-display text-lg font-bold text-ink">
              {isEditing ? "Edit Task" : "New Task"}
            </h2>
            <p className="m-0 text-xs text-ink-3">Record and track action items</p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div>
            <label htmlFor="task-project" className="block text-xs font-semibold text-ink-2">
              Project <span className="text-danger">*</span>
            </label>
            <select
              id="task-project"
              required
              value={projectId}
              onChange={(e) => {
                setProjectId(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
              disabled={isSubmitting}
            >
              {projects.length === 0 && <option value="">No projects available</option>}
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="task-title" className="block text-xs font-semibold text-ink-2">
              Title <span className="text-danger">*</span>
            </label>
            <input
              id="task-title"
              type="text"
              required
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
              }}
              placeholder="e.g. Write integration test suite"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label htmlFor="task-status" className="block text-xs font-semibold text-ink-2">
                Status
              </label>
              <select
                id="task-status"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as TaskStatus);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
                disabled={isSubmitting}
              >
                {TASK_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="task-priority" className="block text-xs font-semibold text-ink-2">
                Priority
              </label>
              <select
                id="task-priority"
                value={priority}
                onChange={(e) => {
                  setPriority(e.target.value as TaskPriority | "");
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
                disabled={isSubmitting}
              >
                <option value="">None</option>
                {TASK_PRIORITIES.map((pr) => (
                  <option key={pr} value={pr}>
                    {PRIORITY_LABELS[pr]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="task-duedate" className="block text-xs font-semibold text-ink-2">
                Due Date
              </label>
              <input
                id="task-duedate"
                type="date"
                value={dueDate}
                onChange={(e) => {
                  setDueDate(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <div>
            <label htmlFor="task-labels" className="block text-xs font-semibold text-ink-2">
              Labels <span className="text-xs font-normal text-ink-3">(comma separated)</span>
            </label>
            <input
              id="task-labels"
              type="text"
              value={labelsInput}
              onChange={(e) => {
                setLabelsInput(e.target.value);
              }}
              placeholder="e.g. backend, mcp, docs"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
          </div>

          {/* Hidden outside Nostr mode; isPublic is still submitted so stored values survive edits. */}
          {taskVisibility && (
            <div className="flex items-center gap-2">
              <input
                id="task-public"
                type="checkbox"
                checked={isPublic}
                onChange={(e) => {
                  setIsPublic(e.target.checked);
                }}
                className="rounded border-rule text-accent focus-visible:outline-focus"
                disabled={isSubmitting}
              />
              <label htmlFor="task-public" className="text-xs font-semibold text-ink-2">
                Public Task <span className="font-normal text-ink-3">(visible on Nostr relays; unchecked means NIP-44 encrypted)</span>
              </label>
            </div>
          )}

          <div>
            <label htmlFor="task-description" className="block text-xs font-semibold text-ink-2">
              Description
            </label>
            <textarea
              id="task-description"
              rows={4}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="Detailed description, notes or checklist"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
          </div>

          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || projects.length === 0}
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? "Saving…" : isEditing ? "Save Changes" : "Create Task"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
