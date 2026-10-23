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
export * from "./domain/realtime";
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
  applyWebhookPatch,
  buildComment,
  buildProject,
  buildTask,
  buildWebhook,
  cloneComment,
  cloneProject,
  cloneTask,
  cloneWebhook,
  compareComments,
  compareProjects,
  compareTasks,
  compareWebhooks,
  completeTaskEntity,
  recordWebhookTriggerEntity,
  renumberTask,
  sortProjectsByActivity,
  withTaskCommentCount,
} from "./domain/entities";
export {
  extractTaskFromWebhookPayload,
  normalizeExternalPriority,
  resolveJsonPath,
} from "./domain/webhooks";
export {
  assertProjectKeyAvailable,
  assignMissingTicketCodes,
  backfillTicketCodes,
  deriveProjectKey,
  findTaskByCode,
  formatTaskCode,
  nextTaskNumber,
  parseTaskCode,
  resolveProjectRef,
  resolveTaskRef,
  resolveTaskRefs,
  taskCode,
  withTaskCodes,
} from "./domain/ticket-codes";
export type { ParsedTaskCode, TaskWithCode, TicketCodeBackfillResult } from "./domain/ticket-codes";
export { extractTaskMentions, taskMentions } from "./domain/mentions";
export { buildMentionIndex, dependencyLinks } from "./domain/task-links";
export {
  assertTaskDependencies,
  blockingTasks,
  hasNewDependencies,
  isTaskBlocked,
  isTaskFinished,
  withoutDependencies,
} from "./domain/dependencies";
export {
  AWAITING_APPROVAL_MESSAGE,
  GATED_STATUSES,
  blockedByFromError,
  blockedTaskError,
  checkNewTaskStatus,
  checkStatusChange,
  findBlockingTasks,
} from "./domain/status-gate";
export type { StatusChangeOptions } from "./domain/status-gate";
export type { DependencyNode } from "./domain/dependencies";
export type { MentionRange, TaskMention } from "./domain/mentions";
export type { DependencyLinks, MentionIndex, TaskLinks, TaskLinkSummary } from "./domain/task-links";
export {
  addChecklistItem,
  checklistProgress,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
  startChecklistItem,
} from "./domain/checklist";
export type { ChecklistProgress } from "./domain/checklist";
export {
  aggregateTimeByProject,
  aggregateTimeByProjectAndWeek,
  exportTimeSpentCsv,
  formatDuration,
  getSubtaskTimings,
  getTaskTiming,
  isoWeekKey,
  listTaskTimeRows,
} from "./domain/time-tracking";
export type {
  ProjectTimeSummary,
  SubtaskTiming,
  TaskTimeRow,
  TaskTiming,
  TimeCsvExportMode,
  WeeklyProjectTimeRow,
} from "./domain/time-tracking";
export {
  LEFT_OFF_IN_PROGRESS_LIMIT,
  LEFT_OFF_RECENT_LIMIT,
  lastTouch,
  whereYouLeftOff,
} from "./domain/where-you-left-off";
export type {
  LeftOffProject,
  LeftOffTask,
  LeftOffTouch,
  TaskTouchKind,
  WhereYouLeftOff,
} from "./domain/where-you-left-off";
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
