import type { Context } from "hono";
import type { StorageProvider } from "@bitig/core";
import type { AppEnv } from "./index";
import { D1Storage, T3D1Store } from "@bitig/storage-d1";
import { parseConfig, type AppConfig } from "./config";
import { publishRealtimeEvent, withRealtimeBroadcast } from "./realtime";
import { createT3Fetch } from "./t3/client";
import { dispatchWorkQueues, hasWorkQueuesNeedingDispatch } from "./work-queue/dispatcher";
import { listT3RunsLive, type T3ServiceDeps } from "./t3/service";

/**
 * Runs background work via `executionCtx.waitUntil` on Workers, or awaits it directly when no
 * execution context exists (e.g. `app.request` in tests).
 */
export async function runInBackground(
  c: Pick<Context<AppEnv>, "executionCtx">,
  work: Promise<unknown>,
): Promise<void> {
  let executionCtx: Context<AppEnv>["executionCtx"] | undefined;
  try {
    executionCtx = c.executionCtx;
  } catch {
    // Hono throws when the request has no execution context; fall back to awaiting the work.
    executionCtx = undefined;
  }
  if (executionCtx) {
    executionCtx.waitUntil(work);
    return;
  }
  await work;
}

/** Cron also reconciles live runs so a disconnected dashboard cannot strand a queue. */
export async function runScheduledWorkQueues(env: Env): Promise<void> {
  const config = parseConfig(env);
  if (!config.T3_ENCRYPTION_KEY) return;
  const hasTable = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_queues'").first();
  if (!hasTable) return;
  const organisations = await env.DB.prepare("SELECT DISTINCT org_id FROM work_queues WHERE state IN ('active', 'paused', 'cancelled')")
    .all<{ org_id: string }>();
  const fetchFn = config.T3_CF_ACCESS_CLIENT_ID && config.T3_CF_ACCESS_CLIENT_SECRET
    ? createT3Fetch(fetch, { clientId: config.T3_CF_ACCESS_CLIENT_ID, clientSecret: config.T3_CF_ACCESS_CLIENT_SECRET })
    : fetch;
  for (const { org_id: orgId } of organisations.results) {
    const publishRealtime: NonNullable<T3ServiceDeps["publishRealtime"]> = (event) => publishRealtimeEvent(env, event, orgId);
    const t3: T3ServiceDeps = {
      store: new T3D1Store(env.DB, orgId),
      storage: withRealtimeBroadcast(new D1Storage({ db: env.DB, bucket: env.ATTACHMENTS, orgId }), publishRealtime),
      encryptionKey: config.T3_ENCRYPTION_KEY,
      hierarchyMode: config.HIERARCHY_MODE,
      workQueue: { db: env.DB, orgId },
      dispatchingWorkQueue: true,
      fetchFn,
      publishRealtime,
    };
    try {
      await listT3RunsLive(t3);
      await dispatchWorkQueues({ db: env.DB, orgId, t3 });
    } catch (error) {
      console.error("scheduled work queue reconciliation failed", { orgId, error });
    }
  }
}

const READ_ONLY_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);
const HTTP_ERROR_STATUS_MIN = 400;

/** Mutating, successful API or MCP requests may unblock queue items (approvals, merges, resumes). */
export function shouldDispatchWorkQueuesAfter(method: string, path: string, status: number): boolean {
  if (READ_ONLY_METHODS.has(method) || status >= HTTP_ERROR_STATUS_MIN) return false;
  return path.startsWith("/api/") || path === "/mcp";
}

export interface RequestWorkQueueDispatchInput {
  readonly orgId: string | undefined;
  readonly config: Pick<AppConfig, "T3_ENCRYPTION_KEY" | "HIERARCHY_MODE">;
  readonly storage: StorageProvider;
  readonly t3Fetch: typeof fetch | undefined;
}

/**
 * Runs the dispatcher after a request. Only authenticated requests carry an organisation, so
 * anonymous traffic never triggers it, and the pre-check keeps idle organisations cheap.
 * Failures are logged: the request itself already succeeded.
 */
export async function dispatchRequestWorkQueues(env: Env, input: RequestWorkQueueDispatchInput): Promise<void> {
  const { orgId } = input;
  if (!orgId || !input.config.T3_ENCRYPTION_KEY) return;
  try {
    const table = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_queues'").first();
    if (!table) return;
    if (!(await hasWorkQueuesNeedingDispatch({ db: env.DB, orgId }))) return;
    await dispatchWorkQueues({
      db: env.DB,
      orgId,
      t3: {
        store: new T3D1Store(env.DB, orgId),
        storage: input.storage,
        encryptionKey: input.config.T3_ENCRYPTION_KEY,
        hierarchyMode: input.config.HIERARCHY_MODE,
        fetchFn: input.t3Fetch,
        publishRealtime: (event) => publishRealtimeEvent(env, event, orgId),
      },
    });
  } catch (error: unknown) {
    console.error("work queue dispatch after a request failed", { orgId, error });
  }
}
