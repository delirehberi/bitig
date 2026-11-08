import { useState } from "react";
import { ArrowRight, Bot, MessageSquare, Paperclip, Trash2, User } from "lucide-react";
import {
  canSwitchT3Model,
  type AgentRun,
  type Comment,
  type StorageProvider,
  type T3ModelCapability,
  type T3ModelSelection,
} from "@bitig/core";
import { useComments } from "../../hooks/useComments";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import { replyToTaskT3Run } from "../../services/t3";
import { T3ModelPicker } from "./T3ModelPicker";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Markdown } from "../Markdown";

const ICON_SIZE = 12;

function CommentItem({ comment, onDelete }: { readonly comment: Comment; readonly onDelete: () => void }) {
  const isAgent = comment.authorType === "agent";
  const Icon = isAgent ? Bot : User;
  const name = comment.author ?? (isAgent ? "Agent" : "You");
  return (
    <li className="rounded-md border border-rule bg-paper-2 px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-2xs text-ink-3">
        <Icon size={ICON_SIZE} aria-hidden="true" />
        <span className="font-semibold text-ink-2">{name}</span>
        {isAgent && comment.author !== undefined && <span>(agent)</span>}
        <time dateTime={comment.createdAt} title={formatFullTimestamp(comment.createdAt)}>
          {formatTimeAgo(comment.createdAt)}
        </time>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete comment by ${name}`}
          className="ml-auto text-ink-3 transition-colors hover:text-danger"
        >
          <Trash2 size={ICON_SIZE} aria-hidden="true" />
        </button>
      </div>
      <Markdown content={comment.body} className="text-sm text-ink" />
    </li>
  );
}

/** The task's T3 thread, when it has one, so a reply can switch the thread's model (#BIT-119). */
export interface TaskCommentsT3Context {
  readonly run: AgentRun;
  readonly capabilities: readonly T3ModelCapability[];
}

/** Picks a human-friendly agent label (e.g. "Codex", "Claude") from the T3 run and capability list. */
export function agentNameForT3(
  t3: TaskCommentsT3Context | undefined,
  fallbackAuthor?: string | undefined,
): string {
  if (t3) {
    const { run, capabilities } = t3;
    const byProvider = run.providerInstanceId
      ? capabilities.find((c) => c.providerInstanceId === run.providerInstanceId)
      : undefined;
    if (byProvider?.displayName) return byProvider.displayName;
    const byModel = run.model ? capabilities.find((c) => c.model === run.model) : undefined;
    if (byModel?.displayName) return byModel.displayName;
    const prov = run.providerInstanceId?.toLowerCase();
    if (prov?.includes("codex")) return "Codex";
    if (prov?.includes("claude")) return "Claude";
    if (prov?.includes("antigravity") || prov?.includes("gemini")) return "Antigravity";
    const model = run.model?.toLowerCase();
    if (model?.startsWith("gpt-") || model?.startsWith("o1") || model?.startsWith("o3") || model?.includes("codex")) {
      return "Codex";
    }
    if (model?.startsWith("claude")) return "Claude";
    if (model?.startsWith("gemini")) return "Antigravity";
    if (run.providerInstanceId) {
      return run.providerInstanceId.charAt(0).toUpperCase() + run.providerInstanceId.slice(1);
    }
  }
  if (fallbackAuthor && fallbackAuthor.trim().length > 0) {
    return fallbackAuthor;
  }
  return "Agent";
}

export async function sendTaskT3Reply(
  taskId: string,
  body: string,
  options: { readonly selection?: T3ModelSelection | undefined; readonly freshSession?: boolean | undefined } = {},
): Promise<void> {
  const result = await replyToTaskT3Run(taskId, {
    body,
    ...(options.selection ? { modelSelection: options.selection } : {}),
    ...(options.freshSession ? { freshSession: true } : {}),
  });
  // Show the saved comments and the run's new state/thread at once; the server's realtime events follow.
  if (result.switchComment) {
    dispatchRealtimeEvent({ type: "comment.created", comment: result.switchComment });
  }
  dispatchRealtimeEvent({ type: "comment.created", comment: result.comment });
  dispatchRealtimeEvent({ type: "agent_run.updated", run: result.run });
}

export interface TaskComposerProps {
  readonly taskId: string;
  readonly addComment: (body: string) => Promise<Comment>;
  readonly t3?: TaskCommentsT3Context | undefined;
  readonly needsHuman?: boolean | undefined;
  readonly onResolve?: (() => void) | undefined;
  readonly onAttachClick?: (() => void) | undefined;
  readonly agentName?: string | undefined;
}

/**
 * Pinned bottom-dock composer for the full-page task detail view (#BIT-168).
 * Replies to a waiting T3 thread (and clears needsHuman), or posts a plain comment otherwise.
 */
export function TaskComposer({
  taskId,
  addComment,
  t3,
  needsHuman = false,
  onResolve,
  onAttachClick,
  agentName,
}: TaskComposerProps) {
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<T3ModelSelection | null>(null);
  const [freshSession, setFreshSession] = useState(false);

  const hasReachableT3Run = t3 !== undefined && t3.run.state !== "offline";
  const showModelPicker = hasReachableT3Run && t3.capabilities.length > 0;
  const canSwitch = t3 !== undefined && canSwitchT3Model(t3.run.state);
  const switchSelection = showModelPicker && canSwitch ? modelSelection : null;
  const startFreshSession = hasReachableT3Run && canSwitch && freshSession;

  const isAgentWaiting =
    hasReachableT3Run &&
    (t3.run.state === "waiting_for_approval" || (needsHuman && canSwitch));
  const isAgentWorking =
    hasReachableT3Run &&
    (t3.run.state === "working" || t3.run.state === "queued" || t3.run.state === "waiting_subagent");
  const willReplyToAgent = isAgentWaiting || switchSelection !== null || startFreshSession;
  const resolvedAgentName = agentName ?? agentNameForT3(t3);

  async function submit() {
    if (draft.trim() === "" || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      if (willReplyToAgent) {
        await sendTaskT3Reply(taskId, draft, {
          ...(switchSelection ? { selection: switchSelection } : {}),
          ...(startFreshSession ? { freshSession: true } : {}),
        });
        setModelSelection(null);
        setFreshSession(false);
        if (needsHuman) {
          onResolve?.();
        }
      } else {
        await addComment(draft);
      }
      setDraft("");
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className={`overflow-hidden rounded-md border bg-paper transition-colors ${
        willReplyToAgent ? "border-accent" : "border-rule"
      }`}
    >
      <div
        data-testid="composer-route-strip"
        className={`flex flex-wrap items-center gap-2 border-b px-3 py-1.5 text-2xs ${
          willReplyToAgent
            ? "border-transparent bg-accent-soft font-semibold text-accent-ink"
            : "border-rule bg-paper-2 text-ink-3"
        }`}
      >
        {willReplyToAgent ? (
          <>
            <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            <span>Replying to {resolvedAgentName}</span>
          </>
        ) : isAgentWorking ? (
          <>
            <span className="size-1.5 rounded-full bg-accent" aria-hidden="true" />
            <span>{resolvedAgentName} is working. This posts a comment.</span>
          </>
        ) : (
          <span>Comment</span>
        )}
        {needsHuman && onResolve && (
          <button
            type="button"
            onClick={onResolve}
            className="ml-auto font-semibold text-accent-ink underline transition-opacity hover:opacity-80 focus-visible:outline-focus"
          >
            Resolve without reply
          </button>
        )}
      </div>

      <label htmlFor={`composer-draft-${taskId}`} className="sr-only">
        Message
      </label>
      <textarea
        id={`composer-draft-${taskId}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
        placeholder={willReplyToAgent ? `Reply to ${resolvedAgentName}\u2026` : "Add a comment\u2026"}
        className="block w-full resize-none border-0 bg-transparent px-3 pt-2 pb-1 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
      />

      {saveError && (
        <p role="alert" className="m-0 px-3 py-1 text-xs text-danger">
          {saveError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 px-2.5 pt-1 pb-2">
        {onAttachClick && (
          <button
            type="button"
            onClick={onAttachClick}
            aria-label="Attach file"
            title="Attach file"
            className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-2xs text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
          >
            <Paperclip size={13} aria-hidden="true" />
          </button>
        )}

        {hasReachableT3Run && showModelPicker && (
          <T3ModelPicker
            idSuffix={`reply-${taskId}`}
            keepLabel={`Keep current model (${t3.run.model ?? "default model"})`}
            capabilities={t3.capabilities}
            value={switchSelection}
            onChange={setModelSelection}
            disabled={isSaving || !canSwitch}
          />
        )}

        {hasReachableT3Run && (
          <label className="inline-flex items-center gap-1.5 text-2xs text-ink-2">
            <input
              type="checkbox"
              checked={startFreshSession}
              disabled={isSaving || !canSwitch}
              onChange={(e) => {
                setFreshSession(e.target.checked);
              }}
            />
            <span>Fresh session</span>
          </label>
        )}

        <span className="flex-1" />
        <kbd className="hidden font-mono text-2xs text-ink-3 sm:inline">⌘↵</kbd>
        <button
          type="submit"
          disabled={draft.trim() === "" || isSaving}
          className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-focus"
        >
          {isSaving ? "Sending\u2026" : "Send"}
          <ArrowRight size={13} aria-hidden="true" />
        </button>
      </div>
    </form>
  );
}

interface TaskCommentsProps {
  readonly storage: StorageProvider;
  readonly taskId: string;
  /** Provided when the task has needsHuman set; lets the user explicitly resolve while commenting. */
  readonly onResolve?: (() => void) | undefined;
  readonly t3?: TaskCommentsT3Context | undefined;
}

/** A task's comments, oldest first, with a box to add one. */
export function TaskComments({ storage, taskId, onResolve, t3 }: TaskCommentsProps) {
  const { comments, isLoading, error, addComment, deleteComment } = useComments(storage, taskId);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [modelSelection, setModelSelection] = useState<T3ModelSelection | null>(null);
  const [freshSession, setFreshSession] = useState(false);

  // Offline runs cannot be reached; without a model list there is nothing to pick.
  const hasReachableT3Run = t3 !== undefined && t3.run.state !== "offline";
  const showModelPicker = hasReachableT3Run && t3.capabilities.length > 0;
  const canSwitch = t3 !== undefined && canSwitchT3Model(t3.run.state);
  const switchSelection = showModelPicker && canSwitch ? modelSelection : null;
  const startFreshSession = hasReachableT3Run && canSwitch && freshSession;

  async function submit(resolveNeedsHuman = false) {
    if (draft.trim() === "" || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      if (switchSelection || startFreshSession) {
        await sendTaskT3Reply(taskId, draft, {
          ...(switchSelection ? { selection: switchSelection } : {}),
          ...(startFreshSession ? { freshSession: true } : {}),
        });
        setModelSelection(null);
        setFreshSession(false);
      } else {
        await addComment(draft);
      }
      setDraft("");
      if (resolveNeedsHuman) {
        onResolve?.();
      }
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setIsSaving(false);
    }
  }

  async function remove(id: string) {
    setSaveError(null);
    try {
      await deleteComment(id);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to delete comment");
    }
  }

  return (
    <section aria-labelledby="task-detail-comments" className="mb-5">
      <h3
        id="task-detail-comments"
        className="m-0 mb-2 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3"
      >
        <MessageSquare size={ICON_SIZE} aria-hidden="true" />
        Comments{comments.length > 0 ? ` (${String(comments.length)})` : ""}
      </h3>

      {isLoading && <p className="m-0 mb-2 text-sm text-ink-3">Loading comments…</p>}
      {error && (
        <p role="alert" className="m-0 mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      {!isLoading && !error && comments.length === 0 && (
        <p className="m-0 mb-2 text-sm text-ink-3">No comments yet</p>
      )}
      {comments.length > 0 && (
        <ul className="m-0 mb-3 flex list-none flex-col gap-2 p-0">
          {comments.map((comment) => (
            <CommentItem
              key={comment.id}
              comment={comment}
              onDelete={() => {
                void remove(comment.id);
              }}
            />
          ))}
        </ul>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label htmlFor={`comment-draft-${taskId}`} className="sr-only">
          Add a comment
        </label>
        <textarea
          id={`comment-draft-${taskId}`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="Add a comment or answer a question…"
          className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
        />
        {hasReachableT3Run && (
          <div className="mt-2 flex flex-col gap-1.5">
            {showModelPicker && (
              <T3ModelPicker
                idSuffix={`reply-${taskId}`}
                keepLabel={`Keep current model (${t3.run.model ?? "default model"})`}
                capabilities={t3.capabilities}
                value={switchSelection}
                onChange={setModelSelection}
                disabled={isSaving || !canSwitch}
              />
            )}
            <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
              <input
                type="checkbox"
                checked={startFreshSession}
                disabled={isSaving || !canSwitch}
                onChange={(e) => {
                  setFreshSession(e.target.checked);
                }}
              />
              Start in fresh T3 session (from checkpoint)
            </label>
            {!canSwitch && (
              <p className="m-0 text-2xs text-ink-3">
                The model or session can change once the T3 thread waits for you or its turn ends.
              </p>
            )}
          </div>
        )}
        {saveError && (
          <p role="alert" className="m-0 mt-1 text-xs text-danger">
            {saveError}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          {onResolve && (
            <button
              type="button"
              disabled={draft.trim() === "" || isSaving}
              onClick={() => {
                void submit(true);
              }}
              className="rounded-md border border-accent/30 bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent-ink transition-colors hover:opacity-90 disabled:opacity-50"
            >
              Comment & resolve
            </button>
          )}
          <button
            type="submit"
            disabled={draft.trim() === "" || isSaving}
            className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
          >
            {isSaving ? "Saving…" : "Comment"}
          </button>
        </div>
      </form>
    </section>
  );
}
