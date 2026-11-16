/**
 * Client for the Worker's GET /health endpoint.
 */

import {
  DEFAULT_HIERARCHY_MODE,
  isHierarchyMode,
  isStorageMode,
  type HierarchyMode,
  type StorageMode,
} from "@bitig/core";

export const HEALTH_PATH = "/health";
export const HEALTH_TIMEOUT_MS = 5_000;

export interface HealthPayload {
  status: "ok";
  version: string;
  storageMode: StorageMode;
  hierarchyMode: HierarchyMode;
}

export class HealthCheckError extends Error {
  override readonly name = "HealthCheckError";
}

interface RawHealthPayload {
  status: "ok";
  version: string;
  storageMode: StorageMode;
  hierarchyMode?: HierarchyMode;
}

function isRawHealthPayload(value: unknown): value is RawHealthPayload {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.status === "ok" &&
    typeof record.version === "string" &&
    isStorageMode(record.storageMode) &&
    (record.hierarchyMode === undefined || isHierarchyMode(record.hierarchyMode))
  );
}

export async function fetchHealth(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<HealthPayload> {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await fetchImpl(HEALTH_PATH, {
      signal: combined,
      headers: { Accept: "application/json" },
    });
  } catch (error: unknown) {
    // Let the caller's own cancellation propagate untouched.
    if (signal.aborted) throw error;
    throw new HealthCheckError("worker did not respond", { cause: error });
  }

  if (!response.ok) {
    throw new HealthCheckError(`worker answered ${String(response.status)}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    throw new HealthCheckError("worker sent an unreadable response", { cause: error });
  }

  if (!isRawHealthPayload(body)) {
    throw new HealthCheckError("worker sent an unexpected response");
  }
  return {
    status: body.status,
    version: body.version,
    storageMode: body.storageMode,
    hierarchyMode: body.hierarchyMode ?? DEFAULT_HIERARCHY_MODE,
  };
}
