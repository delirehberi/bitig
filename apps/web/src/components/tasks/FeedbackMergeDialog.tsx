import { useMemo, useRef, useState } from "react";
import { GitMerge, X } from "lucide-react";
import { compareTasks, type Project, type Task } from "@bitig/core";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { isFeedbackTask } from "../../domain/feedback-tasks";
import { taskRef } from "../../domain/task-ref";

interface FeedbackMergeDialogProps {
  /** The pending feedback task being merged; the dialog is closed when null. */
  readonly source: Task | null;
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly onClose: () => void;
  /** Merges the feedback into the chosen task; rejects with the message to show. */
  readonly onConfirm: (target: Task) => Promise<void>;
}

const ICON_SIZE = 16;
const FALLBACK_ERROR = "Could not merge the feedback.";

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : FALLBACK_ERROR;
}

/** Picks the task a feedback submission is merged into: a non-feedback task in the same project (#BIT-181). */
export function FeedbackMergeDialog({ source, tasks, projects, onClose, onConfirm }: FeedbackMergeDialogProps) {
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, source !== null);

  const candidates = useMemo(() => {
    if (!source) return [];
    const needle = query.trim().toLowerCase();
    return tasks
      .filter(
        (task) =>
          task.projectId === source.projectId &&
          task.id !== source.id &&
          task.status !== "archived" &&
          !isFeedbackTask(task) &&
          (needle === "" || task.title.toLowerCase().includes(needle)),
      )
      .sort(compareTasks);
  }, [source, tasks, query]);

  if (!source) return null;

  async function handlePick(target: Task) {
    setBusyId(target.id);
    setError(null);
    try {
      await onConfirm(target);
      onClose();
    } catch (err: unknown) {
      setError(errorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="feedback-merge-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex max-h-[80vh] w-full max-w-md flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-lg outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="flex items-center gap-3 pr-6">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <GitMerge size={18} aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="feedback-merge-title" className="m-0 font-display text-base font-bold text-ink">
              Merge feedback into a task
            </h2>
            <p className="m-0 truncate text-xs text-ink-2">
              {taskRef(source, projects)} · {source.title}
            </p>
          </div>
        </div>

        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-2">
          <span>Search tasks</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Filter by title"
            className="rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
          />
        </label>

        {error && (
          <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-xs font-medium text-danger">
            {error}
          </div>
        )}

        <ul className="m-0 flex min-h-0 flex-1 list-none flex-col gap-1 overflow-y-auto p-0">
          {candidates.length === 0 && (
            <li className="py-6 text-center text-xs text-ink-3">No tasks in this project match.</li>
          )}
          {candidates.map((task) => (
            <li key={task.id}>
              <button
                type="button"
                disabled={busyId !== null}
                onClick={() => {
                  void handlePick(task);
                }}
                className="flex w-full items-center gap-2 rounded-md border border-rule bg-paper px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-paper-2 disabled:opacity-60 focus-visible:outline-focus"
              >
                <span className="shrink-0 font-mono text-2xs text-ink-3">{taskRef(task, projects)}</span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
