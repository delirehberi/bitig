import type { z } from "zod";
import type {
  ChecklistItemSchema,
  CommentAuthorTypeSchema,
  CommentSchema,
  CreateCommentInputSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  CreateWebhookInputSchema,
  ProjectKindSchema,
  ProjectResourceSchema,
  ProjectSchema,
  ResourceTypeSchema,
  TaskActivityActionSchema,
  TaskActivityEntrySchema,
  TaskFilterSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskStatusSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
  UpdateWebhookInputSchema,
  WebhookFilterSchema,
  WebhookMappingSchema,
  WebhookProviderSchema,
  WebhookSchema,
  ProjectBundleSchema,
  BackupBundleSchema,
} from "./schemas";

export type Project = z.output<typeof ProjectSchema>;
export type Task = z.output<typeof TaskSchema>;
export type TaskStatus = z.output<typeof TaskStatusSchema>;
export type TaskPriority = z.output<typeof TaskPrioritySchema>;
export type TaskActivityAction = z.output<typeof TaskActivityActionSchema>;
export type TaskActivityEntry = z.output<typeof TaskActivityEntrySchema>;
export type ProjectKind = z.output<typeof ProjectKindSchema>;
export type ChecklistItem = z.output<typeof ChecklistItemSchema>;
export type ProjectResource = z.output<typeof ProjectResourceSchema>;
export type ResourceType = z.output<typeof ResourceTypeSchema>;
export type Comment = z.output<typeof CommentSchema>;
export type CommentAuthorType = z.output<typeof CommentAuthorTypeSchema>;
export type Webhook = z.output<typeof WebhookSchema>;
export type WebhookProvider = z.output<typeof WebhookProviderSchema>;
export type WebhookMapping = z.output<typeof WebhookMappingSchema>;

export type ProjectBundle = z.output<typeof ProjectBundleSchema>;
export type BackupBundle = z.output<typeof BackupBundleSchema>;

/** Caller-facing inputs: fields with defaults are optional. */
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.input<typeof UpdateProjectInputSchema>;
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;
export type UpdateTaskInput = z.input<typeof UpdateTaskInputSchema>;
export type TaskFilter = z.input<typeof TaskFilterSchema>;
export type CreateCommentInput = z.input<typeof CreateCommentInputSchema>;
export type CreateWebhookInput = z.input<typeof CreateWebhookInputSchema>;
export type UpdateWebhookInput = z.input<typeof UpdateWebhookInputSchema>;
export type WebhookFilter = z.input<typeof WebhookFilterSchema>;

/** Inputs after validation and defaulting. */
export type ParsedCreateProjectInput = z.output<typeof CreateProjectInputSchema>;
export type ParsedUpdateProjectInput = z.output<typeof UpdateProjectInputSchema>;
export type ParsedCreateTaskInput = z.output<typeof CreateTaskInputSchema>;
export type ParsedUpdateTaskInput = z.output<typeof UpdateTaskInputSchema>;
export type ParsedCreateCommentInput = z.output<typeof CreateCommentInputSchema>;
export type ParsedCreateWebhookInput = z.output<typeof CreateWebhookInputSchema>;
export type ParsedUpdateWebhookInput = z.output<typeof UpdateWebhookInputSchema>;

