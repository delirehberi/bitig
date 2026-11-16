/**
 * Free-text parser for the work queue prompt.
 *
 * Pure and environment-neutral: no model call and no I/O. It reads Bitig ticket
 * codes (`BIT-92`, `bit 92`, `#BIT-92`), ranges (`BIT-92 to 102`, `BIT-92..102`,
 * `BIT-92-102`, `BIT-92 through 102`) and exclusions (`except BIT-95`,
 * `but not BIT-95`) from a prompt.
 *
 * Codes are only ever emitted for project keys the caller knows. Unknown keys
 * are reported with suggestions and never substituted. Meaningful words that
 * were not understood are returned in `unparsed`, so the caller can decide
 * whether the model fallback is needed.
 */

export const MAX_WORK_QUEUE_ITEMS = 50;

const MIN_ITEM_NUMBER = 1;
const MAX_REFERENCE_DIGITS = 9;
const SUGGESTION_LIMIT = 3;
const SUGGESTION_MAX_DISTANCE = 2;
const SUGGESTION_SCORE_NAME = 0;
const SUGGESTION_SCORE_KEY_PREFIX = 1;
const SUGGESTION_SCORE_NEAR_BASE = 2;

/** Mirrors PROJECT_KEY_PATTERN: 2-10 characters, starting with a letter. */
const KEY_SOURCE = String.raw`[A-Za-z][A-Za-z0-9]{1,9}`;
/** Hyphen or whitespace between a key and its number. A hyphen marks a strict code. */
const SEPARATOR_SOURCE = String.raw`(?:\s*-\s*|\s+)`;
const NUMBER_SOURCE = String.raw`\d{1,${MAX_REFERENCE_DIGITS}}\b`;
const RANGE_SEPARATOR_SOURCE = String.raw`(?:\s*(?:\.\.|-)\s*|\s+(?:to|through|thru|till|until)\s+)`;

const RANGE_SOURCE = String.raw`#?(?<aKey>${KEY_SOURCE})(?<aSep>${SEPARATOR_SOURCE})(?<aNum>${NUMBER_SOURCE})${RANGE_SEPARATOR_SOURCE}(?:#?(?<bKey>${KEY_SOURCE})(?<bSep>${SEPARATOR_SOURCE}))?(?<bNum>${NUMBER_SOURCE})`;
const REF_SOURCE = String.raw`#?(?<rKey>${KEY_SOURCE})(?<rSep>${SEPARATOR_SOURCE})(?<rNum>${NUMBER_SOURCE})`;
const EXCLUDE_SOURCE = String.raw`(?<exclude>\bbut\s+not\b|\bother\s+than\b|\bexcept\b|\bexcluding\b|\bwithout\b|\bminus\b)`;
const RESET_SOURCE = String.raw`(?<reset>[\n;]|\.(?!\.))`;
const WORD_SOURCE = String.raw`(?<word>[A-Za-z]+)`;

const TOKEN_PATTERN = new RegExp([RANGE_SOURCE, REF_SOURCE, EXCLUDE_SOURCE, RESET_SOURCE, WORD_SOURCE].join("|"), "gi");

/**
 * Words that carry no meaning for the queue. Anything else left over ends up in
 * `unparsed`. Connectors such as `and` and `&` are neutral and do not end an
 * exclusion list.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "add",
  "all",
  "also",
  "an",
  "and",
  "both",
  "but",
  "do",
  "for",
  "from",
  "go",
  "in",
  "into",
  "it",
  "item",
  "items",
  "its",
  "next",
  "not",
  "of",
  "on",
  "or",
  "please",
  "plus",
  "queue",
  "run",
  "start",
  "task",
  "tasks",
  "the",
  "then",
  "them",
  "these",
  "those",
  "ticket",
  "tickets",
  "to",
  "with",
  "work",
]);

export interface WorkQueueProjectRef {
  readonly key: string;
  readonly name: string;
}

export interface WorkQueueItem {
  /** Uppercase project key, as registered on the project. */
  readonly key: string;
  readonly number: number;
  /** Text that produced the item. For range members this is the whole range text. */
  readonly raw: string;
}

export interface WorkQueueUnknownKey {
  /** Uppercase key that matched no known project. */
  readonly key: string;
  /** Project keys that look like a near match, best first. Never applied automatically. */
  readonly suggestions: readonly string[];
}

export interface WorkQueueParseResult {
  readonly items: WorkQueueItem[];
  readonly unknownKeys: WorkQueueUnknownKey[];
  /** Leftover meaningful words, in source order, de-duplicated case-insensitively. */
  readonly unparsed: string[];
  readonly warnings: string[];
}

type Token =
  | {
      readonly kind: "range";
      readonly raw: string;
      readonly aKey: string;
      readonly aNum: number;
      readonly aSpaced: boolean;
      readonly bKey: string;
      readonly bNum: number;
      readonly bSpaced: boolean;
    }
  | { readonly kind: "ref"; readonly raw: string; readonly key: string; readonly num: number; readonly spaced: boolean }
  | { readonly kind: "exclude" }
  | { readonly kind: "reset" }
  | { readonly kind: "word"; readonly word: string };

interface ParseContext {
  readonly knownProjects: readonly WorkQueueProjectRef[];
  readonly knownKeys: ReadonlySet<string>;
  readonly selected: WorkQueueItem[];
  readonly excluded: WorkQueueItem[];
  readonly unknown: Map<string, WorkQueueUnknownKey>;
  readonly unparsed: Map<string, string>;
  readonly warnings: string[];
  excluding: boolean;
}

/**
 * Extracts work queue items from free text.
 *
 * Rules:
 * - Items are emitted only for keys in `knownProjects` (case-insensitive).
 * - Space-separated references (`Bit 92`) count only when the key is known;
 *   otherwise the word is treated as ordinary text.
 * - A range never crosses projects, and it expands to at most MAX_WORK_QUEUE_ITEMS.
 * - Exclusions remove codes from the result. They carry across list connectors
 *   until a newline, `;`, sentence end, or a meaningful word.
 * - The total is capped at MAX_WORK_QUEUE_ITEMS after de-duplication and exclusion.
 */
export function parseWorkQueuePrompt(
  text: string,
  knownProjects: readonly WorkQueueProjectRef[],
): WorkQueueParseResult {
  const ctx: ParseContext = {
    knownProjects,
    knownKeys: new Set(knownProjects.map((project) => project.key.toUpperCase())),
    selected: [],
    excluded: [],
    unknown: new Map(),
    unparsed: new Map(),
    warnings: [],
    excluding: false,
  };

  for (const token of tokenize(text)) {
    applyToken(ctx, token);
  }

  return finalize(ctx);
}

function* tokenize(text: string): Generator<Token> {
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const groups: Record<string, string | undefined> = match.groups ?? {};
    const raw = match[0];
    const { aKey, aSep, aNum, bKey, bSep, bNum, rKey, rSep, rNum, exclude, reset, word } = groups;

    if (aKey !== undefined && aSep !== undefined && aNum !== undefined && bNum !== undefined) {
      const aSpaced = !aSep.includes("-");
      yield {
        kind: "range",
        raw,
        aKey: aKey.toUpperCase(),
        aNum: Number(aNum),
        aSpaced,
        bKey: (bKey ?? aKey).toUpperCase(),
        bNum: Number(bNum),
        bSpaced: bSep === undefined ? aSpaced : !bSep.includes("-"),
      };
      continue;
    }
    if (rKey !== undefined && rSep !== undefined && rNum !== undefined) {
      yield { kind: "ref", raw, key: rKey, num: Number(rNum), spaced: !rSep.includes("-") };
      continue;
    }
    if (exclude !== undefined) {
      yield { kind: "exclude" };
      continue;
    }
    if (reset !== undefined) {
      yield { kind: "reset" };
      continue;
    }
    if (word !== undefined) {
      yield { kind: "word", word };
    }
  }
}

function applyToken(ctx: ParseContext, token: Token): void {
  switch (token.kind) {
    case "range":
      applyRange(ctx, token);
      return;
    case "ref":
      applyRef(ctx, token.key, token.num, token.raw, token.spaced);
      return;
    case "exclude":
      ctx.excluding = true;
      return;
    case "reset":
      ctx.excluding = false;
      return;
    case "word":
      addUnparsed(ctx, token.word);
      return;
  }
}

function applyRange(ctx: ParseContext, token: Extract<Token, { kind: "range" }>): void {
  if (token.aKey !== token.bKey) {
    ctx.warnings.push(`Range ${token.raw} crosses projects; each code was read on its own.`);
    applyRef(ctx, token.aKey, token.aNum, token.raw, token.aSpaced);
    applyRef(ctx, token.bKey, token.bNum, token.raw, token.bSpaced);
    return;
  }
  if (token.aNum > token.bNum) {
    ctx.warnings.push(`Range ${token.raw} runs backwards; only its endpoints were read.`);
    applyRef(ctx, token.aKey, token.aNum, token.raw, token.aSpaced);
    applyRef(ctx, token.bKey, token.bNum, token.raw, token.bSpaced);
    return;
  }

  const last = Math.min(token.bNum, token.aNum + MAX_WORK_QUEUE_ITEMS - 1);
  for (let number = token.aNum; number <= last; number++) {
    applyRef(ctx, token.aKey, number, token.raw, token.aSpaced);
  }
  if (last < token.bNum) {
    ctx.warnings.push(`Range ${token.raw} was truncated to ${String(MAX_WORK_QUEUE_ITEMS)} items.`);
  }
}

function applyRef(ctx: ParseContext, key: string, number: number, raw: string, spaced: boolean): void {
  const projectKey = key.toUpperCase();
  if (!ctx.knownKeys.has(projectKey)) {
    if (spaced) {
      addUnparsed(ctx, key);
    } else {
      addUnknownKey(ctx, projectKey);
    }
    return;
  }
  if (number < MIN_ITEM_NUMBER) {
    ctx.warnings.push(`Ignored ${raw}: work items are numbered from ${String(MIN_ITEM_NUMBER)}.`);
    return;
  }
  const item: WorkQueueItem = { key: projectKey, number, raw };
  if (ctx.excluding) {
    ctx.excluded.push(item);
  } else {
    ctx.selected.push(item);
  }
}

function addUnknownKey(ctx: ParseContext, key: string): void {
  if (ctx.unknown.has(key)) return;
  ctx.unknown.set(key, { key, suggestions: suggestProjectKeys(key, ctx.knownProjects) });
}

function addUnparsed(ctx: ParseContext, word: string): void {
  const lower = word.toLowerCase();
  if (STOPWORDS.has(lower)) return;
  ctx.excluding = false;
  if (!ctx.unparsed.has(lower)) {
    ctx.unparsed.set(lower, word);
  }
}

function itemId(item: WorkQueueItem): string {
  return `${item.key}-${String(item.number)}`;
}

function finalize(ctx: ParseContext): WorkQueueParseResult {
  const selectedIds = new Set(ctx.selected.map(itemId));
  const excludedIds = new Set(ctx.excluded.map(itemId));
  const emitted = new Set<string>();
  const duplicates = new Set<string>();
  const items: WorkQueueItem[] = [];

  for (const item of ctx.selected) {
    const id = itemId(item);
    if (emitted.has(id)) {
      duplicates.add(id);
      continue;
    }
    emitted.add(id);
    if (excludedIds.has(id)) continue;
    items.push(item);
  }

  for (const id of duplicates) {
    ctx.warnings.push(`${id} was listed more than once; kept one.`);
  }
  for (const id of excludedIds) {
    if (!selectedIds.has(id)) {
      ctx.warnings.push(`${id} was excluded but was not selected.`);
    }
  }

  if (items.length > MAX_WORK_QUEUE_ITEMS) {
    ctx.warnings.push(
      `Kept the first ${String(MAX_WORK_QUEUE_ITEMS)} items; ${String(items.length - MAX_WORK_QUEUE_ITEMS)} dropped.`,
    );
  }

  return {
    items: items.slice(0, MAX_WORK_QUEUE_ITEMS),
    unknownKeys: [...ctx.unknown.values()],
    unparsed: [...ctx.unparsed.values()],
    warnings: ctx.warnings,
  };
}

/**
 * Suggests known project keys for an unknown key. A match on the project name
 * (prefix or initials) ranks first, then a key prefix, then a small edit
 * distance. Suggestions are only hints; the caller decides what to do with them.
 */
function suggestProjectKeys(key: string, projects: readonly WorkQueueProjectRef[]): string[] {
  const bestScore = new Map<string, number>();

  for (const project of projects) {
    const projectKey = project.key.toUpperCase();
    const score = scoreSuggestion(key, projectKey, project.name.trim().toUpperCase());
    if (score === undefined) continue;
    const current = bestScore.get(projectKey);
    if (current === undefined || score < current) {
      bestScore.set(projectKey, score);
    }
  }

  return [...bestScore.entries()]
    .sort(([keyA, scoreA], [keyB, scoreB]) => scoreA - scoreB || keyA.localeCompare(keyB))
    .slice(0, SUGGESTION_LIMIT)
    .map(([projectKey]) => projectKey);
}

function scoreSuggestion(key: string, projectKey: string, name: string): number | undefined {
  if (name.startsWith(key) || initialsOf(name) === key) return SUGGESTION_SCORE_NAME;
  if (projectKey.startsWith(key)) return SUGGESTION_SCORE_KEY_PREFIX;
  const distance = editDistance(key, projectKey);
  if (distance <= SUGGESTION_MAX_DISTANCE) return SUGGESTION_SCORE_NEAR_BASE + distance;
  return undefined;
}

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0))
    .join("");
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
