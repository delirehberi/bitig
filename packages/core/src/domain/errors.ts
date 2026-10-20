import type { z } from "zod";

export const ERROR_CODES = {
  notFound: "NOT_FOUND",
  validation: "VALIDATION",
  storage: "STORAGE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Base class for every domain error raised by core and storage adapters. */
export class BitigError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BitigError";
    this.code = code;
  }
}

export type EntityKind = "project" | "task" | "comment";

export class NotFoundError extends BitigError {
  readonly entity: EntityKind;
  readonly id: string;

  constructor(entity: EntityKind, id: string, options?: ErrorOptions) {
    super(ERROR_CODES.notFound, `${entity} ${id} not found`, options);
    this.name = "NotFoundError";
    this.entity = entity;
    this.id = id;
  }
}

export class ValidationError extends BitigError {
  readonly issues: readonly z.core.$ZodIssue[];

  constructor(context: string, issues: readonly z.core.$ZodIssue[], options?: ErrorOptions) {
    super(ERROR_CODES.validation, `${context}: ${formatIssues(issues)}`, options);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

/**
 * Why a storage adapter could not complete an operation:
 * - `corrupt`: persisted data exists but cannot be parsed or fails validation.
 * - `io`: the underlying medium (filesystem, database, relay) failed.
 * - `lock`: exclusive access could not be obtained in time.
 */
export const STORAGE_ERROR_REASONS = ["corrupt", "io", "lock"] as const;
export type StorageErrorReason = (typeof STORAGE_ERROR_REASONS)[number];

export interface StorageErrorOptions extends ErrorOptions {
  /** Adapter-relative location of the offending record (file path, row key). */
  readonly location?: string;
}

/** Persistence failure that is neither invalid caller input nor a missing entity. */
export class StorageError extends BitigError {
  readonly reason: StorageErrorReason;
  readonly location: string | undefined;

  constructor(reason: StorageErrorReason, message: string, options?: StorageErrorOptions) {
    const location = options?.location;
    super(ERROR_CODES.storage, location === undefined ? message : `${location}: ${message}`, options);
    this.name = "StorageError";
    this.reason = reason;
    this.location = location;
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  if (issues.length === 0) return "invalid input";
  return issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
    .join("; ");
}

/**
 * Validates `input` against `schema`, throwing a `ValidationError` that names
 * the operation (`context`) on failure. The zod error is kept as `cause`.
 */
export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  input: unknown,
  context: string,
): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ValidationError(context, result.error.issues, { cause: result.error });
}

export function isBitigError(error: unknown): error is BitigError {
  return error instanceof BitigError;
}

