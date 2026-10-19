import { useState } from "react";
import {
  addChecklistItem,
  checklistProgress,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
  type ChecklistItem,
} from "@bitig/core";
import { ArrowDown, ArrowUp, ListChecks, Plus, X } from "lucide-react";

const ICON_SIZE = 14;

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
}

/** Checkable list for the task detail view. */
export function ChecklistView({ checklist, onToggle }: ChecklistViewProps) {
  const items = checklist ?? [];
  if (items.length === 0) return <span className="text-ink-3">No subtasks</span>;

  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
      {items.map((item, index) => (
        // Items have no identity beyond their position, which is also their order.
        <li key={index} className="flex items-start gap-2">
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
        </li>
      ))}
    </ul>
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
