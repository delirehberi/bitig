import { Hand } from "lucide-react";

/*
 * Human in the loop: a task with `needsHuman` set waits on a person, and the
 * text says what for. Agents set it over MCP; a person clears it once answered.
 */

/** Pill for list rows showing the flag and the agent's question; renders nothing when the task needs nobody. */
export function NeedsHumanBadge({ reason }: { readonly reason: string | undefined }) {
  if (reason === undefined) return null;
  return (
    <span
      title={`Needs you: ${reason}`}
      className="inline-flex max-w-xs shrink-0 items-center gap-1 rounded-pill border border-accent/30 bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent-ink"
    >
      <Hand size={12} aria-hidden="true" className="shrink-0" />
      <span className="truncate">Needs you: {reason}</span>
    </span>
  );
}

interface NeedsHumanNoteProps {
  readonly reason: string | undefined;
  /** Shows a button that clears the flag; omit for a read-only note. */
  readonly onResolve?: (() => void) | undefined;
  /** Clamps the reason to two lines, for cards. */
  readonly compact?: boolean;
}

/** The reason, called out on cards and in the detail view. */
export function NeedsHumanNote({ reason, onResolve, compact = false }: NeedsHumanNoteProps) {
  if (reason === undefined) return null;
  return (
    <div
      role="note"
      aria-label="Needs you"
      className="flex items-start gap-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-ink"
    >
      <Hand size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-ink" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold text-accent-ink">Needs you: </span>
        <span className={compact ? "line-clamp-2" : "whitespace-pre-wrap"}>{reason}</span>
      </div>
      {onResolve && (
        <button
          type="button"
          onClick={onResolve}
          className="shrink-0 rounded-md border border-accent/30 bg-paper px-2 py-1 text-2xs font-semibold text-accent-ink transition-colors hover:bg-paper-2 focus-visible:outline-focus"
        >
          Mark answered
        </button>
      )}
    </div>
  );
}
