import type { ReactNode } from "react";

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

const INLINE_TOKEN_PATTERN =
  /(`[^`\n]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let lastIndex = 0;
  let tokenIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN_PATTERN)) {
    const matchIndex = match.index;
    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
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
          {renderInline(boldText, `${key}-b`)}
        </strong>,
      );
    } else if (italicText !== undefined) {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(italicText, `${key}-i`)}
        </em>,
      );
    }

    lastIndex = matchIndex + full.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
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
          {renderInline(text, key)}
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
          {renderInline(quoteLines.join("\n"), key)}
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
            <li key={`${key}-${String(idx)}`}>{renderInline(item, `${key}-${String(idx)}`)}</li>
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
            <li key={`${key}-${String(idx)}`}>{renderInline(item, `${key}-${String(idx)}`)}</li>
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
        {renderInline(paraLines.join("\n"), key)}
      </p>,
    );
  }

  return <div className={`flex flex-col gap-2 ${className}`}>{blocks}</div>;
}

