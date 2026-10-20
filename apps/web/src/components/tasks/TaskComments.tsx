import { useState } from "react";
import { Bot, MessageSquare, Trash2, User } from "lucide-react";
import type { Comment, StorageProvider } from "@bitig/core";
import { useComments } from "../../hooks/useComments";

const ICON_SIZE = 12;

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

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
        <time dateTime={comment.createdAt}>{formatTimestamp(comment.createdAt)}</time>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete comment by ${name}`}
          className="ml-auto text-ink-3 transition-colors hover:text-danger"
        >
          <Trash2 size={ICON_SIZE} aria-hidden="true" />
        </button>
      </div>
      <p className="m-0 whitespace-pre-wrap text-sm text-ink">{comment.body}</p>
    </li>
  );
}

interface TaskCommentsProps {
  readonly storage: StorageProvider;
  readonly taskId: string;
}

/** A task's comments, oldest first, with a box to add one. */
export function TaskComments({ storage, taskId }: TaskCommentsProps) {
  const { comments, isLoading, error, addComment, deleteComment } = useComments(storage, taskId);
  const [draft, setDraft] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function submit() {
    if (draft.trim() === "" || isSaving) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      await addComment(draft);
      setDraft("");
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
        {saveError && (
          <p role="alert" className="m-0 mt-1 text-xs text-danger">
            {saveError}
          </p>
        )}
        <div className="mt-2 flex justify-end">
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
