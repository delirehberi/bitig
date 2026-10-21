import { useRef, useState } from "react";
import { Link2Off, X } from "lucide-react";
import type { Task, TaskStatus } from "@bitig/core";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/** A status change refused because the task waits on unfinished dependencies. */
export interface BlockedStatusChange {
  readonly task: Task;
  readonly status: TaskStatus;
  /** Ticket codes (or IDs) of the unfinished dependencies. */
  readonly blockedBy: readonly string[];
  /** Retries the change with the override; the server records it in the task's activity. */
  readonly override: () => Promise<unknown>;
}

interface BlockedTaskDialogProps {
  readonly change: BlockedStatusChange | null;
  readonly onClose: () => void;
}

const ICON_SIZE = 16;

export function BlockedTaskDialog({ change, onClose }: BlockedTaskDialogProps) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, change !== null);

  if (!change) return null;

  const verb = change.status === "done" ? "Complete" : "Start";

  async function handleOverride() {
    if (!change) return;
    setIsSaving(true);
    setError(null);
    try {
      await change.override();
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update task");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="blocked-task-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-4 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <Link2Off size={18} />
          </div>
          <div>
            <h2 id="blocked-task-title" className="m-0 font-display text-lg font-bold text-ink">
              Task is blocked
            </h2>
            <p className="m-0 text-xs text-ink-3">Its dependencies are not finished</p>
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
          <strong className="text-ink">{change.task.title}</strong> waits on{" "}
          <strong className="font-mono text-ink">{change.blockedBy.join(", ")}</strong>. {verb} it anyway? The
          override is recorded in the task&apos;s activity.
        </p>

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleOverride()}
            disabled={isSaving}
            className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isSaving ? "Saving…" : `${verb} anyway`}
          </button>
        </div>
      </div>
    </div>
  );
}
