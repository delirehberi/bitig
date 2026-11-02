import type {
  AgentRun,
  StartT3ThreadInput,
  T3ConnectionStatus,
  T3ModelCapability,
  T3ProjectMapping,
  T3RemoteProject,
  T3TaskRunLiveResponse,
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
    throw new T3ApiError(response.status, await parseErrorMessage(response, "Could not start T3 thread"));
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
