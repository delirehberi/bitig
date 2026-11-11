import type {
  AgentRun,
  Comment,
  HostFolderCheckResult,
  ProjectT3Thread,
  ProjectT3ThreadMessagesResponse,
  ProjectT3ThreadsResponse,
  ReplyToT3RunInput,
  SendProjectT3MessageInput,
  StartProjectT3ThreadInput,
  StartT3ThreadInput,
  T3ConnectionStatus,
  T3HostConnectionStatus,
  T3ModelCapability,
  T3ProjectMapping,
  T3RemoteProject,
  T3RunsLiveResponse,
  T3StartOAuthInput,
  T3TaskRunLiveResponse,
  T3WorkspaceBusySession,
  Task,
  UpdateT3HostInput,
} from "@bitig/core";

const BASE_HEADERS = {
  Accept: "application/json",
  "X-Bitig-Request": "true",
} as const;

function baseHeaders(): Record<string, string> {
  try {
    const org = typeof window !== "undefined" ? window.localStorage.getItem("bitig:active-org") : null;
    if (org) {
      return { ...BASE_HEADERS, "X-Bitig-Org": org };
    }
  } catch {
    // ignore storage access errors
  }
  return { ...BASE_HEADERS };
}

export class T3ApiError extends Error {
  override readonly name = "T3ApiError";
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const HTTP_CONFLICT = 409;
const WORKSPACE_BUSY_ERROR = "workspace_busy";
const SAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** A root-checkout launch was refused because another task's T3 session runs there (#BIT-134). */
export class T3WorkspaceBusyApiError extends T3ApiError {
  readonly session: T3WorkspaceBusySession;

  constructor(status: number, message: string, session: T3WorkspaceBusySession) {
    super(status, message);
    this.session = session;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Only http(s) links are rendered, so a malformed server value cannot become a `javascript:` href. */
function safeLink(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(raw).protocol) ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Reads the busy session from a `409 workspace_busy` body; any other body yields `undefined`. */
async function readWorkspaceBusySession(response: Response): Promise<T3WorkspaceBusySession | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON: the caller reports the plain HTTP error instead.
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const { error, session } = body as { error?: unknown; session?: unknown };
  if (error !== WORKSPACE_BUSY_ERROR || !session || typeof session !== "object") return undefined;
  const rec = session as Record<string, unknown>;
  const threadId = optionalString(rec.threadId);
  const state = rec.state;
  if (
    !threadId ||
    (state !== "queued" && state !== "working" && state !== "waiting_for_approval" && state !== "waiting_subagent")
  ) {
    return undefined;
  }
  const taskId = optionalString(rec.taskId);
  const taskCode = optionalString(rec.taskCode);
  const title = optionalString(rec.title);
  const link = safeLink(rec.link);
  return {
    threadId,
    state,
    ...(taskId ? { taskId } : {}),
    ...(taskCode ? { taskCode } : {}),
    ...(title ? { title } : {}),
    ...(link ? { link } : {}),
  };
}

async function parseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      message?: unknown;
      error?: unknown;
      details?: { message?: unknown }[];
    };
    if (typeof body.message === "string" && body.message.trim().length > 0) {
      return body.message;
    }
    const firstDetail = body.details?.[0];
    if (firstDetail && typeof firstDetail.message === "string" && firstDetail.message.trim().length > 0) {
      return firstDetail.message;
    }
    if (typeof body.error === "string" && body.error.trim().length > 0) {
      return body.error;
    }
  } catch {
    // Fall back to status message
  }
  return `${fallback} (HTTP ${String(response.status)})`;
}

export async function fetchT3Connection(signal?: AbortSignal, context?: { projectId?: string; taskId?: string; hostId?: string }): Promise<T3ConnectionStatus> {
  const query = new URLSearchParams(context);
  const response = await fetch(`/api/t3/connection${query.size ? `?${query.toString()}` : ""}`, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 connection"));
  }
  return (await response.json()) as T3ConnectionStatus;
}

/** Lists all connected T3 hosts for the current organisation (#BIT-147, #BIT-152). */
export async function fetchT3Hosts(signal?: AbortSignal): Promise<T3HostConnectionStatus[]> {
  const response = await fetch("/api/t3/hosts", {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 hosts"));
  }
  const body = (await response.json()) as { hosts?: T3HostConnectionStatus[] } | T3HostConnectionStatus[] | null;
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.hosts) ? body.hosts : [];
}

/** Reads a single T3 host connection status (#BIT-147). */
export async function fetchT3Host(hostId: string, signal?: AbortSignal): Promise<T3HostConnectionStatus> {
  const response = await fetch(`/api/t3/hosts/${encodeURIComponent(hostId)}`, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 host"));
  }
  return (await response.json()) as T3HostConnectionStatus;
}

/** Updates a T3 host's label, kind, or projects root (#BIT-147, #BIT-152). Owner only. */
export async function updateT3Host(
  hostId: string,
  input: UpdateT3HostInput,
  signal?: AbortSignal,
): Promise<T3HostConnectionStatus> {
  const response = await fetch(`/api/t3/hosts/${encodeURIComponent(hostId)}`, {
    method: "PATCH",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not update T3 host"));
  }
  return (await response.json()) as T3HostConnectionStatus;
}

/** Disconnects a specific T3 host (#BIT-147, #BIT-152). Refused with 409 while sessions run. Owner only. */
export async function disconnectT3Host(hostId: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`/api/t3/hosts/${encodeURIComponent(hostId)}`, {
    method: "DELETE",
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not disconnect T3 host"));
  }
}

export async function startT3OAuth(
  input: string | T3StartOAuthInput,
): Promise<{ authorizationUrl: string; state: string }> {
  const payload: T3StartOAuthInput = typeof input === "string" ? { mcpUrl: input } : input;
  const response = await fetch("/api/t3/oauth/start", {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not start T3 OAuth"));
  }
  return (await response.json()) as { authorizationUrl: string; state: string };
}

export async function disconnectT3(): Promise<void> {
  const response = await fetch("/api/t3/connection", {
    method: "DELETE",
    headers: baseHeaders(),
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not disconnect T3"));
  }
}

export async function fetchT3RemoteProjects(signal?: AbortSignal, hostId?: string): Promise<T3RemoteProject[]> {
  const query = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
  const response = await fetch(`/api/t3/projects${query}`, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 projects"));
  }
  const body = (await response.json()) as { projects?: T3RemoteProject[] } | T3RemoteProject[] | null;
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.projects) ? body.projects : [];
}

export async function fetchT3Capabilities(signal?: AbortSignal, context?: { projectId?: string; taskId?: string; hostId?: string }): Promise<T3ModelCapability[]> {
  const query = new URLSearchParams(context);
  const response = await fetch(`/api/t3/capabilities${query.size ? `?${query.toString()}` : ""}`, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 capabilities"));
  }
  const body = (await response.json()) as { capabilities: T3ModelCapability[] };
  return body.capabilities;
}

export async function fetchT3ProjectMappings(signal?: AbortSignal): Promise<T3ProjectMapping[]> {
  const response = await fetch("/api/t3/mappings", {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 mappings"));
  }
  const body = (await response.json()) as { mappings?: T3ProjectMapping[] } | T3ProjectMapping[] | null;
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.mappings) ? body.mappings : [];
}

export async function saveT3ProjectMapping(
  projectId: string,
  input: { t3ProjectId: string; t3ProjectTitle: string; hostId?: string; workspaceRoot?: string },
): Promise<T3ProjectMapping> {
  const response = await fetch(`/api/t3/mappings/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not save project mapping"));
  }
  return (await response.json()) as T3ProjectMapping;
}

export async function deleteT3ProjectMapping(projectId: string): Promise<void> {
  const response = await fetch(`/api/t3/mappings/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
    headers: baseHeaders(),
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not remove project mapping"));
  }
}

export interface RegisterHostFolderResponse {
  readonly mapping: T3ProjectMapping;
  /** False when the folder was already registered in T3 and only linked. */
  readonly created: boolean;
}

function hostFolderPath(projectId: string): string {
  return `/api/t3/projects/${encodeURIComponent(projectId)}/host-folder`;
}

/** Registers an existing folder on the T3 host as the project's T3 project (#BIT-148, #BIT-151). Owner only. */
export async function registerT3HostFolder(
  projectId: string,
  workspaceRoot: string,
  signal?: AbortSignal,
  hostId?: string,
): Promise<RegisterHostFolderResponse> {
  const response = await fetch(hostFolderPath(projectId), {
    method: "PUT",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ workspaceRoot, ...(hostId ? { hostId } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not register the folder in T3"));
  }
  return (await response.json()) as RegisterHostFolderResponse;
}

/**
 * Unregisters the project's T3 project and removes the link. The folder stays on the host.
 * `force` is needed when the T3 project still has threads.
 */
export async function unregisterT3HostFolder(
  projectId: string,
  options?: { readonly force?: boolean; readonly signal?: AbortSignal },
): Promise<{ readonly unregistered: boolean }> {
  const query = options?.force ? "?force=true" : "";
  const response = await fetch(`${hostFolderPath(projectId)}${query}`, {
    method: "DELETE",
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not unregister the folder in T3"));
  }
  return (await response.json()) as { unregistered: boolean };
}

/** Whether a folder is already registered in T3, and which Bitig project uses it. Owner only. */
export async function checkT3HostFolder(
  workspaceRoot: string,
  signal?: AbortSignal,
  hostId?: string,
): Promise<HostFolderCheckResult> {
  const response = await fetch("/api/t3/host-folders/check", {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ workspaceRoot, ...(hostId ? { hostId } : {}) }),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not check the folder in T3"));
  }
  return (await response.json()) as HostFolderCheckResult;
}

export async function fetchT3Runs(signal?: AbortSignal): Promise<T3RunsLiveResponse> {
  const response = await fetch("/api/t3/runs", {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 sessions"));
  }
  const body = (await response.json()) as Partial<T3RunsLiveResponse> | null;
  return {
    runs: Array.isArray(body?.runs) ? body.runs : [],
    ...(Array.isArray(body?.activeSessions) ? { activeSessions: body.activeSessions } : {}),
  };
}

export async function fetchTaskT3Run(
  taskId: string,
  signal?: AbortSignal,
): Promise<T3TaskRunLiveResponse> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/t3-run`, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 thread status"));
  }
  return (await response.json()) as T3TaskRunLiveResponse;
}

export async function dispatchTaskT3Run(taskId: string): Promise<T3TaskRunLiveResponse> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/t3-run/dispatch`, {
    method: "POST",
    headers: baseHeaders(),
    credentials: "same-origin",
  });
  if (!response.ok) {
    const busySession =
      response.status === HTTP_CONFLICT ? await readWorkspaceBusySession(response.clone()) : undefined;
    const message = await parseErrorMessage(response, "Could not dispatch queued T3 thread");
    if (busySession) {
      throw new T3WorkspaceBusyApiError(response.status, message, busySession);
    }
    throw new T3ApiError(response.status, message);
  }
  return (await response.json()) as T3TaskRunLiveResponse;
}

export async function startTaskT3Run(
  taskId: string,
  input: StartT3ThreadInput = {},
): Promise<{ run: AgentRun; task: Task; code?: string | undefined }> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/t3-run`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const busySession =
      response.status === HTTP_CONFLICT ? await readWorkspaceBusySession(response.clone()) : undefined;
    const message = await parseErrorMessage(response, "Could not start T3 thread");
    if (busySession) {
      throw new T3WorkspaceBusyApiError(response.status, message, busySession);
    }
    throw new T3ApiError(response.status, message);
  }
  return (await response.json()) as { run: AgentRun; task: Task; code?: string | undefined };
}

export async function stopTaskT3Run(taskId: string): Promise<T3TaskRunLiveResponse> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/t3-run/stop`, {
    method: "POST",
    headers: baseHeaders(),
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not stop T3 thread"));
  }
  return (await response.json()) as T3TaskRunLiveResponse;
}

export async function respondToTaskT3PendingRequest(
  taskId: string,
  input: { requestId: string; answers: Record<string, string | string[]> },
): Promise<T3TaskRunLiveResponse> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/t3-run/respond`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not send answer to T3 thread"));
  }
  return (await response.json()) as T3TaskRunLiveResponse;
}

export interface ReplyToTaskT3RunResult {
  readonly comment: Comment;
  readonly switchComment?: Comment | undefined;
  readonly run: AgentRun;
}

/**
 * Saves a reply as a comment and sends it to the task's T3 thread, switching the thread's model first
 * when `modelSelection` differs from it (#BIT-119). A 409 means the thread is mid-turn.
 */
export async function replyToTaskT3Run(taskId: string, input: ReplyToT3RunInput): Promise<ReplyToTaskT3RunResult> {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/t3-run/reply`, {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not send reply to T3 thread"));
  }
  return (await response.json()) as ReplyToTaskT3RunResult;
}

function projectThreadsPath(projectId: string): string {
  return `/api/t3/projects/${encodeURIComponent(projectId)}/threads`;
}

/** Lists the project's Bitig-started T3 threads (#BIT-127), newest first, with live state. */
export async function fetchProjectT3Threads(projectId: string, signal?: AbortSignal): Promise<ProjectT3Thread[]> {
  const response = await fetch(projectThreadsPath(projectId), {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load project T3 threads"));
  }
  const body = (await response.json()) as Partial<ProjectT3ThreadsResponse> | null;
  return Array.isArray(body?.threads) ? body.threads : [];
}

/** Starts a T3 thread for the project without a task (#BIT-127). */
export async function startProjectT3Thread(
  projectId: string,
  input: StartProjectT3ThreadInput,
  signal?: AbortSignal,
): Promise<ProjectT3Thread> {
  const response = await fetch(projectThreadsPath(projectId), {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not start T3 thread"));
  }
  return (await response.json()) as ProjectT3Thread;
}

/** Settles a project thread on its host and removes it from Bitig's open list. */
export async function settleProjectT3Thread(
  projectId: string,
  threadId: string,
  signal?: AbortSignal,
  hostId?: string,
): Promise<void> {
  const hostQuery = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
  const response = await fetch(`${projectThreadsPath(projectId)}/${encodeURIComponent(threadId)}/settle${hostQuery}`, {
    method: "POST",
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not settle T3 thread"));
  }
}

/**
 * Sends a follow-up to a project-level T3 thread, switching its model first when `modelSelection`
 * differs (#BIT-127). A 409 means the thread is mid-turn.
 */
export async function sendProjectT3Message(
  projectId: string,
  threadId: string,
  input: SendProjectT3MessageInput,
  signal?: AbortSignal,
  hostId?: string,
): Promise<ProjectT3Thread> {
  const hostQuery = hostId ? `?hostId=${encodeURIComponent(hostId)}` : "";
  const response = await fetch(`${projectThreadsPath(projectId)}/${encodeURIComponent(threadId)}/messages${hostQuery}`, {
    method: "POST",
    headers: { ...baseHeaders(), "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not send message to T3 thread"));
  }
  return (await response.json()) as ProjectT3Thread;
}

/**
 * Reads user and assistant messages from a project-level T3 thread (#BIT-131), paged forward with
 * `afterPosition` (exclusive). Also returns the thread's reconciled live state.
 */
export async function fetchProjectT3ThreadMessages(
  projectId: string,
  threadId: string,
  options: { readonly afterPosition?: number | undefined; readonly signal?: AbortSignal | undefined; readonly hostId?: string | undefined } = {},
): Promise<ProjectT3ThreadMessagesResponse> {
  const basePath = `${projectThreadsPath(projectId)}/${encodeURIComponent(threadId)}/messages`;
  const query = new URLSearchParams();
  if (options.afterPosition !== undefined) query.set("after", String(options.afterPosition));
  if (options.hostId) query.set("hostId", options.hostId);
  const url = query.size > 0 ? `${basePath}?${query.toString()}` : basePath;
  const response = await fetch(url, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 thread messages"));
  }
  return (await response.json()) as ProjectT3ThreadMessagesResponse;
}
