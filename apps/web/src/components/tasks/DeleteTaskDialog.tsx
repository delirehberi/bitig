import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import type { Task } from "@bitig/core";

interface DeleteTaskDialogProps {
  readonly isOpen: boolean;
  readonly task: Task | null;
  readonly onClose: () => void;
  readonly onConfirm: (id: string) => Promise<void>;
}

const ICON_SIZE = 16;

export function DeleteTaskDialog({ isOpen, task, onClose, onConfirm }: DeleteTaskDialogProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !task) return null;

  async function handleDelete() {
    if (!task) return;
    setIsDeleting(true);
    setError(null);
    try {
      await onConfirm(task.id);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-task-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div className="relative w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-danger-soft text-danger">
            <AlertTriangle size={18} />
          </div>
          <div>
            <h2 id="delete-task-title" className="m-0 font-display text-lg font-bold text-ink">
              Delete Task
            </h2>
            <p className="m-0 text-xs text-ink-3">This action cannot be undone</p>
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

        <p className="m-0 mb-4 text-sm text-ink-2">
          Are you sure you want to delete <strong className="text-ink">{task.title}</strong>?
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isDeleting}
            className="rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleDelete()}
            disabled={isDeleting}
            className="rounded-md bg-danger px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isDeleting ? "Deleting…" : "Delete Task"}
          </button>
        </div>
      </div>
    </div>
  );
}

