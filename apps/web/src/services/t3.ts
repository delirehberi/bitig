import type {
  AgentRun,
  Comment,
  ProjectT3Thread,
  ProjectT3ThreadMessagesResponse,
  ProjectT3ThreadsResponse,
  ReplyToT3RunInput,
  SendProjectT3MessageInput,
  StartProjectT3ThreadInput,
  StartT3ThreadInput,
  T3ConnectionStatus,
  T3ModelCapability,
  T3ProjectMapping,
  T3RemoteProject,
  T3RunsLiveResponse,
  T3TaskRunLiveResponse,
  T3WorkspaceBusySession,
  Task,
} from "@bitig/core";

const BASE_HEADERS = {
  Accept: "application/json",
  "X-Bitig-Request": "true",
} as const;

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
  if (!threadId || (state !== "working" && state !== "waiting_for_approval")) return undefined;
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

export async function fetchT3Connection(signal?: AbortSignal): Promise<T3ConnectionStatus> {
  const response = await fetch("/api/t3/connection", {
    headers: BASE_HEADERS,
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 connection"));
  }
  return (await response.json()) as T3ConnectionStatus;
}

export async function startT3OAuth(mcpUrl: string): Promise<{ authorizationUrl: string; state: string }> {
  const response = await fetch("/api/t3/oauth/start", {
    method: "POST",
    headers: {
      ...BASE_HEADERS,
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify({ mcpUrl }),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not start T3 OAuth"));
  }
  return (await response.json()) as { authorizationUrl: string; state: string };
}

export async function disconnectT3(): Promise<void> {
  const response = await fetch("/api/t3/connection", {
    method: "DELETE",
    headers: BASE_HEADERS,
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not disconnect T3"));
  }
}

export async function fetchT3RemoteProjects(signal?: AbortSignal): Promise<T3RemoteProject[]> {
  const response = await fetch("/api/t3/projects", {
    headers: BASE_HEADERS,
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 projects"));
  }
  const body = (await response.json()) as { projects: T3RemoteProject[] };
  return body.projects;
}

export async function fetchT3Capabilities(signal?: AbortSignal): Promise<T3ModelCapability[]> {
  const response = await fetch("/api/t3/capabilities", {
    headers: BASE_HEADERS,
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
    headers: BASE_HEADERS,
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 mappings"));
  }
  const body = (await response.json()) as { mappings: T3ProjectMapping[] };
  return body.mappings;
}

export async function saveT3ProjectMapping(
  projectId: string,
  input: { t3ProjectId: string; t3ProjectTitle: string },
): Promise<T3ProjectMapping> {
  const response = await fetch(`/api/t3/mappings/${encodeURIComponent(projectId)}`, {
    method: "PUT",
    headers: {
      ...BASE_HEADERS,
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
    headers: BASE_HEADERS,
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not remove project mapping"));
  }
}

export async function fetchT3Runs(signal?: AbortSignal): Promise<T3RunsLiveResponse> {
  const response = await fetch("/api/t3/runs", {
    headers: BASE_HEADERS,
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
    headers: BASE_HEADERS,
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 thread status"));
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
      ...BASE_HEADERS,
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
    headers: BASE_HEADERS,
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
      ...BASE_HEADERS,
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
      ...BASE_HEADERS,
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
    headers: BASE_HEADERS,
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
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not start T3 thread"));
  }
  return (await response.json()) as ProjectT3Thread;
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
): Promise<ProjectT3Thread> {
  const response = await fetch(`${projectThreadsPath(projectId)}/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
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
  options: { readonly afterPosition?: number | undefined; readonly signal?: AbortSignal | undefined } = {},
): Promise<ProjectT3ThreadMessagesResponse> {
  const basePath = `${projectThreadsPath(projectId)}/${encodeURIComponent(threadId)}/messages`;
  const url =
    options.afterPosition !== undefined
      ? `${basePath}?after=${encodeURIComponent(String(options.afterPosition))}`
      : basePath;
  const response = await fetch(url, {
    headers: BASE_HEADERS,
    credentials: "same-origin",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not load T3 thread messages"));
  }
  return (await response.json()) as ProjectT3ThreadMessagesResponse;
}

