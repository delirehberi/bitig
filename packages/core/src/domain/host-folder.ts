import { z } from "zod";

/**
 * Folder paths on a T3 host that the organisation owner registers as a T3 project (#BIT-148).
 *
 * The owner may enter any absolute path or a path under the host user's home (`~/…`). The
 * suggested location is `<projects root>/<name>`: `/var/www` on managed containers and `~/www`
 * on user-owned hosts. The path is sent to T3 verbatim (after normalisation), so it is
 * validated strictly on the server side: no relative paths, no control characters, no
 * option-like segments that a shell or Git command could read as a flag, and no `.`/`..`
 * segments that would let two spellings name the same folder.
 */
export const HOST_FOLDER_PATH_MAX = 1024;
export const HOST_FOLDER_HOME_PREFIX = "~/";
export const HOST_PROJECTS_ROOT_CONTAINER = "/var/www";
export const HOST_PROJECTS_ROOT_USER = "~/www";

const PATH_SEPARATOR = "/";
const OPTION_PREFIX = "-";
const CURRENT_DIR_SEGMENT = ".";
const PARENT_DIR_SEGMENT = "..";
const C0_CONTROL_LAST = 0x1f;
const DEL = 0x7f;
const C1_CONTROL_LAST = 0x9f;

/** C0 controls, DEL and C1 controls (newlines, NUL, escape sequences, …). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= C0_CONTROL_LAST || (code >= DEL && code <= C1_CONTROL_LAST)) return true;
  }
  return false;
}

export type HostFolderPathIssue =
  | "empty"
  | "too_long"
  | "control_character"
  | "relative"
  | "root"
  | "empty_segment"
  | "dot_segment"
  | "option_like_segment";

const ISSUE_MESSAGES: Record<HostFolderPathIssue, string> = {
  empty: "Enter a folder path",
  too_long: `Folder path must be at most ${String(HOST_FOLDER_PATH_MAX)} characters`,
  control_character: "Folder path must not contain control characters",
  relative: "Folder path must be absolute (start with /) or start with ~/",
  root: "Folder path must name a folder, not the filesystem root or home directory alone",
  empty_segment: "Folder path must not contain empty segments (//)",
  dot_segment: "Folder path must not contain . or .. segments",
  option_like_segment: "Folder path segments must not start with -",
};

export function hostFolderPathIssueMessage(issue: HostFolderPathIssue): string {
  return ISSUE_MESSAGES[issue];
}

/**
 * Removes trailing slashes so `~/www/app/` and `~/www/app` name the same folder. Surrounding
 * whitespace is not trimmed: a path is either valid as typed or rejected.
 */
export function normalizeHostFolderPath(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === PATH_SEPARATOR) {
    end -= 1;
  }
  return path.slice(0, end);
}

/** Returns the first problem with a host folder path, or `undefined` when it is valid. */
export function findHostFolderPathIssue(rawPath: string): HostFolderPathIssue | undefined {
  if (rawPath.trim().length === 0) return "empty";
  if (rawPath.length > HOST_FOLDER_PATH_MAX) return "too_long";
  if (hasControlCharacter(rawPath)) return "control_character";

  const path = normalizeHostFolderPath(rawPath);
  let rest: string;
  if (path.startsWith(HOST_FOLDER_HOME_PREFIX)) {
    rest = path.slice(HOST_FOLDER_HOME_PREFIX.length);
  } else if (path.startsWith(PATH_SEPARATOR)) {
    rest = path.slice(PATH_SEPARATOR.length);
  } else {
    // Covers relative paths, `~user/…`, a bare `~`, and option-like values such as `--force`.
    return path === "~" ? "root" : "relative";
  }
  if (rest.length === 0) return "root";

  for (const segment of rest.split(PATH_SEPARATOR)) {
    if (segment.length === 0) return "empty_segment";
    if (segment === CURRENT_DIR_SEGMENT || segment === PARENT_DIR_SEGMENT) return "dot_segment";
    if (segment.startsWith(OPTION_PREFIX)) return "option_like_segment";
  }
  return undefined;
}

/** A validated, normalised host folder path (no trailing slash). */
export const HostFolderPathSchema = z
  .string()
  .superRefine((value, ctx) => {
    const issue = findHostFolderPathIssue(value);
    if (issue) {
      ctx.addIssue({ code: "custom", message: ISSUE_MESSAGES[issue], params: { issue } });
    }
  })
  .transform(normalizeHostFolderPath);

export const RegisterHostFolderInputSchema = z.strictObject({
  workspaceRoot: HostFolderPathSchema,
});
export type RegisterHostFolderInput = z.input<typeof RegisterHostFolderInputSchema>;

export const UnregisterHostFolderInputSchema = z.strictObject({
  /**
   * T3 refuses to delete a project that still has threads unless `force` is set. The folder on
   * disk is never touched either way.
   */
  force: z.boolean().exactOptional(),
});
export type UnregisterHostFolderInput = z.input<typeof UnregisterHostFolderInputSchema>;

export const CheckHostFolderInputSchema = RegisterHostFolderInputSchema;
export type CheckHostFolderInput = RegisterHostFolderInput;

/**
 * What Bitig can tell about a folder before registering it. T3 has no tool that only checks
 * whether a folder exists, so an unregistered folder's existence is confirmed when
 * `t3_project_create` succeeds (it fails for a missing folder).
 */
export interface HostFolderCheckResult {
  readonly workspaceRoot: string;
  /** The T3 project already registered at this path, if any. */
  readonly t3Project?: { readonly id: string; readonly title: string } | undefined;
  /** The Bitig project already mapped to that T3 project, if any. */
  readonly mappedProjectId?: string | undefined;
}

/** Suggested folder for a new project: `<projects root>/<slug of name>`. */
export function suggestHostFolderPath(projectsRoot: string, projectName: string): string {
  const slug = projectName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug.length > 0 ? `${normalizeHostFolderPath(projectsRoot)}/${slug}` : "";
}
