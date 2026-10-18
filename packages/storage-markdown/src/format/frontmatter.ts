/**
 * Frontmatter documents: a YAML block between `---` fences followed by a
 * Markdown body.
 *
 * YAML is parsed with the YAML 1.2 core schema, so `2026-10-20` stays a
 * string instead of becoming a `Date` (the reason `gray-matter`/js-yaml are
 * not used). Date-like strings are still written double-quoted so YAML 1.1
 * tools (editors, static site generators) read them as strings too.
 *
 * The body is stored verbatim with one trailing newline appended when it is
 * non-empty (POSIX text files end with a newline); exactly one trailing
 * newline is removed on read, so descriptions round-trip byte for byte.
 */
import { Document, isScalar, parseDocument } from "yaml";

const FENCE = "---";
const BYTE_ORDER_MARK = "\uFEFF";
const NEWLINE = "\n";
/** Matches the opening fence line, tolerating CRLF line endings from hand edits. */
const OPENING_FENCE = /^---\r?\n/;
/** Matches a closing fence (`---` or the YAML document end marker `...`) on its own line. */
const CLOSING_FENCE = /^(?:---|\.\.\.)[ \t]*\r?$/m;

export class FrontmatterError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FrontmatterError";
  }
}

export interface FrontmatterDocument {
  /** Parsed YAML mapping. Values are unvalidated; callers validate with zod. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly body: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a standalone YAML mapping (used for `_project.yaml`). */
export function parseYamlMapping(text: string): Record<string, unknown> {
  const doc = parseDocument(text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text, {
    schema: "core",
    uniqueKeys: true,
  });
  const [firstError] = doc.errors;
  if (firstError !== undefined) throw new FrontmatterError(`invalid YAML: ${firstError.message}`, { cause: firstError });
  const value: unknown = doc.toJS({ maxAliasCount: 0 });
  // An empty document parses to null; treat it as an empty mapping so schema
  // validation reports the missing fields instead of a generic type error.
  if (value === null || value === undefined) return {};
  if (!isPlainRecord(value)) throw new FrontmatterError("YAML document must be a mapping");
  return value;
}

/** Serializes a mapping, double-quoting the values of `quotedKeys`. */
export function stringifyYamlMapping(
  data: Readonly<Record<string, unknown>>,
  quotedKeys: ReadonlySet<string>,
): string {
  const doc = new Document(data, { schema: "core" });
  for (const key of quotedKeys) {
    const node = doc.get(key, true);
    if (isScalar(node) && typeof node.value === "string") node.type = "QUOTE_DOUBLE";
  }
  return doc.toString({ lineWidth: 0 });
}

export function parseFrontmatter(text: string): FrontmatterDocument {
  const source = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const opening = OPENING_FENCE.exec(source);
  if (opening === null) throw new FrontmatterError(`file must start with a "${FENCE}" frontmatter fence`);
  const rest = source.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  if (closing === null) throw new FrontmatterError(`frontmatter is missing its closing "${FENCE}" fence`);

  const yamlText = rest.slice(0, closing.index);
  let body = rest.slice(closing.index + closing[0].length);
  if (body.startsWith(NEWLINE)) body = body.slice(NEWLINE.length);
  if (body.endsWith(NEWLINE)) body = body.slice(0, -NEWLINE.length);

  return { data: parseYamlMapping(yamlText), body };
}

export function stringifyFrontmatter(
  data: Readonly<Record<string, unknown>>,
  body: string,
  quotedKeys: ReadonlySet<string>,
): string {
  const yamlText = stringifyYamlMapping(data, quotedKeys);
  const bodyText = body === "" ? "" : `${body}${NEWLINE}`;
  return `${FENCE}${NEWLINE}${yamlText}${FENCE}${NEWLINE}${bodyText}`;
}

