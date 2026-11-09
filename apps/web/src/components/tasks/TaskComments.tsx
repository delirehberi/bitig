import { useRef, useState } from "react";
import { ArrowRight, Bot, File as FileIcon, MessageSquare, Paperclip, Trash2, User, X } from "lucide-react";
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentNameSchema,
  appendAttachmentsToCommentBody,
  canSwitchT3Model,
  encodeBase64,
  isImageAttachmentMimeType,
  type Attachment,
  type Comment,
  type StorageProvider,
  type T3ModelSelection,
} from "@bitig/core";
import { useComments } from "../../hooks/useComments";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import { replyToTaskT3Run } from "../../services/t3";
import { T3ModelPicker } from "./T3ModelPicker";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Markdown } from "../Markdown";
import {
  extractFilesFromClipboard,
  fileToAttachmentInput,
  formatByteSize,
} from "./attachment-utils";
import type { StagedAttachmentItem } from "./TaskAttachments";
import { agentNameForT3, type TaskCommentsT3Context } from "./t3-run-state";

export type { TaskCommentsT3Context };

const ICON_SIZE = 12;

let nextStagedCommentAttachmentSeq = 0;

function CommentItem({
  comment,
  storage,
  onDelete,
}: {
  readonly comment: Comment;
  readonly storage: StorageProvider;
  readonly onDelete: () => void;
}) {
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
      <Markdown content={comment.body} storage={storage} className="text-sm text-ink" />
    </li>
  );
}

function StagedCommentAttachmentList({
  items,
  disabled,
  onRemove,
  className = "",
}: {
  readonly items: readonly StagedAttachmentItem[];
  readonly disabled: boolean;
  readonly onRemove: (id: string) => void;
  readonly className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      data-testid="staged-comment-attachments"
      aria-label="Staged comment attachments"
      className={`m-0 flex list-none flex-wrap gap-2 p-0 ${className}`}
    >
      {items.map((item) => {
        const isImage = isImageAttachmentMimeType(item.mimeType);
        return (
          <li
            key={item.id}
            className="inline-flex max-w-full items-center gap-2 rounded-md border border-rule bg-paper-2 px-2 py-1.5 text-xs text-ink"
          >
            {isImage ? (
              <img
                src={`data:${item.mimeType};base64,${encodeBase64(item.data)}`}
                alt={item.name}
                className="size-9 shrink-0 rounded border border-rule object-cover"
              />
            ) : (
              <span className="grid size-7 shrink-0 place-items-center rounded border border-rule bg-paper text-ink-3">
                <FileIcon size={13} aria-hidden="true" />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate font-medium text-ink">{item.name}</span>
              <span className="block font-mono text-2xs text-ink-3">
                {formatByteSize(item.data.byteLength)}
              </span>
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                onRemove(item.id);
              }}
              aria-label={`Remove attachment ${item.name}`}
              title={`Remove ${item.name}`}
              className="ml-1 shrink-0 rounded p-0.5 text-ink-3 transition-colors hover:bg-paper hover:text-danger disabled:opacity-50"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function useStagedCommentAttachments(
  taskId: string,
  storage: StorageProvider | undefined,
  onError: (message: string | null) => void,
) {
  const [stagedAttachments, setStagedAttachments] = useState<StagedAttachmentItem[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isStaging, setIsStaging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function stageFiles(files: Iterable<File>) {
    const fileArray = Array.from(files);
    if (fileArray.length === 0) return;
    onError(null);
    setIsStaging(true);
    try {
      const additions: StagedAttachmentItem[] = [];
      for (const file of fileArray) {
        const input = await fileToAttachmentInput(file);
        const nameResult = AttachmentNameSchema.safeParse(input.name);
        if (!nameResult.success) {
          throw new Error(nameResult.error.issues[0]?.message ?? "Invalid attachment name");
        }
        if (input.data.byteLength === 0) {
          throw new Error(`Attachment "${input.name}" is empty`);
        }
        if (input.data.byteLength > ATTACHMENT_MAX_BYTES) {
          throw new Error(
            `Attachment "${input.name}" exceeds maximum size of ${formatByteSize(ATTACHMENT_MAX_BYTES)}`,
          );
        }
        additions.push({
          ...input,
          name: nameResult.data,
          id: `staged-comment-att-${String(++nextStagedCommentAttachmentSeq)}`,
          size: input.data.byteLength,
          createdAt: new Date().toISOString(),
        });
      }
      setStagedAttachments((prev) => [...prev, ...additions]);
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : "Failed to attach file");
    } finally {
      setIsStaging(false);
    }
  }

  function removeStagedAttachment(id: string) {
    setStagedAttachments((prev) => prev.filter((item) => item.id !== id));
  }

  function clearStagedAttachments() {
    setStagedAttachments([]);
  }

  async function uploadStagedAttachments(): Promise<
    readonly Pick<Attachment, "id" | "name" | "mimeType">[]
  > {
    if (stagedAttachments.length === 0) return [];
    const uploaded: Pick<Attachment, "id" | "name" | "mimeType">[] = [];
    for (const item of stagedAttachments) {
      if (storage) {
        const created = await storage.addAttachment(
          {
            taskId,
            name: item.name,
            mimeType: item.mimeType,
            data: item.data,
          },
          { actor: "you" },
        );
        dispatchRealtimeEvent({ type: "attachment.created", attachment: created });
        uploaded.push(created);
      } else {
        uploaded.push({
          id: item.id,
          name: item.name,
          mimeType: item.mimeType,
        });
      }
    }
    return uploaded;
  }

  return {
    stagedAttachments,
    isDragging,
    setIsDragging,
    isStaging,
    fileInputRef,
    stageFiles,
    removeStagedAttachment,
    clearStagedAttachments,
    uploadStagedAttachments,
  };
}

async function sendTaskT3Reply(
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
  readonly storage?: StorageProvider | undefined;
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
  storage,
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

  const {
    stagedAttachments,
    isDragging,
    setIsDragging,
    isStaging,
    fileInputRef,
    stageFiles,
    removeStagedAttachment,
    clearStagedAttachments,
    uploadStagedAttachments,
  } = useStagedCommentAttachments(taskId, storage, setSaveError);

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
  const canSubmit =
    (draft.trim() !== "" || stagedAttachments.length > 0) && !isSaving && !isStaging;

  async function submit() {
    if (!canSubmit) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const uploaded = await uploadStagedAttachments();
      const bodyToSend = appendAttachmentsToCommentBody(draft, uploaded);
      if (willReplyToAgent) {
        await sendTaskT3Reply(taskId, bodyToSend, {
          ...(switchSelection ? { selection: switchSelection } : {}),
          ...(startFreshSession ? { freshSession: true } : {}),
        });
        setModelSelection(null);
        setFreshSession(false);
        if (needsHuman) {
          onResolve?.();
        }
      } else {
        await addComment(bodyToSend);
      }
      setDraft("");
      clearStagedAttachments();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <form
      data-comment-composer="true"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => {
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (e.dataTransfer.files.length > 0) {
          void stageFiles(e.dataTransfer.files);
        }
      }}
      className={`overflow-hidden rounded-md border bg-paper transition-colors ${
        isDragging
          ? "border-accent bg-accent-soft/20"
          : willReplyToAgent
            ? "border-accent"
            : "border-rule"
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

      <input
        ref={fileInputRef}
        type="file"
        multiple
        aria-label="Attach files to comment"
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            void stageFiles(e.target.files);
            e.target.value = "";
          }
        }}
      />

      <label htmlFor={`composer-draft-${taskId}`} className="sr-only">
        Message
      </label>
      <textarea
        id={`composer-draft-${taskId}`}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
        }}
        onPaste={(e) => {
          const files = extractFilesFromClipboard(e.clipboardData);
          if (files.length === 0) return;
          e.preventDefault();
          e.stopPropagation();
          void stageFiles(files);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={2}
        placeholder={willReplyToAgent ? `Reply to ${resolvedAgentName}…` : "Add a comment…"}
        className="block w-full resize-none border-0 bg-transparent px-3 pt-2 pb-1 text-sm text-ink placeholder:text-ink-3 focus:outline-none"
      />

      <StagedCommentAttachmentList
        items={stagedAttachments}
        disabled={isSaving || isStaging}
        onRemove={removeStagedAttachment}
        className="px-3 pt-1 pb-1.5"
      />

      {saveError && (
        <p role="alert" className="m-0 px-3 py-1 text-xs text-danger">
          {saveError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 px-2.5 pt-1 pb-2">
        <button
          type="button"
          onClick={() => {
            onAttachClick?.();
            fileInputRef.current?.click();
          }}
          aria-label="Attach file"
          title="Attach file"
          disabled={isSaving || isStaging}
          className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-2xs text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50 focus-visible:outline-focus"
        >
          <Paperclip size={13} aria-hidden="true" />
        </button>

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
          disabled={!canSubmit}
          className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50 focus-visible:outline-focus"
        >
          {isSaving ? "Sending…" : "Send"}
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

  const {
    stagedAttachments,
    isDragging,
    setIsDragging,
    isStaging,
    fileInputRef,
    stageFiles,
    removeStagedAttachment,
    clearStagedAttachments,
    uploadStagedAttachments,
  } = useStagedCommentAttachments(taskId, storage, setSaveError);

  // Offline runs cannot be reached; without a model list there is nothing to pick.
  const hasReachableT3Run = t3 !== undefined && t3.run.state !== "offline";
  const showModelPicker = hasReachableT3Run && t3.capabilities.length > 0;
  const canSwitch = t3 !== undefined && canSwitchT3Model(t3.run.state);
  const switchSelection = showModelPicker && canSwitch ? modelSelection : null;
  const startFreshSession = hasReachableT3Run && canSwitch && freshSession;
  const canSubmit =
    (draft.trim() !== "" || stagedAttachments.length > 0) && !isSaving && !isStaging;

  async function submit(resolveNeedsHuman = false) {
    if (!canSubmit) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const uploaded = await uploadStagedAttachments();
      const bodyToSend = appendAttachmentsToCommentBody(draft, uploaded);
      if (switchSelection || startFreshSession) {
        await sendTaskT3Reply(taskId, bodyToSend, {
          ...(switchSelection ? { selection: switchSelection } : {}),
          ...(startFreshSession ? { freshSession: true } : {}),
        });
        setModelSelection(null);
        setFreshSession(false);
      } else {
        await addComment(bodyToSend);
      }
      setDraft("");
      clearStagedAttachments();
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
              storage={storage}
              onDelete={() => {
                void remove(comment.id);
              }}
            />
          ))}
        </ul>
      )}

      <form
        data-comment-composer="true"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => {
          setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          if (e.dataTransfer.files.length > 0) {
            void stageFiles(e.dataTransfer.files);
          }
        }}
        className={
          isDragging
            ? "rounded-md border border-dashed border-accent bg-accent-soft/20 p-1.5 transition-colors"
            : ""
        }
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          aria-label="Attach files to comment"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) {
              void stageFiles(e.target.files);
              e.target.value = "";
            }
          }}
        />
        <label htmlFor={`comment-draft-${taskId}`} className="sr-only">
          Add a comment
        </label>
        <textarea
          id={`comment-draft-${taskId}`}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onPaste={(e) => {
            const files = extractFilesFromClipboard(e.clipboardData);
            if (files.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            void stageFiles(files);
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

        <StagedCommentAttachmentList
          items={stagedAttachments}
          disabled={isSaving || isStaging}
          onRemove={removeStagedAttachment}
          className="mt-2"
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
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => {
              fileInputRef.current?.click();
            }}
            aria-label="Attach file"
            title="Attach file"
            disabled={isSaving || isStaging}
            className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50 focus-visible:outline-focus"
          >
            <Paperclip size={13} aria-hidden="true" />
            <span>Attach file</span>
          </button>
          <div className="flex items-center gap-2">
            {onResolve && (
              <button
                type="button"
                disabled={!canSubmit}
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
              disabled={!canSubmit}
              className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Comment"}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
