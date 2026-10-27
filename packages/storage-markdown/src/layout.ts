/**
 * On-disk layout of a Markdown data directory. The path is the identity:
 *
 *   <root>/<projectId>/_project.yaml
 *   <root>/<projectId>/<taskId>.md
 *   <root>/<projectId>/<taskId>.comments/<commentId>.md
 *   <root>/<projectId>/<taskId>.checkpoints/<checkpointId>.json
 *
 * IDs are never stored inside files. Only names that are valid UUIDv7 (plus
 * the `.md` suffix for tasks and comments, `.comments` for a task's comment
 * directory) are treated as entities; everything else in the
 * data directory (dotfiles, `.git`, notes) is ignored.
 *
 * Paths handed to `FileSystemPort` are relative, `/`-separated and built
 * exclusively from validated IDs and the constants below, so they cannot
 * contain `..`, absolute prefixes or separators supplied by a caller.
 */
import { IdSchema } from "@bitig/core";

export const PROJECT_FILE_NAME = "_project.yaml";
export const TASK_FILE_EXTENSION = ".md";
export const COMMENT_FILE_EXTENSION = ".md";
export const WEBHOOK_FILE_EXTENSION = ".yaml";
export const CHECKPOINT_FILE_EXTENSION = ".json";
/** A task's execution checkpoints live in a directory next to its file, one file per step. */
export const CHECKPOINTS_DIR_SUFFIX = ".checkpoints";
/** A task's comments live in a directory next to its file, one file per comment. */
export const COMMENTS_DIR_SUFFIX = ".comments";
/** A project's webhooks live in `_webhooks/<webhookId>.yaml` inside its directory. */
export const WEBHOOKS_DIR_NAME = "_webhooks";
export const PATH_SEPARATOR = "/";

/** Relative path of the data directory itself. */
export const ROOT_PATH = "";

export function isEntityId(name: string): boolean {
  return IdSchema.safeParse(name).success;
}

/** Returns the task ID encoded in a file name, or `null` if the name is not a task file. */
export function taskIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(TASK_FILE_EXTENSION)) return null;
  const id = fileName.slice(0, -TASK_FILE_EXTENSION.length);
  return isEntityId(id) ? id : null;
}

/** Returns the comment ID encoded in a file name, or `null` if the name is not a comment file. */
export function commentIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(COMMENT_FILE_EXTENSION)) return null;
  const id = fileName.slice(0, -COMMENT_FILE_EXTENSION.length);
  return isEntityId(id) ? id : null;
}

/** Returns the task ID encoded in a directory name, or `null` if it is not a comments directory. */
export function taskIdFromCommentsDirName(dirName: string): string | null {
  if (!dirName.endsWith(COMMENTS_DIR_SUFFIX)) return null;
  const id = dirName.slice(0, -COMMENTS_DIR_SUFFIX.length);
  return isEntityId(id) ? id : null;
}

/** Returns the checkpoint ID encoded in a file name, or `null` if the name is not a checkpoint file. */
export function checkpointIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(CHECKPOINT_FILE_EXTENSION)) return null;
  const id = fileName.slice(0, -CHECKPOINT_FILE_EXTENSION.length);
  return isEntityId(id) ? id : null;
}

/** Returns the webhook ID encoded in a file name, or `null` if the name is not a webhook file. */
export function webhookIdFromFileName(fileName: string): string | null {
  if (!fileName.endsWith(WEBHOOK_FILE_EXTENSION)) return null;
  const id = fileName.slice(0, -WEBHOOK_FILE_EXTENSION.length);
  return isEntityId(id) ? id : null;
}

function assertEntityId(id: string): void {
  // Callers validate IDs before building paths; this is a last line of defence
  // against path traversal should that ever be skipped.
  if (!isEntityId(id)) throw new TypeError(`refusing to build a path from invalid id ${JSON.stringify(id)}`);
}

export function projectDirPath(projectId: string): string {
  assertEntityId(projectId);
  return projectId;
}

export function projectFilePath(projectId: string): string {
  return `${projectDirPath(projectId)}${PATH_SEPARATOR}${PROJECT_FILE_NAME}`;
}

export function taskFilePath(projectId: string, taskId: string): string {
  assertEntityId(taskId);
  return `${projectDirPath(projectId)}${PATH_SEPARATOR}${taskId}${TASK_FILE_EXTENSION}`;
}


export function commentsDirPath(projectId: string, taskId: string): string {
  assertEntityId(taskId);
  return `${projectDirPath(projectId)}${PATH_SEPARATOR}${taskId}${COMMENTS_DIR_SUFFIX}`;
}

export function commentFilePath(projectId: string, taskId: string, commentId: string): string {
  assertEntityId(commentId);
  return `${commentsDirPath(projectId, taskId)}${PATH_SEPARATOR}${commentId}${COMMENT_FILE_EXTENSION}`;
}

export function checkpointsDirPath(projectId: string, taskId: string): string {
  assertEntityId(taskId);
  return `${projectDirPath(projectId)}${PATH_SEPARATOR}${taskId}${CHECKPOINTS_DIR_SUFFIX}`;
}

export function checkpointFilePath(projectId: string, taskId: string, checkpointId: string): string {
  assertEntityId(checkpointId);
  return `${checkpointsDirPath(projectId, taskId)}${PATH_SEPARATOR}${checkpointId}${CHECKPOINT_FILE_EXTENSION}`;
}

export function webhooksDirPath(projectId: string): string {
  return `${projectDirPath(projectId)}${PATH_SEPARATOR}${WEBHOOKS_DIR_NAME}`;
}

export function webhookFilePath(projectId: string, webhookId: string): string {
  assertEntityId(webhookId);
  return `${webhooksDirPath(projectId)}${PATH_SEPARATOR}${webhookId}${WEBHOOK_FILE_EXTENSION}`;
}
