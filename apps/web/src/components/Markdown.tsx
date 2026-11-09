import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Download, File as FileIcon, FileText, Paperclip } from "lucide-react";
import {
  decodeUtf8,
  encodeBase64,
  extractTaskMentions,
  isImageAttachmentMimeType,
  isMarkdownAttachment,
  isTextAttachmentMimeType,
  type AttachmentContent,
  type StorageProvider,
  type TaskStatus,
} from "@bitig/core";
import { TaskMentionsContext, type MentionResolver } from "../domain/task-mentions";
import { Link } from "../routing/Link";
import { taskHref, useLocationHref } from "../routing/router";

const AttachmentStorageContext = createContext<StorageProvider | undefined>(undefined);

interface MarkdownProps {
  readonly content: string;
  readonly className?: string;
  readonly storage?: StorageProvider | undefined;
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,[a-zA-Z0-9+/=]+$/i;
const ATTACHMENT_URL_PATTERN = /^(?:https?:\/\/[^/\s]+)?\/api\/attachments\/([^/?#\s]+)$/;

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;

function formatByteSize(bytes: number): string {
  if (bytes < BYTES_PER_KB) return `${String(bytes)} B`;
  if (bytes < BYTES_PER_MB) return `${(bytes / BYTES_PER_KB).toFixed(1)} KB`;
  return `${(bytes / BYTES_PER_MB).toFixed(1)} MB`;
}

function extractAttachmentIdFromUrl(rawUrl: string): string | null {
  const match = ATTACHMENT_URL_PATTERN.exec(rawUrl.trim());
  return match?.[1] ?? null;
}

function isSafeHref(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (extractAttachmentIdFromUrl(trimmed) !== null) return true;
  try {
    const parsed = new URL(trimmed);
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function isSafeImageSrc(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (SAFE_DATA_IMAGE_PATTERN.test(trimmed)) return true;
  if (extractAttachmentIdFromUrl(trimmed) !== null) return true;
  try {
    const parsed = new URL(trimmed);
    return SAFE_IMAGE_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

function unescapeMarkdownLabel(raw: string): string {
  return raw.replace(/\\([\\[\]])/g, "$1");
}

function downloadAttachmentContent(loaded: AttachmentContent): void {
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
}

function InlineAttachmentPreview({
  attachmentId,
  label,
  isImageSyntax,
}: {
  readonly attachmentId: string;
  readonly label: string;
  readonly isImageSyntax: boolean;
}) {
  const storage = useContext(AttachmentStorageContext);
  const [loadedState, setLoadedState] = useState<{
    readonly attachmentId: string;
    readonly content: AttachmentContent | null;
  } | null>(null);

  useEffect(() => {
    if (!storage) return;
    const controller = new AbortController();
    storage
      .getAttachment(attachmentId, { signal: controller.signal })
      .then((loaded) => {
        if (!controller.signal.aborted) {
          setLoadedState({ attachmentId, content: loaded });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadedState({ attachmentId, content: null });
        }
      });
    return () => {
      controller.abort();
    };
  }, [attachmentId, storage]);

  const content = loadedState?.attachmentId === attachmentId ? loadedState.content : null;
  const isLoading = storage !== undefined && loadedState?.attachmentId !== attachmentId;

  if (content) {
    if (isImageAttachmentMimeType(content.mimeType)) {
      return (
        <span className="my-1 inline-flex flex-col gap-1">
          <img
            src={`data:${content.mimeType};base64,${encodeBase64(content.data)}`}
            alt={label || content.name}
            className="max-h-72 max-w-full rounded border border-rule object-contain"
          />
        </span>
      );
    }

    const isText = isTextAttachmentMimeType(content.mimeType) || isMarkdownAttachment(content);
    const TypeIcon = isText ? FileText : FileIcon;

    return (
      <span
        data-testid={`comment-attachment-${content.id}`}
        className="my-1 inline-flex flex-col gap-1.5 rounded-md border border-rule bg-paper p-2 text-xs text-ink"
      >
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <TypeIcon size={12} aria-hidden="true" className="shrink-0 text-ink-3" />
          <a
            href={`/api/attachments/${content.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-accent-ink underline hover:opacity-80 focus-visible:outline-focus"
          >
            {content.name}
          </a>
          <span className="font-mono text-2xs text-ink-3">({formatByteSize(content.size)})</span>
          <button
            type="button"
            onClick={() => {
              downloadAttachmentContent(content);
            }}
            aria-label={`Download ${content.name}`}
            title={`Download ${content.name}`}
            className="ml-auto inline-flex items-center gap-1 text-ink-3 transition-colors hover:text-ink"
          >
            <Download size={12} aria-hidden="true" />
          </button>
        </span>
        {isText && (
          <code className="block max-h-40 overflow-auto rounded border border-rule bg-paper-2 p-1.5 font-mono text-2xs text-ink whitespace-pre-wrap">
            {decodeUtf8(content.data)}
          </code>
        )}
      </span>
    );
  }

  if (isLoading) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-rule bg-paper px-2 py-0.5 text-xs text-ink-3">
        <Paperclip size={12} aria-hidden="true" />
        <span>{label || attachmentId}</span>
      </span>
    );
  }

  if (isImageSyntax) {
    return (
      <img
        src={`/api/attachments/${attachmentId}`}
        alt={label || "Attachment"}
        className="my-1 max-h-72 max-w-full rounded border border-rule object-contain"
      />
    );
  }

  return (
    <a
      href={`/api/attachments/${attachmentId}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 rounded border border-rule bg-paper px-2 py-0.5 text-xs font-medium text-accent-ink underline hover:opacity-80 focus-visible:outline-focus"
    >
      <Paperclip size={12} aria-hidden="true" />
      <span>{label || attachmentId}</span>
    </a>
  );
}

const MENTION_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

/** Plain text with each known `#BIT-64` mention turned into an in-app link to that task. */
function renderText(
  text: string,
  keyPrefix: string,
  resolve: MentionResolver | undefined,
  locationHref: string,
): ReactNode[] {
  if (resolve === undefined) return [text];
  const occurrences = extractTaskMentions(text)
    .flatMap((mention) => {
      const target = resolve(mention.code);
      return target === undefined ? [] : mention.ranges.map((range) => ({ range, target }));
    })
    .sort((a, b) => a.range.start - b.range.start);
  if (occurrences.length === 0) return [text];

  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  for (const [index, { range, target }] of occurrences.entries()) {
    if (range.start > lastIndex) nodes.push(text.slice(lastIndex, range.start));
    const closed = target.status === "done" || target.status === "archived";
    nodes.push(
      <Link
        key={`${keyPrefix}-m${String(index)}`}
        href={taskHref(target.code, locationHref)}
        title={`${target.title} (${MENTION_STATUS_LABELS[target.status]})`}
        className={`font-mono font-semibold text-accent-ink underline decoration-dotted hover:opacity-80 focus-visible:outline-focus ${
          closed ? "line-through opacity-70" : ""
        }`}
      >
        {text.slice(range.start, range.end)}
      </Link>,
    );
    lastIndex = range.end;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const INLINE_TOKEN_PATTERN =
  /(`[^`\n]+`)|(!\[((?:\\.|[^\]])*)\]\(([^)\s]+)\))|(\[((?:\\.|[^\]])+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)/g;

/** `resolve` turns task mentions into links; it is left out inside links, which can't nest. */
function renderInline(
  text: string,
  keyPrefix: string,
  locationHref: string,
  resolve?: MentionResolver,
): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      nodes.push(
        ...renderText(
          text.slice(lastIndex, matchIndex),
          `${keyPrefix}-t${String(tokenIndex)}`,
          resolve,
          locationHref,
        ),
      );
    }

    const [
      full,
      codeSpan,
      ,
      imageAlt,
      imageUrl,
      ,
      linkLabel,
      linkUrl,
      ,
      boldText,
      ,
      italicText,
    ] = match;
    const key = `${keyPrefix}-${String(tokenIndex++)}`;

    if (codeSpan !== undefined) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-paper-2 px-1 py-0.5 font-mono text-xs text-ink"
        >
          {codeSpan.slice(1, -1)}
        </code>,
      );
    } else if (imageAlt !== undefined && imageUrl !== undefined) {
      const cleanAlt = unescapeMarkdownLabel(imageAlt);
      const attachmentId = extractAttachmentIdFromUrl(imageUrl);
      if (attachmentId !== null) {
        nodes.push(
          <InlineAttachmentPreview
            key={key}
            attachmentId={attachmentId}
            label={cleanAlt}
            isImageSyntax
          />,
        );
      } else if (isSafeImageSrc(imageUrl)) {
        nodes.push(
          <img
            key={key}
            src={imageUrl.trim()}
            alt={cleanAlt}
            className="my-1 max-h-72 max-w-full rounded border border-rule object-contain"
          />,
        );
      } else {
        nodes.push(full);
      }
    } else if (linkLabel !== undefined && linkUrl !== undefined) {
      const cleanLabel = unescapeMarkdownLabel(linkLabel);
      const attachmentId = extractAttachmentIdFromUrl(linkUrl);
      if (attachmentId !== null) {
        nodes.push(
          <InlineAttachmentPreview
            key={key}
            attachmentId={attachmentId}
            label={cleanLabel}
            isImageSyntax={false}
          />,
        );
      } else if (isSafeHref(linkUrl)) {
        nodes.push(
          <a
            key={key}
            href={linkUrl.trim()}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent-ink underline hover:opacity-80 focus-visible:outline-focus"
          >
            {renderInline(cleanLabel, `${key}-l`, locationHref)}
          </a>,
        );
      } else {
        nodes.push(full);
      }
    } else if (boldText !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-ink">
          {renderInline(boldText, `${key}-b`, locationHref, resolve)}
        </strong>,
      );
    } else if (italicText !== undefined) {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(italicText, `${key}-i`, locationHref, resolve)}
        </em>,
      );
    }

    lastIndex = matchIndex + full.length;
  }

  if (lastIndex < text.length) {
    nodes.push(
      ...renderText(text.slice(lastIndex), `${keyPrefix}-t${String(tokenIndex)}`, resolve, locationHref),
    );
  }

  return nodes;
}

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;
const UNORDERED_ITEM_PATTERN = /^\s*[-*]\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\s*\d+\.\s+(.*)$/;
const BLOCKQUOTE_PATTERN = /^>\s?(.*)$/;

const HEADING_CLASSES: Record<number, string> = {
  1: "m-0 font-display text-base font-bold text-ink",
  2: "m-0 font-display text-sm font-bold text-ink",
  3: "m-0 font-display text-sm font-semibold text-ink",
  4: "m-0 font-display text-xs font-semibold text-ink",
  5: "m-0 font-display text-xs font-semibold text-ink-2",
  6: "m-0 font-display text-xs font-medium text-ink-2",
};

/**
 * Safe, zero-dependency Markdown renderer. Emits React elements directly and
 * never touches innerHTML, while restricting links to http(s) and mailto.
 */
export function Markdown({ content, className = "text-sm text-ink-2", storage }: MarkdownProps) {
  const resolve = useContext(TaskMentionsContext);
  const contextStorage = useContext(AttachmentStorageContext);
  const effectiveStorage = storage ?? contextStorage;
  const locationHref = useLocationHref();
  const lines = content.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let i = 0;
  let blockKey = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        codeLines.push(lines[i] ?? "");
        i++;
      }
      if (i < lines.length) i++;
      const key = `code-${String(blockKey++)}`;
      blocks.push(
        <pre
          key={key}
          className="m-0 overflow-x-auto rounded-md border border-rule bg-paper-2 p-2.5 font-mono text-xs text-ink"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    const headingMatch = HEADING_PATTERN.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]?.length ?? 1;
      const text = headingMatch[2] ?? "";
      const key = `h-${String(blockKey++)}`;
      const headingClass = HEADING_CLASSES[level] ?? HEADING_CLASSES[3];
      blocks.push(
        <p key={key} role="heading" aria-level={level} className={headingClass}>
          {renderInline(text, key, locationHref, resolve)}
        </p>,
      );
      i++;
      continue;
    }

    // Blockquote
    if (BLOCKQUOTE_PATTERN.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length) {
        const match = BLOCKQUOTE_PATTERN.exec(lines[i] ?? "");
        if (!match) break;
        quoteLines.push(match[1] ?? "");
        i++;
      }
      const key = `quote-${String(blockKey++)}`;
      blocks.push(
        <blockquote
          key={key}
          className="m-0 border-l-2 border-rule-strong pl-3 italic text-ink-2 whitespace-pre-wrap"
        >
          {renderInline(quoteLines.join("\n"), key, locationHref, resolve)}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (UNORDERED_ITEM_PATTERN.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const match = UNORDERED_ITEM_PATTERN.exec(lines[i] ?? "");
        if (!match) break;
        items.push(match[1] ?? "");
        i++;
      }
      const key = `ul-${String(blockKey++)}`;
      blocks.push(
        <ul key={key} className="m-0 list-disc space-y-1 pl-5">
          {items.map((item, idx) => (
            <li key={`${key}-${String(idx)}`}>{renderInline(item, `${key}-${String(idx)}`, locationHref, resolve)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (ORDERED_ITEM_PATTERN.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const match = ORDERED_ITEM_PATTERN.exec(lines[i] ?? "");
        if (!match) break;
        items.push(match[1] ?? "");
        i++;
      }
      const key = `ol-${String(blockKey++)}`;
      blocks.push(
        <ol key={key} className="m-0 list-decimal space-y-1 pl-5">
          {items.map((item, idx) => (
            <li key={`${key}-${String(idx)}`}>{renderInline(item, `${key}-${String(idx)}`, locationHref, resolve)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: collect consecutive regular lines
    const paraLines: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? "";
      if (
        current.trim() === "" ||
        current.trimStart().startsWith("```") ||
        HEADING_PATTERN.test(current) ||
        BLOCKQUOTE_PATTERN.test(current) ||
        UNORDERED_ITEM_PATTERN.test(current) ||
        ORDERED_ITEM_PATTERN.test(current)
      ) {
        break;
      }
      paraLines.push(current);
      i++;
    }
    const key = `p-${String(blockKey++)}`;
    blocks.push(
      <p key={key} className="m-0 whitespace-pre-wrap">
        {renderInline(paraLines.join("\n"), key, locationHref, resolve)}
      </p>,
    );
  }

  const rendered = <div className={`flex flex-col gap-2 ${className}`}>{blocks}</div>;
  return effectiveStorage ? (
    <AttachmentStorageContext.Provider value={effectiveStorage}>
      {rendered}
    </AttachmentStorageContext.Provider>
  ) : (
    rendered
  );
}


/** One line of inline Markdown (code, links, emphasis, task mentions) without block structure. */
export function InlineMarkdown({ text }: { readonly text: string }) {
  const resolve = useContext(TaskMentionsContext);
  const locationHref = useLocationHref();
  return <>{renderInline(text, "inline", locationHref, resolve)}</>;
}

