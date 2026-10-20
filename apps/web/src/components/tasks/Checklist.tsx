import { useState } from "react";
import {
  addChecklistItem,
  checklistProgress,
  formatDuration,
  getSubtaskTimings,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
  startChecklistItem,
  type ChecklistItem,
  type Task,
} from "@bitig/core";
import { ArrowDown, ArrowUp, Clock, ListChecks, Play, Plus, X } from "lucide-react";

const ICON_SIZE = 14;

function formatShortTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** `2/5` badge for cards and rows; renders nothing for a task without a checklist. */
export function ChecklistProgressBadge({ checklist }: { readonly checklist: readonly ChecklistItem[] | undefined }) {
  const { done, total } = checklistProgress(checklist);
  if (total === 0) return null;
  const complete = done === total;
  return (
    <span
      title={`${String(done)} of ${String(total)} subtasks done`}
      className={`inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-2xs font-semibold tabular-nums ${
        complete ? "bg-ok-soft text-ok" : "bg-paper-2 text-ink-2"
      }`}
    >
      <ListChecks size={12} aria-hidden="true" />
      {done}/{total}
    </span>
  );
}

interface ChecklistViewProps {
  readonly checklist: readonly ChecklistItem[] | undefined;
  /** Called with the whole next list; omit for a read-only view. */
  readonly onToggle?: ((next: ChecklistItem[]) => void) | undefined;
  /** Optional parent task used to compute subtask spent durations. */
  readonly task?: Task | undefined;
}

/** Checkable list for the task detail view, with an inline input to add subtasks when editable. */
export function ChecklistView({ checklist, onToggle, task }: ChecklistViewProps) {
  const [draft, setDraft] = useState("");
  const items = checklist ?? [];
  const timings = task
    ? getSubtaskTimings({
        ...task,
        ...(items.length > 0 ? { checklist: [...items] } : {}),
      })
    : undefined;

  function addDraft() {
    const text = draft.trim();
    if (!text || !onToggle) return;
    onToggle(addChecklistItem(items, text));
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2">
      {items.length === 0 ? (
        <span className="text-sm text-ink-3">No subtasks</span>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((item, index) => {
            const timing = timings?.[index];
            const spentMs = timing?.spentMs;

            return (
              // Items have no identity beyond their position, which is also their order.
              <li key={index} className="flex flex-wrap items-start justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  <input
                    type="checkbox"
                    id={`checklist-view-${String(index)}`}
                    checked={item.done}
                    disabled={!onToggle}
                    onChange={(e) => {
                      onToggle?.(setChecklistItemDone(items, index, e.target.checked));
                    }}
                    className="mt-0.5 rounded border-rule text-accent focus-visible:outline-focus"
                  />
                  <label
                    htmlFor={`checklist-view-${String(index)}`}
                    className={`text-sm ${item.done ? "text-ink-3 line-through" : "text-ink"}`}
                  >
                    {item.text}
                  </label>
                </div>

                <div className="flex items-center gap-1.5 text-2xs text-ink-3">
                  {item.done && spentMs !== undefined && (
                    <span
                      title="Time spent on subtask"
                      className="inline-flex items-center gap-1 rounded-pill bg-paper-2 px-2 py-0.5 font-mono font-semibold text-ink-2"
                    >
                      <Clock size={10} aria-hidden="true" />
                      {formatDuration(spentMs)}
                    </span>
                  )}
                  {item.done && item.completedAt && (
                    <span title={`Completed at ${item.completedAt}`}>
                      {formatShortTimestamp(item.completedAt)}
                    </span>
                  )}
                  {!item.done && item.startedAt && (
                    <span
                      title={`Started at ${item.startedAt}`}
                      className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 font-medium text-accent-ink"
                    >
                      <Clock size={10} aria-hidden="true" />
                      Started {formatShortTimestamp(item.startedAt)}
                    </span>
                  )}
                  {!item.done && !item.startedAt && onToggle && (
                    <button
                      type="button"
                      aria-label={`Start subtask: ${item.text}`}
                      title="Record start time for this subtask"
                      onClick={() => {
                        onToggle(startChecklistItem(items, index, new Date().toISOString()));
                      }}
                      className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper-2 px-1.5 py-0.5 text-2xs font-medium text-ink-2 transition-colors hover:text-ink focus-visible:outline-focus"
                    >
                      <Play size={10} aria-hidden="true" />
                      Start
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {onToggle && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={draft}
            aria-label="New subtask"
            placeholder="Add a subtask"
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addDraft();
              }
            }}
            className="min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-2 py-1 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
          />
          <button
            type="button"
            onClick={addDraft}
            disabled={!draft.trim()}
            className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
          >
            <Plus size={ICON_SIZE} aria-hidden="true" />
            Add
          </button>
        </div>
      )}
    </div>
  );
}

interface ChecklistEditorProps {
  readonly items: readonly ChecklistItem[];
  readonly onChange: (next: ChecklistItem[]) => void;
  readonly disabled?: boolean;
}

/** Full editor for the task form: check, rename, reorder, remove and add items. */
export function ChecklistEditor({ items, onChange, disabled = false }: ChecklistEditorProps) {
  const [draft, setDraft] = useState("");

  function addDraft() {
    const text = draft.trim();
    if (!text) return;
    onChange(addChecklistItem(items, text));
    setDraft("");
  }

  const buttonClass =
    "rounded-md p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-30 focus-visible:outline-focus";

  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((item, index) => (
            <li key={index} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={item.done}
                aria-label={`Done: ${item.text}`}
                disabled={disabled}
                onChange={(e) => {
                  onChange(setChecklistItemDone(items, index, e.target.checked));
                }}
                className="rounded border-rule text-accent focus-visible:outline-focus"
              />
              <input
                type="text"
                value={item.text}
                aria-label={`Subtask ${String(index + 1)}`}
                disabled={disabled}
                onChange={(e) => {
                  onChange(renameChecklistItem(items, index, e.target.value));
                }}
                className={`min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-2 py-1 text-sm focus-visible:outline-focus ${
                  item.done ? "text-ink-3 line-through" : "text-ink"
                }`}
              />
              <button
                type="button"
                aria-label={`Move up: ${item.text}`}
                disabled={disabled || index === 0}
                onClick={() => {
                  onChange(moveChecklistItem(items, index, index - 1));
                }}
                className={buttonClass}
              >
                <ArrowUp size={ICON_SIZE} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Move down: ${item.text}`}
                disabled={disabled || index === items.length - 1}
                onClick={() => {
                  onChange(moveChecklistItem(items, index, index + 1));
                }}
                className={buttonClass}
              >
                <ArrowDown size={ICON_SIZE} aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-label={`Remove: ${item.text}`}
                disabled={disabled}
                onClick={() => {
                  onChange(removeChecklistItem(items, index));
                }}
                className={`${buttonClass} hover:bg-danger-soft hover:text-danger`}
              >
                <X size={ICON_SIZE} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={draft}
          aria-label="New subtask"
          placeholder="Add a subtask"
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            // Enter adds the item instead of submitting the whole task form.
            if (e.key === "Enter") {
              e.preventDefault();
              addDraft();
            }
          }}
          className="min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-2 py-1 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
        />
        <button
          type="button"
          onClick={addDraft}
          disabled={disabled || !draft.trim()}
          className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
        >
          <Plus size={ICON_SIZE} aria-hidden="true" />
          Add
        </button>
      </div>
    </div>
  );
}
