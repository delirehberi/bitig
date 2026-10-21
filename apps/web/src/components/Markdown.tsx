import { useContext, type ReactNode } from "react";
import { extractTaskMentions, type TaskStatus } from "@bitig/core";
import { TaskMentionsContext, type MentionResolver } from "../domain/task-mentions";
import { Link } from "../routing/Link";
import { hrefFor } from "../routing/router";

interface MarkdownProps {
  readonly content: string;
  readonly className?: string;
}

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function isSafeHref(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl.trim());
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

const MENTION_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  archived: "Archived",
};

/** Plain text with each known `#BIT-64` mention turned into an in-app link to that task. */
function renderText(text: string, keyPrefix: string, resolve: MentionResolver | undefined): ReactNode[] {
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
        href={hrefFor({ name: "tasks", taskRef: target.code })}
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
  /(`[^`\n]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)/g;

/** `resolve` turns task mentions into links; it is left out inside links, which can't nest. */
function renderInline(text: string, keyPrefix: string, resolve?: MentionResolver): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      nodes.push(...renderText(text.slice(lastIndex, matchIndex), `${keyPrefix}-t${String(tokenIndex)}`, resolve));
    }

    const [full, codeSpan, , linkLabel, linkUrl, , boldText, , italicText] = match;
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
    } else if (linkLabel !== undefined && linkUrl !== undefined) {
      if (isSafeHref(linkUrl)) {
        nodes.push(
          <a
            key={key}
            href={linkUrl.trim()}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-accent-ink underline hover:opacity-80 focus-visible:outline-focus"
          >
            {renderInline(linkLabel, `${key}-l`)}
          </a>,
        );
      } else {
        nodes.push(full);
      }
    } else if (boldText !== undefined) {
      nodes.push(
        <strong key={key} className="font-semibold text-ink">
          {renderInline(boldText, `${key}-b`, resolve)}
        </strong>,
      );
    } else if (italicText !== undefined) {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(italicText, `${key}-i`, resolve)}
        </em>,
      );
    }

    lastIndex = matchIndex + full.length;
  }

  if (lastIndex < text.length) {
    nodes.push(...renderText(text.slice(lastIndex), `${keyPrefix}-t${String(tokenIndex)}`, resolve));
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
export function Markdown({ content, className = "text-sm text-ink-2" }: MarkdownProps) {
  const resolve = useContext(TaskMentionsContext);
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
          {renderInline(text, key, resolve)}
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
          {renderInline(quoteLines.join("\n"), key, resolve)}
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
            <li key={`${key}-${String(idx)}`}>{renderInline(item, `${key}-${String(idx)}`, resolve)}</li>
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
            <li key={`${key}-${String(idx)}`}>{renderInline(item, `${key}-${String(idx)}`, resolve)}</li>
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
        {renderInline(paraLines.join("\n"), key, resolve)}
      </p>,
    );
  }

  return <div className={`flex flex-col gap-2 ${className}`}>{blocks}</div>;
}


/** One line of inline Markdown (code, links, emphasis, task mentions) without block structure. */
export function InlineMarkdown({ text }: { readonly text: string }) {
  const resolve = useContext(TaskMentionsContext);
  return <>{renderInline(text, "inline", resolve)}</>;
}
