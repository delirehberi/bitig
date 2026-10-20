/**
 * Converts between domain entities and their file representations.
 *
 * Files never contain `id`, `projectId` or `taskId`: they come from the path
 * (see `layout.ts`). Known keys are validated against the core schemas; unknown
 * keys a user added by hand are stripped on read and therefore disappear on
 * the next write. Anything unparseable surfaces as a `StorageError` with
 * reason `corrupt` naming the file; nothing is skipped silently.
 */
import {
  CommentSchema,
  ProjectSchema,
  StorageError,
  TaskSchema,
  ValidationError,
  WebhookSchema,
  parseOrThrow,
  type Comment,
  type Project,
  type Task,
  type Webhook,
} from "@bitig/core";
import { z } from "zod";
import {
  FrontmatterError,
  parseFrontmatter,
  parseYamlMapping,
  stringifyFrontmatter,
  stringifyYamlMapping,
} from "./frontmatter";

/** `z.object` (not `strictObject`) strips unknown keys instead of rejecting them. */
const ProjectFileSchema = z.object(ProjectSchema.shape).omit({ id: true });
const TaskFileSchema = z.object(TaskSchema.shape).omit({ id: true, projectId: true, description: true });

const CommentFileSchema = z.object(CommentSchema.shape).omit({ id: true, taskId: true, body: true });
const WebhookFileSchema = z.object(WebhookSchema.shape).omit({ id: true, projectId: true });

type CommentFileData = z.output<typeof CommentFileSchema>;
type ProjectFileData = z.output<typeof ProjectFileSchema>;
type TaskFileData = z.output<typeof TaskFileSchema>;
type WebhookFileData = z.output<typeof WebhookFileSchema>;

/** Field order in written files; stable order keeps diffs minimal. */
const PROJECT_KEY_ORDER = [
  "name",
  "key",
  "description",
  "kind",
  "archived",
  "resources",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof ProjectFileData)[];
const TASK_KEY_ORDER = [
  "number",
  "title",
  "status",
  "isPublic",
  "priority",
  "dueDate",
  "labels",
  "order",
  "checklist",
  "needsHuman",
  "createdBy",
  "startedBy",
  "completedBy",
  "updatedBy",
  "activity",
  "startedAt",
  "completedAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof TaskFileData)[];

const COMMENT_KEY_ORDER = ["authorType", "author", "createdAt"] as const satisfies readonly (keyof CommentFileData)[];
const WEBHOOK_KEY_ORDER = [
  "name",
  "provider",
  "token",
  "enabled",
  "mapping",
  "defaultPriority",
  "defaultLabels",
  "triggerCount",
  "lastTriggeredAt",
  "createdAt",
  "updatedAt",
] as const satisfies readonly (keyof WebhookFileData)[];

/** Date-like strings and project keys (`NO`, `ON`) are quoted so YAML 1.1 readers never coerce them. */
const QUOTED_KEYS: ReadonlySet<string> = new Set([
  "startedAt",
  "completedAt",
  "lastTriggeredAt",
  "createdAt",
  "updatedAt",
  "dueDate",
  "key",
  "token",
]);

/** Upper bound on a single file in UTF-16 code units, well above the largest valid entity. */
export const MAX_FILE_CHARS = 1024 * 1024;

/** Copies `order` keys in sequence, omitting undefined values. Keys not listed (`id`, `projectId`) are dropped. */
function ordered<K extends string>(source: Partial<Record<K, unknown>>, order: readonly K[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of order) {
    const value = source[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function corrupt(location: string, error: unknown): StorageError {
  if (error instanceof FrontmatterError || error instanceof ValidationError) {
    return new StorageError("corrupt", error.message, { location, cause: error });
  }
  return new StorageError("corrupt", "unreadable file", { location, cause: error });
}

function assertSize(text: string, location: string): void {
  if (text.length > MAX_FILE_CHARS) {
    throw new StorageError("corrupt", `file exceeds ${String(MAX_FILE_CHARS)} characters`, { location });
  }
}

export function encodeProject(project: Project): string {
  return stringifyYamlMapping(ordered(project, PROJECT_KEY_ORDER), QUOTED_KEYS);
}

export function decodeProject(id: string, text: string, location: string): Project {
  assertSize(text, location);
  try {
    const fields = parseOrThrow(ProjectFileSchema, parseYamlMapping(text), "project file");
    return parseOrThrow(ProjectSchema, { id, ...fields }, "project file");
  } catch (error) {
    throw corrupt(location, error);
  }
}

export function encodeTask(task: Task): string {
  return stringifyFrontmatter(ordered(task, TASK_KEY_ORDER), task.description, QUOTED_KEYS);
}

export function decodeTask(projectId: string, id: string, text: string, location: string): Task {
  assertSize(text, location);
  try {
    const { data, body } = parseFrontmatter(text);
    const fields = parseOrThrow(TaskFileSchema, data, "task file");
    return parseOrThrow(TaskSchema, { ...fields, id, projectId, description: body }, "task file");
  } catch (error) {
    throw corrupt(location, error);
  }
}

/** A comment is a Markdown file: who wrote it and when in the frontmatter, the comment as the body. */
export function encodeComment(comment: Comment): string {
  return stringifyFrontmatter(ordered(comment, COMMENT_KEY_ORDER), comment.body, QUOTED_KEYS);
}

export function decodeComment(taskId: string, id: string, text: string, location: string): Comment {
  assertSize(text, location);
  try {
    const { data, body } = parseFrontmatter(text);
    const fields = parseOrThrow(CommentFileSchema, data, "comment file");
    return parseOrThrow(CommentSchema, { ...fields, id, taskId, body }, "comment file");
  } catch (error) {
    throw corrupt(location, error);
  }
}

export function encodeWebhook(webhook: Webhook): string {
  return stringifyYamlMapping(ordered(webhook, WEBHOOK_KEY_ORDER), QUOTED_KEYS);
}

export function decodeWebhook(projectId: string, id: string, text: string, location: string): Webhook {
  assertSize(text, location);
  try {
    const fields = parseOrThrow(WebhookFileSchema, parseYamlMapping(text), "webhook file");
    return parseOrThrow(WebhookSchema, { ...fields, id, projectId }, "webhook file");
  } catch (error) {
    throw corrupt(location, error);
  }
}
