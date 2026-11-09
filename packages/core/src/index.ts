/**
 * @bitig/core — domain types and the StorageProvider contract.
 *
 * Environment-neutral: no Node, DOM or Workers APIs, so it can be bundled into
 * the Worker, the browser app and the CLI alike. The contract test suite lives
 * in the separate `@bitig/core/testing` entry point so vitest never reaches
 * production bundles.
 */

export const STORAGE_MODES = ["local", "cloudflare"] as const;

export type StorageMode = (typeof STORAGE_MODES)[number];

export function isStorageMode(value: unknown): value is StorageMode {
  return typeof value === "string" && (STORAGE_MODES as readonly string[]).includes(value);
}

export * from "./domain/constants";
export * from "./domain/schemas";
export * from "./domain/t3";
export * from "./domain/host-folder";
export * from "./domain/realtime";
export * from "./domain/mcp-tokens";
export * from "./domain/users";
export * from "./domain/organisations";
export * from "./domain/permissions";
export type * from "./domain/types";
export { buildCheckpoint, compareCheckpoints, buildExecutionContext } from "./domain/checkpoints";
export { PROJECT_WORK_LIMITS, selectProjectWork, buildProjectWorkContext } from "./domain/project-work";
export type { ProjectWorkSummary, ProjectWorkContext } from "./domain/project-work";
export {
  appendAttachmentsToCommentBody,
  assertTaskAttachmentQuota,
  buildAttachment,
  cloneAttachment,
  cloneAttachmentContent,
  compareAttachments,
  decodeBase64,
  decodeUtf8,
  encodeBase64,
  encodeUtf8,
  extractCommentAttachmentReferences,
  formatCommentAttachmentMarkdown,
  formatT3CommentAttachmentContext,
  inferAttachmentMimeType,
  isImageAttachmentMimeType,
  isMarkdownAttachment,
  isTextAttachmentMimeType,
  normalizeAttachmentMimeType,
  stripAttachmentData,
} from "./domain/attachments";
export type { CommentAttachmentReference, T3CommentAttachmentInfo } from "./domain/attachments";
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
  touchTaskEntity,
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
  withTaskAttachmentCount,
  withTaskCommentCount,
} from "./domain/entities";
export type { ActorUserContext } from "./domain/entities";
export {
  classifyWebhookPayload,
  extractTaskFromWebhookPayload,
  normalizeExternalPriority,
  resolveJsonPath,
} from "./domain/webhooks";
export { resolveSentryTasks } from "./domain/webhook-resolution";
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
