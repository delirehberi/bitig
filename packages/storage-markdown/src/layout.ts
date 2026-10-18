/**
 * On-disk layout of a Markdown data directory. The path is the identity:
 *
 *   <root>/<projectId>/_project.yaml
 *   <root>/<projectId>/<taskId>.md
 *
 * IDs are never stored inside files. Only names that are valid UUIDv7 (plus
 * the `.md` suffix for tasks) are treated as entities; everything else in the
 * data directory (dotfiles, `.git`, notes) is ignored.
 *
 * Paths handed to `FileSystemPort` are relative, `/`-separated and built
 * exclusively from validated IDs and the constants below, so they cannot
 * contain `..`, absolute prefixes or separators supplied by a caller.
 */
import { IdSchema } from "@bitig/core";

export const PROJECT_FILE_NAME = "_project.yaml";
export const TASK_FILE_EXTENSION = ".md";
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

