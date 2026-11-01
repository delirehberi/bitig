import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_TYPES,
  ATTACHMENT_TASK_MAX_BYTES,
  ATTACHMENT_TASK_MAX_COUNT,
  DEFAULT_ATTACHMENT_MIME_TYPE,
} from "./constants";
import { ValidationError, parseOrThrow } from "./errors";
import { AttachmentSchema, CreateAttachmentInputSchema, TaskActorSchema } from "./schemas";
import type {
  Attachment,
  AttachmentContent,
  AttachmentMimeType,
  CreateAttachmentInput,
} from "./types";
import { toTimestamp, type RuntimeDeps } from "../runtime/ids";

const ALLOWED_MIME_TYPES = new Set<string>(ATTACHMENT_MIME_TYPES);

const MIME_ALIASES: Readonly<Record<string, AttachmentMimeType>> = {
  "text/x-markdown": "text/markdown",
  "text/x-log": "text/plain",
  "text/yaml": "application/yaml",
  "text/x-yaml": "application/yaml",
  "application/x-yaml": "application/yaml",
  "application/x-gzip": "application/gzip",
  "image/jpg": "image/jpeg",
};

const EXTENSION_MIME_TYPES: Readonly<Record<string, AttachmentMimeType>> = {
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".csv": "text/csv",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

const TEXT_MIME_TYPES = new Set<string>([
  "text/markdown",
  "text/plain",
  "text/csv",
  "application/json",
  "application/yaml",
]);

const IMAGE_MIME_TYPES = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const BASE64_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < BASE64_ALPHABET.length; i++) {
  BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(i)] = i;
}
BASE64_LOOKUP["-".charCodeAt(0)] = 62;
BASE64_LOOKUP["_".charCodeAt(0)] = 63;

/** Pure ES2023 UTF-8 encoder (keeps `@bitig/core` independent of DOM/Node globals). */
export function encodeUtf8(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code <= 0xffff) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/** Pure ES2023 UTF-8 decoder. */
export function decodeUtf8(bytes: Uint8Array): string {
  const codePoints: number[] = [];
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++] ?? 0;
    if ((b0 & 0x80) === 0) {
      codePoints.push(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = (bytes[i++] ?? 0) & 0x3f;
      codePoints.push(((b0 & 0x1f) << 6) | b1);
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = (bytes[i++] ?? 0) & 0x3f;
      const b2 = (bytes[i++] ?? 0) & 0x3f;
      codePoints.push(((b0 & 0x0f) << 12) | (b1 << 6) | b2);
    } else {
      const b1 = (bytes[i++] ?? 0) & 0x3f;
      const b2 = (bytes[i++] ?? 0) & 0x3f;
      const b3 = (bytes[i++] ?? 0) & 0x3f;
      codePoints.push(((b0 & 0x07) << 18) | (b1 << 12) | (b2 << 6) | b3);
    }
  }
  let out = "";
  const chunk = 4096;
  for (let offset = 0; offset < codePoints.length; offset += chunk) {
    out += String.fromCodePoint(...codePoints.slice(offset, offset + chunk));
  }
  return out;
}

/** Encodes raw bytes as standard Base64. */
export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = i + 1 < len ? (bytes[i + 1] ?? 0) : 0;
    const b2 = i + 2 < len ? (bytes[i + 2] ?? 0) : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += BASE64_ALPHABET[(triplet >> 18) & 0x3f] ?? "";
    out += BASE64_ALPHABET[(triplet >> 12) & 0x3f] ?? "";
    out += i + 1 < len ? (BASE64_ALPHABET[(triplet >> 6) & 0x3f] ?? "") : "=";
    out += i + 2 < len ? (BASE64_ALPHABET[triplet & 0x3f] ?? "") : "=";
  }
  return out;
}

function customValidationError(
  context: string,
  path: readonly PropertyKey[],
  message: string,
  input?: unknown,
): ValidationError {
  return new ValidationError(context, [{ code: "custom", path: [...path], message, input }]);
}

/** Decodes Base64 (or a `data:...;base64,...` URI) into a `Uint8Array`. */
export function decodeBase64(input: string, context = "attachment"): Uint8Array {
  const commaIdx = input.startsWith("data:") ? input.indexOf(",") : -1;
  const raw = (commaIdx >= 0 ? input.slice(commaIdx + 1) : input).replace(/\s+/g, "");
  if (raw.length === 0) return new Uint8Array(0);
  const paddedLen = raw.length % 4 === 0 ? raw.length : raw.length + (4 - (raw.length % 4));
  const padded = raw.padEnd(paddedLen, "=");
  let padCount = 0;
  if (padded.endsWith("==")) padCount = 2;
  else if (padded.endsWith("=")) padCount = 1;

  const outLen = (padded.length / 4) * 3 - padCount;
  const out = new Uint8Array(outLen);
  let outIdx = 0;

  for (let i = 0; i < padded.length; i += 4) {
    const c0 = padded.charCodeAt(i);
    const c1 = padded.charCodeAt(i + 1);
    const c2 = padded.charCodeAt(i + 2);
    const c3 = padded.charCodeAt(i + 3);
    const v0 = c0 < 128 ? (BASE64_LOOKUP[c0] ?? -1) : -1;
    const v1 = c1 < 128 ? (BASE64_LOOKUP[c1] ?? -1) : -1;
    const v2 = c2 === 61 ? 0 : c2 < 128 ? (BASE64_LOOKUP[c2] ?? -1) : -1;
    const v3 = c3 === 61 ? 0 : c3 < 128 ? (BASE64_LOOKUP[c3] ?? -1) : -1;
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) {
      throw customValidationError(context, ["data"], "Invalid base64 payload", input);
    }
    const triplet = (v0 << 18) | (v1 << 12) | (v2 << 6) | v3;
    if (outIdx < outLen) out[outIdx++] = (triplet >> 16) & 0xff;
    if (outIdx < outLen) out[outIdx++] = (triplet >> 8) & 0xff;
    if (outIdx < outLen) out[outIdx++] = triplet & 0xff;
  }
  return out;
}

/** Infers an attachment MIME type from its file extension, or `application/octet-stream`. */
export function inferAttachmentMimeType(fileName: string): AttachmentMimeType {
  const lower = fileName.trim().toLowerCase();
  if (lower.endsWith(".tar.gz")) return "application/gzip";
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return DEFAULT_ATTACHMENT_MIME_TYPE;
  const ext = lower.slice(dot);
  return EXTENSION_MIME_TYPES[ext] ?? DEFAULT_ATTACHMENT_MIME_TYPE;
}

/**
 * Normalizes and validates an attachment MIME type, falling back to extension inference
 * when omitted or `application/octet-stream`. Rejects unsafe or unsupported types.
 */
export function normalizeAttachmentMimeType(
  mimeType: string | undefined,
  fileName: string,
  context = "addAttachment",
): AttachmentMimeType {
  const base = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (base === undefined || base === "" || base === DEFAULT_ATTACHMENT_MIME_TYPE) {
    return inferAttachmentMimeType(fileName);
  }
  const canonical = MIME_ALIASES[base] ?? base;
  if (!ALLOWED_MIME_TYPES.has(canonical)) {
    throw customValidationError(
      context,
      ["mimeType"],
      `Unsupported attachment MIME type "${base}"`,
      mimeType,
    );
  }
  return canonical as AttachmentMimeType;
}

/** Whether an attachment's MIME type is UTF-8 text that can be returned or rendered inline. */
export function isTextAttachmentMimeType(mimeType: string): boolean {
  return TEXT_MIME_TYPES.has(mimeType);
}

/** Whether an attachment's MIME type is a raster image that can be previewed inline. */
export function isImageAttachmentMimeType(mimeType: string): boolean {
  return IMAGE_MIME_TYPES.has(mimeType);
}

/** Whether an attachment is a Markdown document (`text/markdown` or `.md`/`.markdown`). */
export function isMarkdownAttachment(attachment: Pick<Attachment, "name" | "mimeType">): boolean {
  return attachment.mimeType === "text/markdown" || /\.(md|markdown)$/i.test(attachment.name);
}

/** Validates input, normalizes MIME type and bytes, and constructs a full `AttachmentContent`. */
export function buildAttachment(
  input: CreateAttachmentInput,
  deps: RuntimeDeps,
  actor?: string,
): AttachmentContent {
  const parsed = parseOrThrow(CreateAttachmentInputSchema, input, "addAttachment");
  const validActor =
    actor === undefined ? undefined : parseOrThrow(TaskActorSchema, actor, "addAttachment actor");
  const bytes =
    typeof parsed.data === "string" ? encodeUtf8(parsed.data) : new Uint8Array(parsed.data);
  if (bytes.byteLength === 0) {
    throw customValidationError("addAttachment", ["data"], "Attachment must not be empty");
  }
  if (bytes.byteLength > ATTACHMENT_MAX_BYTES) {
    throw customValidationError(
      "addAttachment",
      ["data"],
      `Attachment exceeds maximum size of ${String(ATTACHMENT_MAX_BYTES)} bytes`,
      bytes.byteLength,
    );
  }
  const mimeType = normalizeAttachmentMimeType(parsed.mimeType, parsed.name, "addAttachment");
  const metadata: Attachment = {
    id: deps.generateId(),
    taskId: parsed.taskId,
    name: parsed.name,
    mimeType,
    size: bytes.byteLength,
    createdAt: toTimestamp(deps.clock()),
    ...(validActor !== undefined ? { createdBy: validActor } : {}),
  };
  const validated = parseOrThrow(AttachmentSchema, metadata, "addAttachment result");
  return { ...validated, data: bytes };
}

/** Enforces per-task attachment count and cumulative byte limits before storing a new attachment. */
export function assertTaskAttachmentQuota(
  existing: Iterable<Pick<Attachment, "size">>,
  incomingSize: number,
  context = "addAttachment",
): void {
  let count = 0;
  let totalBytes = 0;
  for (const item of existing) {
    count++;
    totalBytes += item.size;
  }
  if (count >= ATTACHMENT_TASK_MAX_COUNT) {
    throw customValidationError(
      context,
      ["taskId"],
      `Task cannot have more than ${String(ATTACHMENT_TASK_MAX_COUNT)} attachments`,
      count,
    );
  }
  if (totalBytes + incomingSize > ATTACHMENT_TASK_MAX_BYTES) {
    throw customValidationError(
      context,
      ["data"],
      `Task attachments cannot exceed ${String(ATTACHMENT_TASK_MAX_BYTES)} bytes in total`,
      totalBytes + incomingSize,
    );
  }
}

export function stripAttachmentData(attachment: AttachmentContent): Attachment {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: attachment.createdAt,
    ...(attachment.createdBy !== undefined ? { createdBy: attachment.createdBy } : {}),
  };
}

export function cloneAttachment(attachment: Attachment): Attachment {
  return { ...attachment };
}

export function cloneAttachmentContent(attachment: AttachmentContent): AttachmentContent {
  return {
    ...attachment,
    data: new Uint8Array(attachment.data),
  };
}

/** Attachments are listed oldest first, with `id` as a stable tiebreaker. */
export function compareAttachments(a: Attachment, b: Attachment): number {
  if (a.createdAt !== b.createdAt) return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
