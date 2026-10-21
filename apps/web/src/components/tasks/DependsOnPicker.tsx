import { useId, useState } from "react";
import { X } from "lucide-react";
import { withTaskCodes, type Project, type Task } from "@bitig/core";

interface DependsOnPickerProps {
  /** IDs of the chosen tasks, in order. */
  readonly value: readonly string[];
  readonly onChange: (ids: string[]) => void;
  /** Every task that can be chosen; the task being edited is left out by `excludeId`. */
  readonly tasks: readonly Task[];
  readonly projects: readonly Project[];
  readonly excludeId?: string | undefined;
  readonly disabled?: boolean;
}

const MAX_SUGGESTIONS = 8;

/** Chooses the tasks a task depends on, searching by ticket code or title. */
export function DependsOnPicker({ value, onChange, tasks, projects, excludeId, disabled }: DependsOnPickerProps) {
  const [query, setQuery] = useState("");
  const inputId = useId();
  const coded = withTaskCodes(tasks, projects);
  const byId = new Map(coded.map((t) => [t.id, t]));
  const chosen = new Set(value);

  const q = query.trim().toLowerCase();
  const suggestions =
    q === ""
      ? []
      : coded
          .filter(
            (t) =>
              t.id !== excludeId &&
              !chosen.has(t.id) &&
              t.status !== "archived" &&
              (t.code?.toLowerCase().includes(q) === true || t.title.toLowerCase().includes(q)),
          )
          .slice(0, MAX_SUGGESTIONS);

  function add(id: string) {
    onChange([...value, id]);
    setQuery("");
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul aria-label="Chosen dependencies" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {value.map((id) => {
            const task = byId.get(id);
            const name = task === undefined ? "Deleted task" : (task.code ?? task.title);
            const closed = task?.status === "done" || task?.status === "archived";
            return (
              <li
                key={id}
                title={task?.title}
                className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper-2 py-0.5 pr-1 pl-2 text-xs text-ink"
              >
                <span className={`font-mono font-semibold ${closed ? "text-ink-3 line-through" : ""}`}>{name}</span>
                {task?.code !== undefined && <span className="max-w-40 truncate text-ink-2">{task.title}</span>}
                <button
                  type="button"
                  onClick={() => {
                    onChange(value.filter((other) => other !== id));
                  }}
                  disabled={disabled}
                  aria-label={`Remove dependency ${name}`}
                  className="rounded-pill p-0.5 text-ink-3 hover:text-ink focus-visible:outline-focus"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <label htmlFor={inputId} className="sr-only">
        Find a task to depend on
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        onKeyDown={(e) => {
          // Enter picks the first match instead of submitting the form.
          if (e.key !== "Enter") return;
          e.preventDefault();
          const first = suggestions[0];
          if (first !== undefined) add(first.id);
        }}
        placeholder="Search by code or title, e.g. BIT-63"
        disabled={disabled}
        className="w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
      />
      {suggestions.length > 0 && (
        <ul aria-label="Matching tasks" className="m-0 flex list-none flex-col rounded-md border border-rule p-0">
          {suggestions.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => {
                  add(t.id);
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
      {q !== "" && suggestions.length === 0 && <p className="m-0 text-xs text-ink-3">No matching tasks</p>}
    </div>
  );
}
