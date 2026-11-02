import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Paperclip,
  Trash2,
  Upload,
} from "lucide-react";
import {
  ATTACHMENT_MAX_BYTES,
  AttachmentNameSchema,
  assertTaskAttachmentQuota,
  decodeUtf8,
  encodeBase64,
  inferAttachmentMimeType,
  isImageAttachmentMimeType,
  isMarkdownAttachment,
  isTextAttachmentMimeType,
  normalizeAttachmentMimeType,
  type Attachment,
  type AttachmentContent,
  type AttachmentMimeType,
  type OperationOptions,
  type StorageProvider,
} from "@bitig/core";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { useAttachments, type AddAttachmentFileInput } from "../../hooks/useAttachments";
import { Markdown } from "../Markdown";

const ICON_SIZE = 12;
const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

function formatByteSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${String(bytes)} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function isPreviewable(attachment: Attachment): boolean {
  return (
    isMarkdownAttachment(attachment) ||
    isTextAttachmentMimeType(attachment.mimeType) ||
    isImageAttachmentMimeType(attachment.mimeType)
  );
}

/**
 * Reads a browser `File` into an attachment payload, normalizing its MIME type or falling back
 * to extension inference when the OS/browser reports a non-standard type (e.g. `video/mp2t` for `.ts`).
 */
async function fileToAttachmentInput(file: File): Promise<{
  readonly name: string;
  readonly mimeType: AttachmentMimeType;
  readonly data: Uint8Array;
}> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fallbackExt = file.type.startsWith("image/")
    ? `.${file.type.slice("image/".length).split(";")[0] ?? "png"}`
    : "";
  const name =
    file.name && file.name.trim().length > 0
      ? file.name.trim()
      : `pasted-${String(Date.now())}${fallbackExt}`;
  let mimeType: AttachmentMimeType;
  if (file.type) {
    try {
      mimeType = normalizeAttachmentMimeType(file.type, name);
    } catch {
      mimeType = inferAttachmentMimeType(name);
    }
  } else {
    mimeType = inferAttachmentMimeType(name);
  }
  return { name, mimeType, data: bytes };
}

interface AttachmentItemProps {
  readonly attachment: Attachment;
  readonly loadContent: (id: string, opts?: OperationOptions) => Promise<AttachmentContent | null>;
  readonly onDelete: () => void;
}

function AttachmentItem({ attachment, loadContent, onDelete }: AttachmentItemProps) {
  const canPreview = isPreviewable(attachment);
  const [expanded, setExpanded] = useState(canPreview);
  const [content, setContent] = useState<AttachmentContent | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const loadingPreview = canPreview && expanded && content === null && previewError === null;

  useEffect(() => {
    if (!canPreview || !expanded || content !== null) return;
    const controller = new AbortController();
    loadContent(attachment.id, { signal: controller.signal })
      .then((loaded) => {
        if (controller.signal.aborted) return;
        setContent(loaded);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setPreviewError(err instanceof Error ? err.message : "Failed to load preview");
      });
    return () => {
      controller.abort();
    };
  }, [attachment.id, canPreview, content, expanded, loadContent]);

  async function handleDownload() {
    try {
      const loaded = content ?? (await loadContent(attachment.id));
      if (!loaded) return;
      const copy = new Uint8Array(loaded.data.byteLength);
      copy.set(loaded.data);
      const blob = new Blob([copy.buffer], { type: loaded.mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = loaded.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      setPreviewError(err instanceof Error ? err.message : "Failed to download attachment");
    }
  }

  const isImage = isImageAttachmentMimeType(attachment.mimeType);
  const isMarkdown = isMarkdownAttachment(attachment);
  const isText = isTextAttachmentMimeType(attachment.mimeType);
  const TypeIcon = isImage ? ImageIcon : isMarkdown || isText ? FileText : FileIcon;

  return (
    <li className="rounded-md border border-rule bg-paper-2 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
        {canPreview ? (
          <button
            type="button"
            onClick={() => {
              setExpanded((prev) => !prev);
            }}
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} preview for ${attachment.name}`}
            className="inline-flex items-center gap-1 font-semibold text-ink-2 transition-colors hover:text-ink"
          >
            {expanded ? (
              <ChevronDown size={ICON_SIZE} aria-hidden="true" />
            ) : (
              <ChevronRight size={ICON_SIZE} aria-hidden="true" />
            )}
            <TypeIcon size={ICON_SIZE} aria-hidden="true" />
            <span>{attachment.name}</span>
          </button>
        ) : (
          <span className="inline-flex items-center gap-1 font-semibold text-ink-2">
            <TypeIcon size={ICON_SIZE} aria-hidden="true" />
            <span>{attachment.name}</span>
          </span>
        )}
        <span className="font-mono">({formatByteSize(attachment.size)})</span>
        {attachment.createdBy && (
          <span className="inline-flex items-center gap-0.5">
            <Bot size={11} aria-hidden="true" />
            <span>{attachment.createdBy}</span>
          </span>
        )}
        <time dateTime={attachment.createdAt} title={formatFullTimestamp(attachment.createdAt)}>
          {formatTimeAgo(attachment.createdAt)}
        </time>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void handleDownload();
            }}
            aria-label={`Download ${attachment.name}`}
            title={`Download ${attachment.name}`}
            className="text-ink-3 transition-colors hover:text-ink"
          >
            <Download size={ICON_SIZE} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label={`Delete attachment ${attachment.name}`}
            title={`Delete ${attachment.name}`}
            className="text-ink-3 transition-colors hover:text-danger"
          >
            <Trash2 size={ICON_SIZE} aria-hidden="true" />
          </button>
        </div>
      </div>

      {canPreview && expanded && (
        <div className="mt-2 border-t border-rule pt-2">
          {loadingPreview && <p className="m-0 text-xs text-ink-3">Loading preview\u2026</p>}
          {previewError && (
            <p role="alert" className="m-0 text-xs text-danger">
              {previewError}
            </p>
          )}
          {content && isImage && (
            <img
              src={`data:${content.mimeType};base64,${encodeBase64(content.data)}`}
              alt={attachment.name}
              className="max-h-72 max-w-full rounded border border-rule object-contain"
            />
          )}
          {content && isMarkdown && (
            <Markdown content={decodeUtf8(content.data)} className="text-sm text-ink" />
          )}
          {content && !isMarkdown && isText && (
            <pre className="m-0 max-h-60 overflow-auto rounded border border-rule bg-paper p-2 font-mono text-xs text-ink">
              {decodeUtf8(content.data)}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

interface TaskAttachmentsProps {
  readonly storage: StorageProvider;
  readonly taskId: string;
}

/** A task's file attachments, with upload (picker, drag-and-drop, paste), inline preview, and delete. */
export function TaskAttachments({ storage, taskId }: TaskAttachmentsProps) {
  const {
    attachments,
    isLoading,
    unsupported,
    error,
    addAttachment,
    deleteAttachment,
    getAttachment,
  } = useAttachments(storage, taskId);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFiles = useCallback(
    async (files: Iterable<File>) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      setIsUploading(true);
      setActionError(null);
      try {
        for (const file of list) {
          const payload = await fileToAttachmentInput(file);
          await addAttachment(payload);
        }
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Failed to upload attachment");
      } finally {
        setIsUploading(false);
      }
    },
    [addAttachment],
  );

  useEffect(() => {
    if (unsupported) return;
    function handlePaste(e: ClipboardEvent) {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      void uploadFiles(files);
    }
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, [unsupported, uploadFiles]);

  if (unsupported) {
    return null;
  }

  async function remove(id: string) {
    setActionError(null);
    try {
      await deleteAttachment(id);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : "Failed to delete attachment");
    }
  }

  return (
    <section
      aria-labelledby="task-detail-attachments"
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
          void uploadFiles(e.dataTransfer.files);
        }
      }}
      className={`mb-5 rounded-md transition-colors ${
        isDragging ? "border border-dashed border-accent bg-accent-soft/20 p-2" : ""
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3
          id="task-detail-attachments"
          className="m-0 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3"
        >
          <Paperclip size={ICON_SIZE} aria-hidden="true" />
          Attachments{attachments.length > 0 ? ` (${String(attachments.length)})` : ""}
        </h3>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            aria-label="Attach files"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                const selected = Array.from(e.target.files);
                e.target.value = "";
                void uploadFiles(selected);
              }
            }}
            className="sr-only"
          />
          <button
            type="button"
            disabled={isUploading}
            onClick={() => {
              fileInputRef.current?.click();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-rule px-2.5 py-1 text-2xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
          >
            <Upload size={ICON_SIZE} aria-hidden="true" />
            {isUploading ? "Uploading\u2026" : "Attach file"}
          </button>
        </div>
      </div>

      {isLoading && <p className="m-0 mb-2 text-sm text-ink-3">Loading attachments\u2026</p>}
      {error && (
        <p role="alert" className="m-0 mb-2 text-sm text-danger">
          {error}
        </p>
      )}
      {actionError && (
        <p role="alert" className="m-0 mb-2 text-xs text-danger">
          {actionError}
        </p>
      )}
      {!isLoading && !error && attachments.length === 0 && (
        <p className="m-0 mb-2 text-xs text-ink-3">
          No attachments yet. Drop files here, paste an image, or click Attach file.
        </p>
      )}
      {attachments.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {attachments.map((attachment) => (
            <AttachmentItem
              key={attachment.id}
              attachment={attachment}
              loadContent={getAttachment}
              onDelete={() => {
                void remove(attachment.id);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export interface StagedAttachmentItem extends AddAttachmentFileInput {
  readonly id: string;
  readonly name: string;
  readonly mimeType: AttachmentMimeType;
  readonly size: number;
  readonly createdAt: string;
  readonly data: Uint8Array;
}

interface StagedTaskAttachmentsProps {
  readonly items: readonly StagedAttachmentItem[];
  readonly onChange: (items: StagedAttachmentItem[]) => void;
  readonly disabled?: boolean | undefined;
}

/**
 * Stages file attachments on a task form before the task exists in storage (e.g. in `TaskModal`
 * when creating a new task). Supports file picker, drag-and-drop, clipboard paste, inline preview,
 * and removal.
 */
export function StagedTaskAttachments({ items, onChange, disabled = false }: StagedTaskAttachmentsProps) {
  const [isReading, setIsReading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const nextIdRef = useRef(0);

  const stageFiles = useCallback(
    async (files: Iterable<File>) => {
      const list = Array.from(files);
      if (list.length === 0 || disabled) return;
      setIsReading(true);
      setActionError(null);
      try {
        const next = [...items];
        for (const file of list) {
          const payload = await fileToAttachmentInput(file);
          const parsedName = AttachmentNameSchema.safeParse(payload.name);
          if (!parsedName.success) {
            throw new Error(parsedName.error.issues[0]?.message ?? "Invalid attachment name");
          }
          if (payload.data.byteLength === 0) {
            throw new Error("Attachment must not be empty");
          }
          if (payload.data.byteLength > ATTACHMENT_MAX_BYTES) {
            throw new Error(`Attachment exceeds maximum size of ${String(ATTACHMENT_MAX_BYTES)} bytes`);
          }
          assertTaskAttachmentQuota(next, payload.data.byteLength, "addAttachment");
          const seq = ++nextIdRef.current;
          next.push({
            id: `staged-${String(Date.now())}-${String(seq)}`,
            name: parsedName.data,
            mimeType: payload.mimeType,
            size: payload.data.byteLength,
            createdAt: new Date().toISOString(),
            data: payload.data,
          });
        }
        onChange(next);
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Failed to stage attachment");
      } finally {
        setIsReading(false);
      }
    },
    [disabled, items, onChange],
  );

  useEffect(() => {
    if (disabled) return;
    function handlePaste(e: ClipboardEvent) {
      const files = e.clipboardData?.files;
      if (!files || files.length === 0) return;
      e.preventDefault();
      void stageFiles(files);
    }
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, [disabled, stageFiles]);

  return (
    <section
      aria-labelledby="task-modal-attachments"
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragging(true);
      }}
      onDragLeave={() => {
        setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (!disabled && e.dataTransfer.files.length > 0) {
          void stageFiles(e.dataTransfer.files);
        }
      }}
      className={`rounded-md transition-colors ${
        isDragging ? "border border-dashed border-accent bg-accent-soft/20 p-2" : ""
      }`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3
          id="task-modal-attachments"
          className="m-0 flex items-center gap-1 text-xs font-semibold text-ink-2"
        >
          <Paperclip size={ICON_SIZE} aria-hidden="true" />
          Attachments{items.length > 0 ? ` (${String(items.length)})` : ""}
        </h3>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            disabled={disabled || isReading}
            aria-label="Attach files"
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) {
                const selected = Array.from(e.target.files);
                e.target.value = "";
                void stageFiles(selected);
              }
            }}
            className="sr-only"
          />
          <button
            type="button"
            disabled={disabled || isReading}
            onClick={() => {
              fileInputRef.current?.click();
            }}
            className="inline-flex items-center gap-1 rounded-md border border-rule px-2.5 py-1 text-2xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
          >
            <Upload size={ICON_SIZE} aria-hidden="true" />
            {isReading ? "Attaching\u2026" : "Attach file"}
          </button>
        </div>
      </div>

      {actionError && (
        <p role="alert" className="m-0 mb-2 text-xs text-danger">
          {actionError}
        </p>
      )}
      {items.length === 0 && (
        <p className="m-0 text-xs text-ink-3">
          No attachments yet. Drop files here, paste an image, or click Attach file.
        </p>
      )}
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item) => (
            <AttachmentItem
              key={item.id}
              attachment={{
                id: item.id,
                taskId: "staged",
                name: item.name,
                mimeType: item.mimeType,
                size: item.size,
                createdAt: item.createdAt,
              }}
              loadContent={() =>
                Promise.resolve({
                  id: item.id,
                  taskId: "staged",
                  name: item.name,
                  mimeType: item.mimeType,
                  size: item.size,
                  createdAt: item.createdAt,
                  data: item.data,
                })
              }
              onDelete={() => {
                setActionError(null);
                onChange(items.filter((entry) => entry.id !== item.id));
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

