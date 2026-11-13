/**
 * Project feedback forms: domain types, Zod schemas, spam scoring heuristics,
 * and task-from-submission mapping (#BIT-174).
 *
 * Environment-neutral: no Node, DOM or Workers APIs.
 */
import { z } from "zod";
import {
  DESCRIPTION_MAX,
  LABELS_MAX_COUNT,
  LABEL_MAX,
  RESOURCE_URL_MAX,
  TASK_ACTOR_MAX,
  TASK_TITLE_MAX,
} from "./constants";
import { parseOrThrow } from "./errors";
import {
  CreateTaskInputSchema,
  IdSchema,
  LabelsSchema,
  TaskActorSchema,
  TaskPrioritySchema,
  TimestampSchema,
} from "./schemas";
import type { CreateTaskInput } from "./types";
import { defaultRuntimeDeps, toTimestamp, type RuntimeDeps } from "../runtime/ids";

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------

export const FEEDBACK_LABEL = "feedback" as const;
export const FEEDBACK_ACTOR_PREFIX = "feedback:" as const;

export const FEEDBACK_EMAIL_MODES = ["off", "optional", "required"] as const;
export type FeedbackEmailMode = (typeof FEEDBACK_EMAIL_MODES)[number];
export const DEFAULT_FEEDBACK_EMAIL_MODE: FeedbackEmailMode = "optional";

export const FEEDBACK_NAME_MODES = ["off", "optional", "required"] as const;
export type FeedbackNameMode = (typeof FEEDBACK_NAME_MODES)[number];

export const FEEDBACK_ENTRY_OUTCOMES = [
  "pending",
  "approved",
  "rejected",
  "spam",
  "merged",
] as const;
export type FeedbackEntryOutcome = (typeof FEEDBACK_ENTRY_OUTCOMES)[number];
export const DEFAULT_FEEDBACK_ENTRY_OUTCOME: FeedbackEntryOutcome = "pending";

export const FEEDBACK_FORM_NAME_MAX = 120;
export const FEEDBACK_FORM_TITLE_MAX = 200;
export const FEEDBACK_FORM_INTRO_MAX = 2_000;
export const FEEDBACK_THANK_YOU_TEXT_MAX = 500;
export const DEFAULT_FEEDBACK_THANK_YOU_TEXT = "Thank you for your feedback.";
export const DEFAULT_FEEDBACK_ENABLED = true;
export const DEFAULT_FEEDBACK_TURNSTILE = true;

export const FEEDBACK_PUBLIC_ID_MIN = 16;
export const FEEDBACK_PUBLIC_ID_MAX = 64;
export const FEEDBACK_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const FEEDBACK_CATEGORY_MAX = 64;
export const FEEDBACK_CATEGORIES_MAX_COUNT = 10;

export const FEEDBACK_ALLOWED_ORIGIN_MAX = 512;
export const FEEDBACK_ALLOWED_ORIGINS_MAX_COUNT = 20;

export const FEEDBACK_BANNED_WORD_MAX = 100;
export const FEEDBACK_BANNED_WORDS_MAX_COUNT = 200;

export const FEEDBACK_BLOCKED_IP_HASHES_MAX_COUNT = 1_000;

export const FEEDBACK_ACCENT_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const FEEDBACK_SUBMISSION_TITLE_MAX = 200;
export const FEEDBACK_SUBMISSION_BODY_MAX = 5_000;
export const FEEDBACK_SUBMITTER_NAME_MAX = 120;
export const FEEDBACK_SUBMITTER_EMAIL_MAX = 320;
export const FEEDBACK_USER_AGENT_MAX = 300;
export const FEEDBACK_HASH_MAX = 128;

export const FEEDBACK_PENDING_CAP = 500;
export const FEEDBACK_MIN_FILL_MS = 3_000;
export const FEEDBACK_MAX_FILL_MS = 2 * 60 * 60 * 1_000;
export const FEEDBACK_DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const FEEDBACK_PURGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** Score at or above which a submission is classified as high-confidence spam. */
export const FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD = 100;
/** Number of links in a submission that triggers a high spam score on its own. */
export const FEEDBACK_SPAM_HIGH_LINK_COUNT = 3;

// ---------------------------------------------------------------------------
// Plain-text & Origin Helpers
// ---------------------------------------------------------------------------

/**
 * Strips ASCII control characters (except `\n` and `\t`) and normalizes `\r\n`/`\r` to `\n`.
 */
export function sanitizePlainText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
      .trim()
  );
}

/**
 * Strips all ASCII control characters (including newlines) for single-line plain text.
 */
export function sanitizeSingleLinePlainText(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

const HTTP_ORIGIN_PATTERN =
  /^(https?):\/\/(?:([^/@?#]+)@)?(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;

/**
 * Normalizes an allowed embed origin (e.g. `https://example.com/` -> `https://example.com`).
 * Returns `null` if the string is not a valid `http:` or `https:` origin without path/query/hash/credentials.
 */
export function normalizeAllowedOrigin(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > FEEDBACK_ALLOWED_ORIGIN_MAX) return null;
  const match = HTTP_ORIGIN_PATTERN.exec(trimmed);
  if (!match) return null;

  const scheme = (match[1] ?? "").toLowerCase();
  const userInfo = match[2] ?? "";
  const hostname = (match[3] ?? "").toLowerCase();
  const port = match[4] ?? "";
  const pathname = match[5] ?? "";
  const query = match[6] ?? "";
  const hash = match[7] ?? "";

  if (userInfo !== "") return null;
  if (hostname === "" || hostname.startsWith(".") || hostname.endsWith(".") || hostname.includes("..")) {
    return null;
  }
  if (pathname !== "" && pathname !== "/") return null;
  if (query !== "" || hash !== "") return null;

  if (port !== "") {
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return null;
  }

  const isDefaultPort = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  const authority = port !== "" && !isDefaultPort ? `${hostname}:${port}` : hostname;
  return `${scheme}://${authority}`;
}

const PlainSingleLineSchema = (max: number, label: string) =>
  z
    .string()
    .transform(sanitizeSingleLinePlainText)
    .pipe(z.string().min(1, `${label} must not be empty`).max(max));

const PlainMultiLineSchema = (max: number, label: string) =>
  z
    .string()
    .transform(sanitizePlainText)
    .pipe(z.string().min(1, `${label} must not be empty`).max(max));

const OptionalPlainMultiLineSchema = (max: number) =>
  z
    .string()
    .transform(sanitizePlainText)
    .pipe(z.string().max(max));

// ---------------------------------------------------------------------------
// Form Field Toggles & Schemas
// ---------------------------------------------------------------------------

export const FeedbackEmailModeSchema = z.enum(FEEDBACK_EMAIL_MODES);
export const FeedbackNameModeSchema = z.enum(FEEDBACK_NAME_MODES);
export const FeedbackEntryOutcomeSchema = z.enum(FEEDBACK_ENTRY_OUTCOMES);

/**
 * Name field toggle: accepts boolean (`true` = optional, `false` = off) or
 * `"off" | "optional" | "required"` and normalizes to boolean in `FeedbackFields`
 * while preserving `"required"` when used via `FeedbackNameFieldToggleSchema`.
 * Wait: let's store `boolean` on `FeedbackFields.name` (default `false`) and also accept `"off" | "optional" | "required"` on input!
 */
export const FeedbackNameToggleInputSchema = z
  .union([z.boolean(), FeedbackNameModeSchema])
  .transform((val): boolean => (typeof val === "boolean" ? val : val !== "off"));

export const FeedbackCategoryOptionSchema = PlainSingleLineSchema(
  FEEDBACK_CATEGORY_MAX,
  "Category option",
);

export const FeedbackCategoriesSchema = z
  .array(FeedbackCategoryOptionSchema)
  .max(FEEDBACK_CATEGORIES_MAX_COUNT)
  .refine(
    (categories) => new Set(categories.map((c) => c.toLowerCase())).size === categories.length,
    { message: "Category options must be unique" },
  );

export const FeedbackBannedWordSchema = PlainSingleLineSchema(
  FEEDBACK_BANNED_WORD_MAX,
  "Banned word",
).transform((w) => w.toLowerCase());

export const FeedbackBannedWordsSchema = z
  .array(FeedbackBannedWordSchema)
  .max(FEEDBACK_BANNED_WORDS_MAX_COUNT)
  .transform((words) => [...new Set(words)]);

export const FeedbackBlockedIpHashSchema = PlainSingleLineSchema(
  FEEDBACK_HASH_MAX,
  "Blocked IP hash",
).transform((h) => h.toLowerCase());

export const FeedbackBlockedIpHashesSchema = z
  .array(FeedbackBlockedIpHashSchema)
  .max(FEEDBACK_BLOCKED_IP_HASHES_MAX_COUNT)
  .transform((hashes) => [...new Set(hashes)]);

export const FeedbackFieldsSchema = z.strictObject({
  email: FeedbackEmailModeSchema.default(DEFAULT_FEEDBACK_EMAIL_MODE),
  name: FeedbackNameToggleInputSchema.default(false),
  categories: FeedbackCategoriesSchema.default([]),
  bannedWords: FeedbackBannedWordsSchema.exactOptional(),
  blockedIpHashes: FeedbackBlockedIpHashesSchema.exactOptional(),
});

export type FeedbackFields = z.output<typeof FeedbackFieldsSchema>;
export type FeedbackFieldsInput = z.input<typeof FeedbackFieldsSchema>;

export const DEFAULT_FEEDBACK_FIELDS: FeedbackFields = {
  email: DEFAULT_FEEDBACK_EMAIL_MODE,
  name: false,
  categories: [],
};

export const FeedbackPublicIdSchema = z
  .string()
  .trim()
  .min(FEEDBACK_PUBLIC_ID_MIN)
  .max(FEEDBACK_PUBLIC_ID_MAX)
  .regex(
    FEEDBACK_PUBLIC_ID_PATTERN,
    "Feedback public ID must be 16-64 URL-safe characters (letters, digits, '-' or '_')",
  );

export const FeedbackAllowedOriginSchema = z
  .string()
  .transform((raw, ctx): string => {
    const normalized = normalizeAllowedOrigin(raw);
    if (normalized === null) {
      ctx.addIssue({
        code: "custom",
        message: "Allowed origin must be an http(s) origin such as https://example.com",
      });
      return z.NEVER;
    }
    return normalized;
  });

export const FeedbackAllowedOriginsSchema = z
  .array(FeedbackAllowedOriginSchema)
  .max(FEEDBACK_ALLOWED_ORIGINS_MAX_COUNT)
  .refine((origins) => new Set(origins).size === origins.length, {
    message: "Allowed origins must be unique",
  });

export const FeedbackAccentColorSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    FEEDBACK_ACCENT_COLOR_PATTERN,
    "Accent colour must be a hex colour such as #2563eb or #fff",
  );

export const FeedbackFormNameSchema = PlainSingleLineSchema(
  FEEDBACK_FORM_NAME_MAX,
  "Feedback form name",
);
export const FeedbackFormTitleSchema = PlainSingleLineSchema(
  FEEDBACK_FORM_TITLE_MAX,
  "Feedback form title",
);
export const FeedbackFormIntroSchema = OptionalPlainMultiLineSchema(FEEDBACK_FORM_INTRO_MAX);
export const FeedbackThankYouTextSchema = PlainMultiLineSchema(
  FEEDBACK_THANK_YOU_TEXT_MAX,
  "Thank-you text",
);

// ---------------------------------------------------------------------------
// FeedbackForm Entity & Input Schemas
// ---------------------------------------------------------------------------

export const FeedbackFormSchema = z.strictObject({
  id: IdSchema,
  orgId: IdSchema,
  projectId: IdSchema,
  publicId: FeedbackPublicIdSchema,
  name: FeedbackFormNameSchema,
  title: FeedbackFormTitleSchema,
  intro: FeedbackFormIntroSchema,
  enabled: z.boolean(),
  fields: FeedbackFieldsSchema,
  allowedOrigins: FeedbackAllowedOriginsSchema,
  turnstile: z.boolean(),
  defaultLabels: LabelsSchema.exactOptional(),
  defaultPriority: TaskPrioritySchema.exactOptional(),
  thankYouText: FeedbackThankYouTextSchema,
  accentColor: FeedbackAccentColorSchema.exactOptional(),
  bannedWords: FeedbackBannedWordsSchema.exactOptional(),
  blockedIpHashes: FeedbackBlockedIpHashesSchema.exactOptional(),
  submissionCount: z.number().int().nonnegative(),
  lastSubmittedAt: TimestampSchema.exactOptional(),
  createdBy: TaskActorSchema.exactOptional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type FeedbackForm = z.output<typeof FeedbackFormSchema>;

export const CreateFeedbackFormInputSchema = z.strictObject({
  id: IdSchema.optional(),
  orgId: IdSchema.optional(),
  projectId: IdSchema,
  publicId: FeedbackPublicIdSchema.optional(),
  name: FeedbackFormNameSchema,
  title: FeedbackFormTitleSchema.optional(),
  intro: FeedbackFormIntroSchema.default(""),
  enabled: z.boolean().default(DEFAULT_FEEDBACK_ENABLED),
  fields: FeedbackFieldsSchema.default(DEFAULT_FEEDBACK_FIELDS),
  allowedOrigins: FeedbackAllowedOriginsSchema.default([]),
  turnstile: z.boolean().default(DEFAULT_FEEDBACK_TURNSTILE),
  defaultLabels: LabelsSchema.optional(),
  defaultPriority: TaskPrioritySchema.optional(),
  thankYouText: FeedbackThankYouTextSchema.default(DEFAULT_FEEDBACK_THANK_YOU_TEXT),
  accentColor: FeedbackAccentColorSchema.optional(),
  bannedWords: FeedbackBannedWordsSchema.optional(),
  blockedIpHashes: FeedbackBlockedIpHashesSchema.optional(),
  createdBy: TaskActorSchema.optional(),
});

export type CreateFeedbackFormInput = z.input<typeof CreateFeedbackFormInputSchema>;
export type ParsedCreateFeedbackFormInput = z.output<typeof CreateFeedbackFormInputSchema>;

export const UpdateFeedbackFormInputSchema = z
  .strictObject({
    name: FeedbackFormNameSchema.optional(),
    title: FeedbackFormTitleSchema.optional(),
    intro: FeedbackFormIntroSchema.optional(),
    enabled: z.boolean().optional(),
    fields: FeedbackFieldsSchema.optional(),
    allowedOrigins: FeedbackAllowedOriginsSchema.optional(),
    turnstile: z.boolean().optional(),
    defaultLabels: LabelsSchema.nullable().optional(),
    defaultPriority: TaskPrioritySchema.nullable().optional(),
    thankYouText: FeedbackThankYouTextSchema.optional(),
    accentColor: FeedbackAccentColorSchema.nullable().optional(),
    bannedWords: FeedbackBannedWordsSchema.nullable().optional(),
    blockedIpHashes: FeedbackBlockedIpHashesSchema.nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: "Patch must contain at least one field",
  });

export type UpdateFeedbackFormInput = z.input<typeof UpdateFeedbackFormInputSchema>;
export type ParsedUpdateFeedbackFormInput = z.output<typeof UpdateFeedbackFormInputSchema>;

// ---------------------------------------------------------------------------
// Feedback Submission Input Schema
// ---------------------------------------------------------------------------

export const FeedbackSubmissionTitleSchema = PlainSingleLineSchema(
  FEEDBACK_SUBMISSION_TITLE_MAX,
  "Title",
);

export const FeedbackSubmissionBodySchema = PlainMultiLineSchema(
  FEEDBACK_SUBMISSION_BODY_MAX,
  "Details",
);

export const FeedbackSubmitterEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(FEEDBACK_SUBMITTER_EMAIL_MAX)
  .pipe(z.email());

export const FeedbackSubmitterNameSchema = PlainSingleLineSchema(
  FEEDBACK_SUBMITTER_NAME_MAX,
  "Name",
);

export const FeedbackPageUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(RESOURCE_URL_MAX);

/**
 * Validates raw visitor submission input. Enforces plain-text limits:
 * title max 200 chars, body max 5,000 chars. Blank optional fields (`""`) are
 * normalized to `undefined` so HTML form posts and JSON bodies behave identically.
 */
export const FeedbackSubmissionInputSchema = z
  .strictObject({
    title: FeedbackSubmissionTitleSchema,
    body: FeedbackSubmissionBodySchema,
    category: z
      .string()
      .transform(sanitizeSingleLinePlainText)
      .pipe(z.string().max(FEEDBACK_CATEGORY_MAX))
      .optional()
      .transform((val) => (val !== undefined && val.length > 0 ? val : undefined)),
    submitterEmail: z
      .string()
      .trim()
      .optional()
      .transform((val) => (val !== undefined && val.length > 0 ? val : undefined))
      .pipe(FeedbackSubmitterEmailSchema.optional()),
    submitterName: z
      .string()
      .transform(sanitizeSingleLinePlainText)
      .pipe(z.string().max(FEEDBACK_SUBMITTER_NAME_MAX))
      .optional()
      .transform((val) => (val !== undefined && val.length > 0 ? val : undefined)),
    pageUrl: z
      .string()
      .trim()
      .optional()
      .transform((val) => (val !== undefined && val.length > 0 ? val : undefined))
      .pipe(FeedbackPageUrlSchema.optional()),
  });

export type FeedbackSubmissionInput = z.input<typeof FeedbackSubmissionInputSchema>;
export type FeedbackSubmission = z.output<typeof FeedbackSubmissionInputSchema>;

/**
 * Validates a submission against both `FeedbackSubmissionInputSchema` and the
 * target form's field toggle rules (`email`, `name`, `categories`).
 */
export function validateFeedbackSubmissionForForm(
  form: Pick<FeedbackForm, "fields">,
  input: unknown,
): FeedbackSubmission {
  const parsed = parseOrThrow(FeedbackSubmissionInputSchema, input, "feedbackSubmission");
  const issues: z.core.$ZodIssue[] = [];

  if (form.fields.email === "off" && parsed.submitterEmail !== undefined) {
    issues.push({
      code: "custom",
      path: ["submitterEmail"],
      message: "Email is not enabled on this form",
      input: parsed.submitterEmail,
    });
  } else if (form.fields.email === "required" && parsed.submitterEmail === undefined) {
    issues.push({
      code: "custom",
      path: ["submitterEmail"],
      message: "Email is required",
      input: undefined,
    });
  }

  if (!form.fields.name && parsed.submitterName !== undefined) {
    issues.push({
      code: "custom",
      path: ["submitterName"],
      message: "Name is not enabled on this form",
      input: parsed.submitterName,
    });
  }

  if (parsed.category !== undefined) {
    if (form.fields.categories.length === 0) {
      issues.push({
        code: "custom",
        path: ["category"],
        message: "Categories are not enabled on this form",
        input: parsed.category,
      });
    } else if (!form.fields.categories.includes(parsed.category)) {
      issues.push({
        code: "custom",
        path: ["category"],
        message: "Category must be one of the form's configured options",
        input: parsed.category,
      });
    }
  }

  if (issues.length > 0) {
    parseOrThrow(
      z.never(),
      input,
      `feedbackSubmission: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// FeedbackEntry Entity & Input Schemas
// ---------------------------------------------------------------------------

export const FeedbackEntrySchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema.nullable(),
  formId: IdSchema,
  orgId: IdSchema,
  projectId: IdSchema,
  outcome: FeedbackEntryOutcomeSchema,
  category: FeedbackCategoryOptionSchema.exactOptional(),
  submitterEmail: FeedbackSubmitterEmailSchema.exactOptional(),
  submitterName: FeedbackSubmitterNameSchema.exactOptional(),
  pageUrl: FeedbackPageUrlSchema.exactOptional(),
  ipHash: z.string().trim().min(1).max(FEEDBACK_HASH_MAX).exactOptional(),
  bodyHash: z.string().trim().min(1).max(FEEDBACK_HASH_MAX).exactOptional(),
  userAgent: z.string().trim().min(1).max(FEEDBACK_USER_AGENT_MAX).exactOptional(),
  spamScore: z.number().int().nonnegative(),
  reviewedBy: TaskActorSchema.exactOptional(),
  reviewedAt: TimestampSchema.exactOptional(),
  createdAt: TimestampSchema,
});

export type FeedbackEntry = z.output<typeof FeedbackEntrySchema>;

export const CreateFeedbackEntryInputSchema = z.strictObject({
  id: IdSchema.optional(),
  taskId: IdSchema.nullable().default(null),
  formId: IdSchema,
  orgId: IdSchema,
  projectId: IdSchema,
  outcome: FeedbackEntryOutcomeSchema.default(DEFAULT_FEEDBACK_ENTRY_OUTCOME),
  category: FeedbackCategoryOptionSchema.optional(),
  submitterEmail: FeedbackSubmitterEmailSchema.optional(),
  submitterName: FeedbackSubmitterNameSchema.optional(),
  pageUrl: FeedbackPageUrlSchema.optional(),
  ipHash: z.string().trim().min(1).max(FEEDBACK_HASH_MAX).optional(),
  bodyHash: z.string().trim().min(1).max(FEEDBACK_HASH_MAX).optional(),
  userAgent: z
    .string()
    .trim()
    .transform((ua) => ua.slice(0, FEEDBACK_USER_AGENT_MAX))
    .pipe(z.string().max(FEEDBACK_USER_AGENT_MAX))
    .optional()
    .transform((ua) => (ua !== undefined && ua.length > 0 ? ua : undefined)),
  spamScore: z.number().int().nonnegative().default(0),
  reviewedBy: TaskActorSchema.optional(),
  reviewedAt: TimestampSchema.optional(),
});

export type CreateFeedbackEntryInput = z.input<typeof CreateFeedbackEntryInputSchema>;
export type ParsedCreateFeedbackEntryInput = z.output<typeof CreateFeedbackEntryInputSchema>;

// ---------------------------------------------------------------------------
// Spam Scoring Heuristics
// ---------------------------------------------------------------------------

export interface SpamScoreSubmissionInput {
  readonly title: string;
  readonly body: string;
  readonly submitterName?: string | undefined;
}

export interface SpamScoreFormConfig {
  readonly bannedWords?: readonly string[] | undefined;
  readonly fields?:
    | {
        readonly bannedWords?: readonly string[] | undefined;
      }
    | undefined;
}

export interface SpamScoreBreakdown {
  readonly score: number;
  readonly isSpam: boolean;
  readonly linkCount: number;
  readonly repeatedText: boolean;
  readonly matchedBannedWords: string[];
}

const URL_LINK_REGEX =
  /\b(?:https?:\/\/|www\.)[^\s<>()"']+/gi;

/**
 * Counts HTTP(S) and `www.` links in text.
 */
export function countFeedbackLinks(text: string): number {
  const matches = text.match(URL_LINK_REGEX);
  return matches ? matches.length : 0;
}

function detectRepeatedText(title: string, body: string): { score: number; repeated: boolean } {
  let score = 0;
  const combined = `${title}\n${body}`;

  // 1. Long run of identical characters (e.g. "aaaaaaaaaaaa" >= 12 chars)
  if (/(.)\1{11,}/u.test(combined)) {
    score += 60;
  }

  // 2. Title and body are identical (when non-trivial length)
  const normTitle = title.trim().toLowerCase();
  const normBody = body.trim().toLowerCase();
  if (normTitle.length >= 10 && normTitle === normBody) {
    score += 50;
  }

  // 3. Repeated lines in body (3+ identical non-empty lines)
  const lines = normBody
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 4);
  if (lines.length >= 3) {
    const lineCounts = new Map<string, number>();
    for (const line of lines) {
      lineCounts.set(line, (lineCounts.get(line) ?? 0) + 1);
    }
    const maxDuplicateLines = Math.max(...lineCounts.values());
    if (maxDuplicateLines >= 3) {
      score += 100;
    } else if (maxDuplicateLines >= 2 && lines.length <= 4) {
      score += 50;
    }
  }

  // 4. Repeated words or phrases
  const words = combined
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, ""))
    .filter((w) => w.length >= 3);
  if (words.length >= 6) {
    // Consecutive identical words (e.g. "buy buy buy buy")
    let consecutive = 1;
    let maxConsecutive = 1;
    for (let i = 1; i < words.length; i++) {
      if (words[i] === words[i - 1]) {
        consecutive += 1;
        if (consecutive > maxConsecutive) maxConsecutive = consecutive;
      } else {
        consecutive = 1;
      }
    }
    if (maxConsecutive >= 4) {
      score += 100;
    } else if (maxConsecutive >= 3) {
      score += 50;
    }

    // Low unique-word ratio over a longer message
    const uniqueRatio = new Set(words).size / words.length;
    if (words.length >= 12 && uniqueRatio <= 0.25) {
      score += 100;
    } else if (words.length >= 8 && uniqueRatio <= 0.35) {
      score += 60;
    }
  }

  return { score, repeated: score > 0 };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findMatchedBannedWords(text: string, bannedWords: readonly string[]): string[] {
  if (bannedWords.length === 0) return [];
  const lowerText = text.toLowerCase();
  const matched: string[] = [];
  const seen = new Set<string>();

  for (const rawWord of bannedWords) {
    const needle = rawWord.trim().toLowerCase();
    if (needle.length === 0 || seen.has(needle)) continue;
    seen.add(needle);

    // If the banned entry starts and ends with word characters, match on word boundaries;
    // otherwise fall back to substring match for phrases/domains with punctuation.
    const usesWordBoundaries = /^[a-z0-9].*[a-z0-9]$|^[a-z0-9]$/i.test(needle);
    const pattern = usesWordBoundaries
      ? new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i")
      : new RegExp(escapeRegExp(needle), "i");
    if (pattern.test(lowerText)) {
      matched.push(needle);
    }
  }
  return matched;
}

/**
 * Computes a détaillé spam breakdown for a feedback submission against a form.
 */
export function evaluateFeedbackSpam(
  submission: SpamScoreSubmissionInput,
  form?: SpamScoreFormConfig,
): SpamScoreBreakdown {
  const combinedText = [submission.title, submission.body, submission.submitterName ?? ""]
    .filter((part) => part.length > 0)
    .join("\n");

  const linkCount = countFeedbackLinks(combinedText);
  let linkScore = 0;
  if (linkCount >= FEEDBACK_SPAM_HIGH_LINK_COUNT) {
    linkScore = FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD + (linkCount - FEEDBACK_SPAM_HIGH_LINK_COUNT) * 25;
  } else if (linkCount === 2) {
    linkScore = 40;
  } else if (linkCount === 1) {
    linkScore = 15;
  }

  const { score: repeatedScore, repeated } = detectRepeatedText(submission.title, submission.body);

  const configuredBannedWords = [
    ...(form?.bannedWords ?? []),
    ...(form?.fields?.bannedWords ?? []),
  ];
  const matchedBannedWords = findMatchedBannedWords(combinedText, configuredBannedWords);
  const bannedScore =
    matchedBannedWords.length > 0
      ? FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD + (matchedBannedWords.length - 1) * 50
      : 0;

  const score = linkScore + repeatedScore + bannedScore;
  return {
    score,
    isSpam: score >= FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD,
    linkCount,
    repeatedText: repeated,
    matchedBannedWords,
  };
}

/**
 * Returns the numeric spam score for a feedback submission.
 * - 3+ links scores high (>= `FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD`, i.e. 100+).
 * - Repeated text (duplicate lines, word flooding, character runs) adds to the score.
 * - Any match in the form's `bannedWords` scores high (>= 100).
 */
export function spamScore(
  submission: SpamScoreSubmissionInput,
  form?: SpamScoreFormConfig,
): number {
  return evaluateFeedbackSpam(submission, form).score;
}

/**
 * Whether a numeric spam score exceeds the high-spam threshold.
 */
export function isHighSpamScore(score: number): boolean {
  return score >= FEEDBACK_SPAM_SCORE_HIGH_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Task Creation Helper
// ---------------------------------------------------------------------------

export type FeedbackFormTaskConfig = Pick<
  FeedbackForm,
  "projectId" | "name"
> & {
  readonly defaultLabels?: readonly string[] | undefined;
  readonly defaultPriority?: CreateTaskInput["priority"] | undefined;
  readonly fields?: FeedbackForm["fields"] | undefined;
};

/**
 * Formats the actor name attributed to a feedback submission (`feedback:<form name>`),
 * truncated to `TASK_ACTOR_MAX`.
 */
export function feedbackTaskActor(form: Pick<FeedbackForm, "name">): string {
  const cleanName = sanitizeSingleLinePlainText(form.name);
  const raw = `${FEEDBACK_ACTOR_PREFIX}${cleanName.length > 0 ? cleanName : "form"}`;
  return raw.slice(0, TASK_ACTOR_MAX);
}

function mergeFeedbackLabels(defaultLabels: readonly string[] | undefined): string[] {
  const seen = new Set<string>([FEEDBACK_LABEL]);
  const labels: string[] = [FEEDBACK_LABEL];
  for (const raw of defaultLabels ?? []) {
    const trimmed = raw.trim().slice(0, LABEL_MAX);
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    labels.push(trimmed);
    if (labels.length >= LABELS_MAX_COUNT) break;
  }
  return labels;
}

function formatQuoteBlock(body: string): string {
  return body
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

/**
 * Builds a validated `CreateTaskInput` from a feedback form and a visitor submission:
 * - `pendingApproval: true`
 * - `labels`: `["feedback", ...form.defaultLabels]` (deduplicated)
 * - `priority`: `form.defaultPriority` when configured
 * - `description`: submission body inside a Markdown quote block, followed by a
 *   metadata footer (`Form`, optional `Category`, optional `Page URL`).
 * - Never includes `submitterEmail` (or `submitterName`) in the task text.
 */
export function taskFromFeedbackSubmission(
  form: FeedbackFormTaskConfig,
  submission: FeedbackSubmissionInput,
): CreateTaskInput {
  const validSubmission = form.fields
    ? validateFeedbackSubmissionForForm({ fields: form.fields }, submission)
    : parseOrThrow(FeedbackSubmissionInputSchema, submission, "taskFromFeedbackSubmission");

  const formName = sanitizeSingleLinePlainText(form.name);
  if (formName.length === 0) {
    parseOrThrow(FeedbackFormNameSchema, form.name, "taskFromFeedbackSubmission form.name");
  }

  const footerLines: string[] = [`- **Form:** ${formName}`];
  if (validSubmission.category !== undefined) {
    footerLines.push(`- **Category:** ${validSubmission.category}`);
  }
  if (validSubmission.pageUrl !== undefined) {
    footerLines.push(`- **Page URL:** ${validSubmission.pageUrl}`);
  }

  const footer = `\n\n${footerLines.join("\n")}`;
  const quotedBody = formatQuoteBlock(validSubmission.body);
  const maxQuoteLength = Math.max(0, DESCRIPTION_MAX - footer.length);
  const description = `${quotedBody.slice(0, maxQuoteLength)}${footer}`;

  const input: CreateTaskInput = {
    projectId: form.projectId,
    title: validSubmission.title.slice(0, TASK_TITLE_MAX),
    description,
    pendingApproval: true,
    labels: mergeFeedbackLabels(form.defaultLabels),
  };

  if (form.defaultPriority !== undefined) {
    input.priority = form.defaultPriority;
  }

  return parseOrThrow(CreateTaskInputSchema, input, "taskFromFeedbackSubmission");
}

// ---------------------------------------------------------------------------
// Entity Builders & Helpers
// ---------------------------------------------------------------------------

/**
 * Generates a URL-safe random public ID (32 hex chars from a UUIDv7 pair) using `RuntimeDeps`.
 */
export function generateFeedbackPublicId(deps: RuntimeDeps = defaultRuntimeDeps): string {
  const partA = deps.generateId().replaceAll("-", "");
  return partA.slice(0, 24);
}

export interface FeedbackBlockedIpConfig {
  readonly blockedIpHashes?: readonly string[] | undefined;
  readonly fields?:
    | {
        readonly blockedIpHashes?: readonly string[] | undefined;
      }
    | undefined;
}

/**
 * Returns true if the given `ipHash` is in the form's blocked IP hashes list.
 */
export function isFeedbackIpHashBlocked(
  form: FeedbackBlockedIpConfig,
  ipHash: string | undefined,
): boolean {
  if (!ipHash) return false;
  const trimmed = ipHash.trim().toLowerCase();
  if (trimmed.length === 0) return false;
  const topLevel = form.blockedIpHashes ?? [];
  const fieldLevel = form.fields?.blockedIpHashes ?? [];
  return (
    topLevel.some((h) => h.toLowerCase() === trimmed) ||
    fieldLevel.some((h) => h.toLowerCase() === trimmed)
  );
}

export function cloneFeedbackForm(form: FeedbackForm): FeedbackForm {
  const copy: FeedbackForm = {
    ...form,
    fields: {
      email: form.fields.email,
      name: form.fields.name,
      categories: [...form.fields.categories],
      ...(form.fields.bannedWords !== undefined
        ? { bannedWords: [...form.fields.bannedWords] }
        : {}),
      ...(form.fields.blockedIpHashes !== undefined
        ? { blockedIpHashes: [...form.fields.blockedIpHashes] }
        : {}),
    },
    allowedOrigins: [...form.allowedOrigins],
  };
  if (form.defaultLabels !== undefined) copy.defaultLabels = [...form.defaultLabels];
  if (form.bannedWords !== undefined) copy.bannedWords = [...form.bannedWords];
  if (form.blockedIpHashes !== undefined) copy.blockedIpHashes = [...form.blockedIpHashes];
  return copy;
}

export function cloneFeedbackEntry(entry: FeedbackEntry): FeedbackEntry {
  return { ...entry };
}

export function buildFeedbackForm(
  input: CreateFeedbackFormInput,
  orgId: string,
  deps: RuntimeDeps = defaultRuntimeDeps,
): FeedbackForm {
  const validOrgId = parseOrThrow(IdSchema, orgId, "createFeedbackForm orgId");
  const parsed = parseOrThrow(CreateFeedbackFormInputSchema, input, "createFeedbackForm");
  const now = toTimestamp(deps.clock());

  const mergedBlockedIpHashes = [
    ...(parsed.fields.blockedIpHashes ?? []),
    ...(parsed.blockedIpHashes ?? []),
  ];
  const uniqueBlockedIpHashes =
    mergedBlockedIpHashes.length > 0 ? [...new Set(mergedBlockedIpHashes)] : undefined;

  const form: FeedbackForm = {
    id: parsed.id ?? deps.generateId(),
    orgId: parsed.orgId ?? validOrgId,
    projectId: parsed.projectId,
    publicId: parsed.publicId ?? generateFeedbackPublicId(deps),
    name: parsed.name,
    title: parsed.title ?? parsed.name,
    intro: parsed.intro,
    enabled: parsed.enabled,
    fields: {
      email: parsed.fields.email,
      name: parsed.fields.name,
      categories: [...parsed.fields.categories],
      ...(parsed.fields.bannedWords !== undefined && parsed.fields.bannedWords.length > 0
        ? { bannedWords: [...parsed.fields.bannedWords] }
        : {}),
      ...(uniqueBlockedIpHashes !== undefined
        ? { blockedIpHashes: [...uniqueBlockedIpHashes] }
        : {}),
    },
    allowedOrigins: [...parsed.allowedOrigins],
    turnstile: parsed.turnstile,
    thankYouText: parsed.thankYouText,
    submissionCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  if (parsed.defaultLabels !== undefined && parsed.defaultLabels.length > 0) {
    form.defaultLabels = [...parsed.defaultLabels];
  }
  if (parsed.defaultPriority !== undefined) {
    form.defaultPriority = parsed.defaultPriority;
  }
  if (parsed.accentColor !== undefined) {
    form.accentColor = parsed.accentColor;
  }
  if (parsed.bannedWords !== undefined && parsed.bannedWords.length > 0) {
    form.bannedWords = [...parsed.bannedWords];
  }
  if (uniqueBlockedIpHashes !== undefined) {
    form.blockedIpHashes = [...uniqueBlockedIpHashes];
  }
  if (parsed.createdBy !== undefined) {
    form.createdBy = parsed.createdBy;
  }

  return parseOrThrow(FeedbackFormSchema, form, "createFeedbackForm result");
}

export function applyFeedbackFormPatch(
  form: FeedbackForm,
  patch: UpdateFeedbackFormInput,
  now: Date,
): FeedbackForm {
  const parsed = parseOrThrow(UpdateFeedbackFormInputSchema, patch, "updateFeedbackForm");
  const candidate = toTimestamp(now);
  const updatedAt = Date.parse(candidate) >= Date.parse(form.updatedAt) ? candidate : form.updatedAt;

  const defaultLabels =
    parsed.defaultLabels === undefined
      ? form.defaultLabels
      : parsed.defaultLabels === null || parsed.defaultLabels.length === 0
        ? undefined
        : [...parsed.defaultLabels];

  const defaultPriority =
    parsed.defaultPriority === undefined
      ? form.defaultPriority
      : (parsed.defaultPriority ?? undefined);

  const accentColor =
    parsed.accentColor === undefined
      ? form.accentColor
      : (parsed.accentColor ?? undefined);

  const bannedWords =
    parsed.bannedWords === undefined
      ? form.bannedWords
      : parsed.bannedWords === null || parsed.bannedWords.length === 0
        ? undefined
        : [...parsed.bannedWords];

  let blockedIpHashes: string[] | undefined;
  if (parsed.blockedIpHashes !== undefined) {
    blockedIpHashes =
      parsed.blockedIpHashes === null || parsed.blockedIpHashes.length === 0
        ? undefined
        : [...parsed.blockedIpHashes];
  } else if (parsed.fields?.blockedIpHashes !== undefined) {
    blockedIpHashes =
      parsed.fields.blockedIpHashes.length === 0
        ? undefined
        : [...parsed.fields.blockedIpHashes];
  } else {
    blockedIpHashes =
      form.blockedIpHashes ?? form.fields.blockedIpHashes
        ? [...(form.blockedIpHashes ?? form.fields.blockedIpHashes ?? [])]
        : undefined;
  }

  const fields: FeedbackFields =
    parsed.fields !== undefined
      ? {
          email: parsed.fields.email,
          name: parsed.fields.name,
          categories: [...parsed.fields.categories],
          ...(parsed.fields.bannedWords !== undefined && parsed.fields.bannedWords.length > 0
            ? { bannedWords: [...parsed.fields.bannedWords] }
            : {}),
          ...(blockedIpHashes !== undefined ? { blockedIpHashes: [...blockedIpHashes] } : {}),
        }
      : {
          ...cloneFeedbackForm(form).fields,
          ...(blockedIpHashes !== undefined ? { blockedIpHashes: [...blockedIpHashes] } : {}),
        };
  if (blockedIpHashes === undefined) {
    delete (fields as { blockedIpHashes?: string[] }).blockedIpHashes;
  }

  const next: FeedbackForm = {
    id: form.id,
    orgId: form.orgId,
    projectId: form.projectId,
    publicId: form.publicId,
    name: parsed.name ?? form.name,
    title: parsed.title ?? form.title,
    intro: parsed.intro ?? form.intro,
    enabled: parsed.enabled ?? form.enabled,
    fields,
    allowedOrigins:
      parsed.allowedOrigins !== undefined ? [...parsed.allowedOrigins] : [...form.allowedOrigins],
    turnstile: parsed.turnstile ?? form.turnstile,
    thankYouText: parsed.thankYouText ?? form.thankYouText,
    submissionCount: form.submissionCount,
    createdAt: form.createdAt,
    updatedAt,
  };

  if (defaultLabels !== undefined) next.defaultLabels = defaultLabels;
  if (defaultPriority !== undefined) next.defaultPriority = defaultPriority;
  if (accentColor !== undefined) next.accentColor = accentColor;
  if (bannedWords !== undefined) next.bannedWords = bannedWords;
  if (blockedIpHashes !== undefined) next.blockedIpHashes = [...blockedIpHashes];
  if (form.lastSubmittedAt !== undefined) next.lastSubmittedAt = form.lastSubmittedAt;
  if (form.createdBy !== undefined) next.createdBy = form.createdBy;

  return parseOrThrow(FeedbackFormSchema, next, "updateFeedbackForm result");
}

export function buildFeedbackEntry(
  input: CreateFeedbackEntryInput,
  deps: RuntimeDeps = defaultRuntimeDeps,
): FeedbackEntry {
  const parsed = parseOrThrow(CreateFeedbackEntryInputSchema, input, "createFeedbackEntry");
  const now = toTimestamp(deps.clock());

  const entry: FeedbackEntry = {
    id: parsed.id ?? deps.generateId(),
    taskId: parsed.taskId,
    formId: parsed.formId,
    orgId: parsed.orgId,
    projectId: parsed.projectId,
    outcome: parsed.outcome,
    spamScore: parsed.spamScore,
    createdAt: now,
  };

  if (parsed.category !== undefined) entry.category = parsed.category;
  if (parsed.submitterEmail !== undefined) entry.submitterEmail = parsed.submitterEmail;
  if (parsed.submitterName !== undefined) entry.submitterName = parsed.submitterName;
  if (parsed.pageUrl !== undefined) entry.pageUrl = parsed.pageUrl;
  if (parsed.ipHash !== undefined) entry.ipHash = parsed.ipHash;
  if (parsed.bodyHash !== undefined) entry.bodyHash = parsed.bodyHash;
  if (parsed.userAgent !== undefined) entry.userAgent = parsed.userAgent;
  if (parsed.reviewedBy !== undefined) entry.reviewedBy = parsed.reviewedBy;
  if (parsed.reviewedAt !== undefined) entry.reviewedAt = parsed.reviewedAt;

  return parseOrThrow(FeedbackEntrySchema, entry, "createFeedbackEntry result");
}
