import { ShieldCheck, ShieldQuestionMark, Trash2 } from "lucide-react";

/*
 * Approval gate: a task an agent (over MCP) or a webhook created carries
 * `pendingApproval` until a person approves it. Agents cannot start or
 * complete it until then. Rejecting deletes it.
 */

/** Pill for list rows; renders nothing once the task is approved. */
export function ApprovalBadge({ pending }: { readonly pending: boolean }) {
  if (!pending) return null;
  return (
    <span
      title="Created by an agent or webhook; approve it before it can be worked on"
      className="inline-flex shrink-0 items-center gap-1 rounded-pill border border-dashed border-rule-strong bg-paper-3 px-2 py-0.5 text-2xs font-semibold text-ink"
    >
      <ShieldQuestionMark size={12} aria-hidden="true" className="shrink-0" />
      Awaiting approval
    </span>
  );
}

interface ApprovalNoteProps {
  readonly pending: boolean;
  /** Shows a button that approves the task; omit for a read-only note. */
  readonly onApprove?: (() => void) | undefined;
  /** Shows a button that rejects (deletes) the task; the caller confirms first. */
  readonly onReject?: (() => void) | undefined;
  /** Shortens the explanation, for cards. */
  readonly compact?: boolean;
}

/** The call to approve, on cards and in the detail view. */
export function ApprovalNote({ pending, onApprove, onReject, compact = false }: ApprovalNoteProps) {
  if (!pending) return null;
  return (
    <div
      role="note"
      aria-label="Awaiting approval"
      className="flex flex-wrap items-start gap-2 rounded-md border border-dashed border-rule-strong bg-paper-3 px-3 py-2 text-xs text-ink"
    >
      <ShieldQuestionMark size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-2" />
      <div className="min-w-0 flex-1">
        <span className="font-semibold">Awaiting approval</span>
        {!compact && (
          <span className="text-ink-2">
            {" "}
            — an agent or webhook created this task. It can't be started or completed by an agent until you approve it.
          </span>
        )}
      </div>
      {(onApprove ?? onReject) && (
        <div className="flex shrink-0 items-center gap-1">
          {onApprove && (
            <button
              type="button"
              onClick={onApprove}
              className="inline-flex items-center gap-1 rounded-md border border-ok/30 bg-ok-soft px-2 py-1 text-2xs font-semibold text-ok transition-colors hover:bg-paper-2 focus-visible:outline-focus"
            >
              <ShieldCheck size={12} aria-hidden="true" />
              Approve
            </button>
          )}
          {onReject && (
            <button
              type="button"
              onClick={onReject}
              className="inline-flex items-center gap-1 rounded-md border border-danger/30 bg-danger-soft px-2 py-1 text-2xs font-semibold text-danger transition-colors hover:bg-paper-2 focus-visible:outline-focus"
            >
              <Trash2 size={12} aria-hidden="true" />
              Reject
            </button>
          )}
        </div>
      )}
    </div>
  );
}
