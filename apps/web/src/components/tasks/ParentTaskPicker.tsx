import { useId, useState } from "react";
import { X } from "lucide-react";
import { withTaskCodes, type Project, type Task } from "@bitig/core";

interface ParentTaskPickerProps {
  /** ID of the chosen parent task, or `""` when unparented. */
  readonly value: string;
  readonly onChange: (parentId: string) => void;
  /** Only tasks in this project can be selected as a parent. */
  readonly projectId: string;
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly excludeId?: string | undefined;
  readonly disabled?: boolean;
}

const MAX_SUGGESTIONS = 8;

/** Returns IDs of all tasks that have `rootId` as an ancestor in `parentId` chains. */
function collectDescendants(rootId: string | undefined, tasks: readonly Task[]): Set<string> {
  const descendants = new Set<string>();
  if (!rootId) return descendants;
  const childrenByParent = new Map<string, string[]>();
  for (const task of tasks) {
    if (!task.parentId || task.parentId === task.id) continue;
    const list = childrenByParent.get(task.parentId);
    if (list) list.push(task.id);
    else childrenByParent.set(task.parentId, [task.id]);
  }
  const queue = [...(childrenByParent.get(rootId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || descendants.has(id)) continue;
    descendants.add(id);
    for (const childId of childrenByParent.get(id) ?? []) {
      if (!descendants.has(childId)) queue.push(childId);
    }
  }
  return descendants;
}

/** Chooses an optional same-project acyclic parent task, searching by ticket code or title. */
export function ParentTaskPicker({
  value,
  onChange,
  projectId,
  tasks,
  projects,
  excludeId,
  disabled,
}: ParentTaskPickerProps) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const coded = withTaskCodes(tasks, projects);
  const byId = new Map(coded.map((t) => [t.id, t]));
  const descendants = collectDescendants(excludeId, tasks);
  const selected = value ? byId.get(value) : undefined;

  const q = query.trim().toLowerCase();
  const suggestions =
    q === ""
      ? []
      : coded
          .filter(
            (t) =>
              t.projectId === projectId &&
              t.id !== excludeId &&
              t.id !== value &&
              !descendants.has(t.id) &&
              t.status !== "archived" &&
              (t.code?.toLowerCase().includes(q) === true || t.title.toLowerCase().includes(q)),
          )
          .slice(0, MAX_SUGGESTIONS);

  function pick(id: string) {
    onChange(id);
    setQuery("");
  }

  return (
    <div className="flex flex-col gap-2">
      {value && (
        <div
          aria-label="Chosen parent task"
          className="inline-flex max-w-full items-center gap-1.5 self-start rounded-pill border border-rule bg-paper-2 py-0.5 pr-1 pl-2 text-xs text-ink"
        >
          <span
            className={`font-mono font-semibold ${
              selected?.status === "done" || selected?.status === "archived" ? "text-ink-3 line-through" : ""
            }`}
          >
            {selected === undefined ? "Deleted task" : (selected.code ?? selected.title)}
          </span>
          {selected?.code !== undefined && (
            <span className="max-w-48 truncate text-ink-2">{selected.title}</span>
          )}
          <button
            type="button"
            onClick={() => {
              onChange("");
            }}
            disabled={disabled}
            aria-label={`Remove parent ${selected === undefined ? "task" : (selected.code ?? selected.title)}`}
            className="rounded-pill p-0.5 text-ink-3 hover:text-ink focus-visible:outline-focus"
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
      )}
      <label htmlFor={inputId} className="sr-only">
        Find a parent task
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const first = suggestions[0];
          if (first !== undefined) pick(first.id);
        }}
        placeholder="Search same-project parent by code or title"
        disabled={disabled}
        className="w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
      />
      {suggestions.length > 0 && (
        <ul aria-label="Matching parent tasks" className="m-0 flex list-none flex-col rounded-md border border-rule p-0">
          {suggestions.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  pick(t.id);
                }}
                className="flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm text-ink hover:bg-paper-2 focus-visible:outline-focus"
              >
                {t.code !== undefined && <span className="font-mono text-xs font-semibold text-ink-3">{t.code}</span>}
                <span className="truncate">{t.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q !== "" && suggestions.length === 0 && (
        <p className="m-0 text-xs text-ink-3">No matching same-project tasks</p>
      )}
    </div>
  );
}
