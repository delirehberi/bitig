/**
 * @bitig/core — domain types and the StorageProvider contract.
 *
 * Environment-neutral: no Node, DOM or Workers APIs, so it can be bundled into
 * the Worker, the browser app and the CLI alike. The contract test suite lives
 * in the separate `@bitig/core/testing` entry point so vitest never reaches
 * production bundles.
 */

export const STORAGE_MODES = ["local", "cloudflare", "nostr"] as const;

export type StorageMode = (typeof STORAGE_MODES)[number];

export function isStorageMode(value: unknown): value is StorageMode {
  return typeof value === "string" && (STORAGE_MODES as readonly string[]).includes(value);
}

export * from "./domain/constants";
export * from "./domain/schemas";
export type * from "./domain/types";
export {
  BitigError,
  ERROR_CODES,
  NotFoundError,
  STORAGE_ERROR_REASONS,
  StorageError,
  ValidationError,
  isBitigError,
  parseOrThrow,
} from "./domain/errors";
export type {
  EntityKind,
  ErrorCode,
  StorageErrorOptions,
  StorageErrorReason,
} from "./domain/errors";
export {
  applyProjectPatch,
  applyTaskPatch,
  buildProject,
  buildTask,
  cloneTask,
  compareProjects,
  compareTasks,
  completeTaskEntity,
} from "./domain/entities";
export {
  addChecklistItem,
  checklistProgress,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
} from "./domain/checklist";
export type { ChecklistProgress } from "./domain/checklist";
export {
  defaultIdGenerator,
  defaultRuntimeDeps,
  systemClock,
  toTimestamp,
} from "./runtime/ids";
export type { Clock, IdGenerator, RuntimeDeps } from "./runtime/ids";
export { throwIfAborted } from "./storage/abort";
export type { AbortSignalLike } from "./storage/abort";
export type { OperationOptions, StorageProvider } from "./storage/provider";
export { InMemoryStorage } from "./memory/memory-storage";
