/**
 * Task mentions: `#BIT-12` in a description, subtask or comment names another task.
 * The `#` is required, so ordinary text such as `UTF-8` or `ISO-9001` is never a mention.
 * Code spans, fenced code blocks and URLs are skipped, since their text is literal.
 */
import { formatTaskCode, parseTaskCode } from "./ticket-codes";
import type { Task } from "./types";

/** Where one mention sits in the text: `start` is the `#`, `end` is exclusive. */
export interface MentionRange {
  readonly start: number;
  readonly end: number;
}

/** One distinct task code mentioned in a text, with every place it occurs. */
export interface TaskMention {
  /** The normalised code: `#BIT-012` gives `BIT-12`. */
  readonly code: string;
  readonly key: string;
  readonly number: number;
  readonly ranges: readonly MentionRange[];
}

/**
 * `#KEY-N`, with the key in capitals as stored. The `#` must not follow a letter, digit or
 * `_`/`&`/`/` (a URL fragment or HTML entity), and the number must not run into more word characters.
 */
const MENTION_PATTERN = /(?<![\w&/#])#([A-Z][A-Z0-9]{1,9}-\d+)(?![\w-]*\w)/g;
/** A URL with a scheme, or a `www.` host, up to whitespace or an angle bracket. */
const URL_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>]*/gi;
/** A Markdown link or image destination: the `(...)` after `]`. */
const LINK_DESTINATION_PATTERN = /\]\(([^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s[^)]*)?\)/g;
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const BACKTICK_RUN_PATTERN = /`+/g;

/** Ranges of fenced code blocks, fence lines included. An unclosed fence runs to the end. */
function fencedBlockRanges(text: string): MentionRange[] {
  const ranges: MentionRange[] = [];
  let offset = 0;
  let open: { readonly char: string; readonly length: number; readonly start: number } | undefined;
  for (const line of text.split("\n")) {
    const lineEnd = offset + line.length;
    if (open === undefined) {
      const fence = FENCE_OPEN_PATTERN.exec(line)?.[1];
      // A backtick fence's info string may not contain backticks.
      if (fence !== undefined && !(fence.startsWith("`") && line.slice(line.indexOf(fence) + fence.length).includes("`"))) {
        open = { char: fence.charAt(0), length: fence.length, start: offset };
      }
    } else {
      const close = new RegExp(`^ {0,3}(\\${open.char}{${String(open.length)},})[ \\t]*$`).exec(line);
      if (close !== null) {
        ranges.push({ start: open.start, end: lineEnd });
        open = undefined;
      }
    }
    offset = lineEnd + 1;
  }
  if (open !== undefined) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function inside(position: number, ranges: readonly MentionRange[]): boolean {
  return ranges.some((range) => position >= range.start && position < range.end);
}

/** Ranges of inline code spans outside `fences`: a backtick run closed by a run of the same length. */
function codeSpanRanges(text: string, fences: readonly MentionRange[]): MentionRange[] {
  const runs = [...text.matchAll(BACKTICK_RUN_PATTERN)]
    .filter((run) => !inside(run.index, fences))
    .map((run) => ({ start: run.index, length: run[0].length }));
  const ranges: MentionRange[] = [];
  for (let i = 0; i < runs.length; i++) {
    const opening = runs[i];
    if (opening === undefined) continue;
    const closing = runs.findIndex((run, j) => j > i && run.length === opening.length);
    const close = runs[closing];
    if (close === undefined) continue;
    ranges.push({ start: opening.start, end: close.start + close.length });
    i = closing;
  }
  return ranges;
}

/** Parts of `text` whose characters are literal: code and URLs. */
function literalRanges(text: string): MentionRange[] {
  const fences = fencedBlockRanges(text);
  const ranges = [...fences, ...codeSpanRanges(text, fences)];
  for (const url of text.matchAll(URL_PATTERN)) {
    ranges.push({ start: url.index, end: url.index + url[0].length });
  }
  for (const link of text.matchAll(LINK_DESTINATION_PATTERN)) {
    ranges.push({ start: link.index, end: link.index + link[0].length });
  }
  return ranges;
}

/**
 * The distinct task codes mentioned in `text`, in order of first appearance, each with the
 * ranges of all its occurrences. Zero padding is dropped, so `#BIT-1` and `#BIT-01` are one mention.
 */
export function extractTaskMentions(text: string): TaskMention[] {
  if (!text.includes("#")) return [];
  const literal = literalRanges(text);
  const byCode = new Map<string, { key: string; number: number; ranges: MentionRange[] }>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (match[1] === undefined || inside(match.index, literal)) continue;
    const parsed = parseTaskCode(match[1]);
    if (parsed === null) continue;
    const code = formatTaskCode(parsed.key, parsed.number);
    const range = { start: match.index, end: match.index + match[0].length };
    const existing = byCode.get(code);
    if (existing === undefined) byCode.set(code, { ...parsed, ranges: [range] });
    else existing.ranges.push(range);
  }
  return [...byCode].map(([code, mention]) => ({ code, ...mention }));
}

/**
 * The distinct codes a task mentions in its description and checklist items, in order of
 * first appearance, leaving out the task's own `code` (when it has one).
 */
export function taskMentions(task: Pick<Task, "description" | "checklist"> & { readonly code?: string }): string[] {
  const own = task.code === undefined ? undefined : parseTaskCode(task.code);
  const ownCode = own === undefined || own === null ? undefined : formatTaskCode(own.key, own.number);
  const texts = [task.description, ...(task.checklist ?? []).map((item) => item.text)];
  const codes = new Set<string>();
  for (const text of texts) {
    for (const mention of extractTaskMentions(text)) {
      if (mention.code !== ownCode) codes.add(mention.code);
    }
  }
  return [...codes];
}
