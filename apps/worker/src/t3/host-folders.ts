import {
  NotFoundError,
  isActiveAgentRunState,
  normalizeHostFolderPath,
  type HostFolderCheckResult,
  type StorageProvider,
  type T3ProjectMapping,
  type T3RemoteProject,
} from "@bitig/core";
import type { T3D1Store } from "@bitig/storage-d1";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { T3McpError, T3_PROJECT_OPERATION_TIMEOUT_MS, type T3CallOptions, type T3McpClient } from "./client";
import { createActiveT3McpClient } from "./service";

/**
 * Host project operations (#BIT-148): check a folder on the connected T3 host, register it as a
 * T3 project and link it to a Bitig project, or unregister it. Bitig never creates, moves or
 * deletes files on the host: registering fails for a missing folder, and T3 keeps the folder on
 * disk when a project is unregistered.
 */

const HTTP_UNPROCESSABLE = 422;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const HTTP_SERVICE_UNAVAILABLE = 503;
const HTTP_GATEWAY_TIMEOUT = 504;
/** T3's failure code when the caller may not change projects (seen in #BIT-148's probe). */
const T3_CAPABILITY_DENIED = "capability_denied";

export type HostFolderErrorCode =
  | "project_already_mapped"
  | "folder_mapped_to_other_project"
  | "folder_already_registered"
  | "t3_project_shared"
  | "project_busy"
  | "t3_access_denied"
  | "t3_rejected"
  | "host_offline"
  | "host_timeout"
  | "aborted";

export class HostFolderError extends Error {
  override readonly name = "HostFolderError";
  readonly code: HostFolderErrorCode;
  readonly status: ContentfulStatusCode;

  constructor(code: HostFolderErrorCode, status: ContentfulStatusCode, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface HostFolderDeps {
  readonly store: T3D1Store;
  readonly storage: StorageProvider;
  readonly encryptionKey: string;
  readonly fetchFn?: typeof fetch | undefined;
  /** Cancels the T3 calls, e.g. when the browser request is aborted. */
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface RegisterHostFolderResult {
  readonly mapping: T3ProjectMapping;
  /** True when this call registered the folder in T3; false when it reused an existing registration. */
  readonly created: boolean;
}

export interface UnregisterHostFolderResult {
  /** False when the project had no T3 mapping, so there was nothing to unregister. */
  readonly unregistered: boolean;
}

function callOptions(deps: HostFolderDeps): T3CallOptions {
  return {
    signal: deps.signal,
    timeoutMs: deps.timeoutMs ?? T3_PROJECT_OPERATION_TIMEOUT_MS,
  };
}

/**
 * Turns a T3 failure into an error the owner can act on. Anything that is not a T3 error (no
 * connection, expired token, …) is rethrown unchanged; those already carry actionable messages.
 */
function toHostFolderError(err: unknown, action: string): unknown {
  if (!(err instanceof T3McpError)) return err;
  switch (err.code) {
    case "connection_error":
      return new HostFolderError(
        "host_offline",
        HTTP_SERVICE_UNAVAILABLE,
        `Could not reach the T3 host to ${action}. Check that T3 is running and reachable, then retry.`,
      );
    case "timeout":
      return new HostFolderError(
        "host_timeout",
        HTTP_GATEWAY_TIMEOUT,
        `The T3 host did not answer in time while trying to ${action}. Retry; a retry never registers the folder twice.`,
      );
    case "aborted":
      return new HostFolderError("aborted", HTTP_SERVICE_UNAVAILABLE, `Cancelled before T3 could ${action}.`);
    default:
      break;
  }
  if (err.t3Code === T3_CAPABILITY_DENIED) {
    return new HostFolderError(
      "t3_access_denied",
      HTTP_BAD_GATEWAY,
      `T3 refused to ${action}: Bitig's connection may not change projects. Reconnect the T3 host with full access in Settings, then retry.`,
    );
  }
  return new HostFolderError(
    "t3_rejected",
    HTTP_UNPROCESSABLE,
    `T3 could not ${action}: ${err.t3Message ?? err.message}`,
  );
}

function findProjectAtPath(projects: readonly T3RemoteProject[], workspaceRoot: string): T3RemoteProject | undefined {
  return projects.find(
    (project) =>
      project.workspaceRoot !== undefined && normalizeHostFolderPath(project.workspaceRoot) === workspaceRoot,
  );
}

async function requireProject(storage: StorageProvider, projectId: string): Promise<{ id: string; name: string }> {
  const project = await storage.getProject(projectId);
  if (!project) {
    throw new NotFoundError("project", projectId);
  }
  return project;
}

async function describeProject(storage: StorageProvider, projectId: string): Promise<string> {
  const project = await storage.getProject(projectId);
  return project ? `"${project.name}"` : "another Bitig project";
}

async function connect(deps: HostFolderDeps): Promise<T3McpClient> {
  return createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
  });
}

/**
 * Reports whether a folder is already registered in T3 and which Bitig project uses it. T3 has
 * no tool that only checks whether a folder exists, so for an unregistered folder this cannot
 * say whether it exists; registering it does (T3 fails for a missing folder).
 *
 * Paths are compared as written: `~/www/app` and `/home/dev/www/app` are not matched, because
 * Bitig cannot know the host user's home directory.
 */
export async function checkHostFolder(deps: HostFolderDeps, workspaceRoot: string): Promise<HostFolderCheckResult> {
  const client = await connect(deps);
  let projects: T3RemoteProject[];
  try {
    projects = await client.listAllProjects(callOptions(deps));
  } catch (err) {
    throw toHostFolderError(err, "list its projects");
  }
  const t3Project = findProjectAtPath(projects, workspaceRoot);
  if (!t3Project) {
    return { workspaceRoot };
  }
  const mappings = await deps.store.listProjectMappings();
  const mapped = mappings.find((mapping) => mapping.t3ProjectId === t3Project.id);
  return {
    workspaceRoot,
    t3Project: { id: t3Project.id, title: t3Project.title },
    ...(mapped ? { mappedProjectId: mapped.projectId } : {}),
  };
}

/**
 * Registers `workspaceRoot` as a T3 project and links it to the Bitig project. Retries are
 * idempotent: when the folder is already registered in T3 and not linked elsewhere (e.g. an
 * earlier attempt registered it but failed before saving the link), the existing T3 project
 * is linked instead of registering it again, so no duplicate T3 project or mapping is made.
 */
export async function registerHostFolder(
  deps: HostFolderDeps,
  projectId: string,
  workspaceRoot: string,
): Promise<RegisterHostFolderResult> {
  const project = await requireProject(deps.storage, projectId);
  const client = await connect(deps);
  const options = callOptions(deps);

  let projects: T3RemoteProject[];
  try {
    projects = await client.listAllProjects(options);
  } catch (err) {
    throw toHostFolderError(err, `check whether ${workspaceRoot} is registered`);
  }
  const atPath = findProjectAtPath(projects, workspaceRoot);
  const [existing, mappings] = await Promise.all([
    deps.store.getProjectMapping(projectId),
    deps.store.listProjectMappings(),
  ]);

  if (existing) {
    if (atPath?.id === existing.t3ProjectId) {
      return { mapping: existing, created: false };
    }
    throw new HostFolderError(
      "project_already_mapped",
      HTTP_CONFLICT,
      `This project is already linked to the T3 project "${existing.t3ProjectTitle}". Unregister or unlink it first.`,
    );
  }

  if (atPath) {
    const other = mappings.find((mapping) => mapping.t3ProjectId === atPath.id);
    if (other) {
      throw new HostFolderError(
        "folder_mapped_to_other_project",
        HTTP_CONFLICT,
        `${workspaceRoot} is already registered in T3 and linked to ${await describeProject(deps.storage, other.projectId)}. Choose another folder, or unlink that project first.`,
      );
    }
    const mapping = await deps.store.upsertProjectMapping({
      projectId,
      t3ProjectId: atPath.id,
      t3ProjectTitle: atPath.title,
    });
    return { mapping, created: false };
  }

  let registered: T3RemoteProject;
  try {
    registered = await client.registerProject({ title: project.name, workspaceRoot }, options);
  } catch (err) {
    const mapped = toHostFolderError(err, `register ${workspaceRoot}`);
    if (mapped instanceof HostFolderError && mapped.code === "t3_rejected") {
      // The folder was not registered when we listed projects, so T3 rejected it for another
      // reason: most often a missing folder, or a `~/` spelling of a folder that T3 lists by
      // its absolute path.
      throw new HostFolderError(
        "t3_rejected",
        HTTP_UNPROCESSABLE,
        `${mapped.message.replace(/\.$/u, "")}. Check that the folder exists on the host (Bitig never creates it). If it is already registered in T3 under its absolute path, enter that path instead.`,
      );
    }
    throw mapped;
  }

  const mapping = await deps.store.upsertProjectMapping({
    projectId,
    t3ProjectId: registered.id,
    t3ProjectTitle: registered.title,
  });
  return { mapping, created: true };
}

/**
 * Unregisters the Bitig project's T3 project and removes the link. T3 keeps the folder on disk,
 * and Bitig never touches host files. Refused while the project has active T3 sessions, or when
 * another Bitig project is linked to the same T3 project.
 */
export async function unregisterHostFolder(
  deps: HostFolderDeps,
  projectId: string,
  input: { readonly force?: boolean | undefined },
): Promise<UnregisterHostFolderResult> {
  await requireProject(deps.storage, projectId);
  const mapping = await deps.store.getProjectMapping(projectId);
  if (!mapping) {
    return { unregistered: false };
  }

  const [mappings, runs, threads] = await Promise.all([
    deps.store.listProjectMappings(),
    deps.store.listAgentRuns(),
    deps.store.listProjectThreads(projectId),
  ]);
  const shared = mappings.find(
    (other) => other.projectId !== projectId && other.t3ProjectId === mapping.t3ProjectId,
  );
  if (shared) {
    throw new HostFolderError(
      "t3_project_shared",
      HTTP_CONFLICT,
      `The T3 project "${mapping.t3ProjectTitle}" is also linked to ${await describeProject(deps.storage, shared.projectId)}. Unlink this project instead of unregistering the folder.`,
    );
  }
  const activeSessions =
    runs.filter((run) => run.t3ProjectId === mapping.t3ProjectId && isActiveAgentRunState(run.state)).length +
    threads.filter((thread) => isActiveAgentRunState(thread.state)).length;
  if (activeSessions > 0) {
    throw new HostFolderError(
      "project_busy",
      HTTP_CONFLICT,
      `This project has ${String(activeSessions)} active T3 session(s). Stop them before unregistering the folder.`,
    );
  }

  const client = await connect(deps);
  const options = callOptions(deps);
  try {
    // A project already removed in T3 (by hand, or by an earlier attempt that failed before
    // unlinking) only needs its link removed.
    const projects = await client.listAllProjects(options);
    if (projects.some((project) => project.id === mapping.t3ProjectId)) {
      await client.unregisterProject(mapping.t3ProjectId, { force: input.force }, options);
    }
  } catch (err) {
    throw toHostFolderError(err, `unregister the T3 project "${mapping.t3ProjectTitle}"`);
  }

  await deps.store.deleteProjectMapping(projectId);
  return { unregistered: true };
}
