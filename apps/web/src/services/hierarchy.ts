import type {
  ImportHierarchyInput,
  ImportHierarchyResponse,
  LegacyHierarchyInventoryResponse,
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

export class HierarchyApiError extends Error {
  override readonly name = "HierarchyApiError";
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

/**
 * Fetches the read-only inventory of legacy inferred parent-child relationships (#BIT-195).
 * Never mutates tasks or auto-promotes inferred links.
 */
export async function fetchLegacyHierarchyInventory(
  projectId?: string,
  signal?: AbortSignal,
): Promise<LegacyHierarchyInventoryResponse> {
  const query = new URLSearchParams();
  if (projectId) query.set("projectId", projectId);
  const qs = query.size > 0 ? `?${query.toString()}` : "";
  const response = await fetch(`/api/tasks/hierarchy/inventory${qs}`, {
    headers: baseHeaders(),
    credentials: "same-origin",
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new HierarchyApiError(
      response.status,
      await parseErrorMessage(response, "Could not load legacy hierarchy inventory"),
    );
  }
  return (await response.json()) as LegacyHierarchyInventoryResponse;
}

/**
 * Persists human-confirmed explicit `parentId` edges (#BIT-195).
 */
export async function importLegacyHierarchy(
  input: ImportHierarchyInput,
  signal?: AbortSignal,
): Promise<ImportHierarchyResponse> {
  const response = await fetch("/api/tasks/hierarchy/import", {
    method: "POST",
    headers: {
      ...baseHeaders(),
      "Content-Type": "application/json",
    },
    credentials: "same-origin",
    body: JSON.stringify(input),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    throw new HierarchyApiError(
      response.status,
      await parseErrorMessage(response, "Could not import hierarchy edges"),
    );
  }
  return (await response.json()) as ImportHierarchyResponse;
}
