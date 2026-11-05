import type { Context } from "hono";
import type { AppEnv } from "./index";

/**
 * Runs background work via `executionCtx.waitUntil` on Workers, or awaits it directly when no
 * execution context exists (e.g. `app.request` in tests).
 */
export async function runInBackground(c: Context<AppEnv>, work: Promise<unknown>): Promise<void> {
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
