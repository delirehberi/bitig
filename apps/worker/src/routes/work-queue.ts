import { Hono } from "hono";
import type { Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  MAX_WORK_QUEUE_ITEMS,
  RunLevelKeySchema,
  RunProfileEffortSchema,
  T3ModelSelectionSchema,
  WORK_QUEUE_PROMPT_MAX,
} from "@bitig/core";
import { D1WorkQueueStore } from "@bitig/storage-d1";
import type { AppEnv } from "../index";
import {
  WorkQueueNothingToQueueError,
  changeWorkQueueState,
  confirmWorkQueue,
  listWorkQueues,
  planWorkQueuePrompt,
  retryWorkQueueEntry,
  skipWorkQueueEntry,
  type WorkQueueAction,
  type WorkQueueActor,
  type WorkQueueServiceDeps,
} from "../work-queue/service";
import { markTaskFeedbackApproved } from "./feedback";
import { buildServiceDeps } from "./t3";

const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

/** A ticket code such as `BIT-92`, `bit-92` or `#BIT-092`. */
const TICKET_CODE_PATTERN = /^#?[A-Za-z][A-Za-z0-9]{1,9}-[0-9]{1,9}$/;
const INCLUDE_CLOSED_PARAM = "all";

const PromptSchema = z.string().trim().min(1).max(WORK_QUEUE_PROMPT_MAX);
const TicketCodeSchema = z.string().trim().regex(TICKET_CODE_PATTERN);
const TicketCodesSchema = z.array(TicketCodeSchema).max(MAX_WORK_QUEUE_ITEMS);

export const PlanWorkQueueBodySchema = z.strictObject({
  prompt: PromptSchema,
  /** Edited code list from the preview; when present the prompt is not parsed again. */
  items: TicketCodesSchema.min(1).exactOptional(),
});

export const ConfirmWorkQueueBodySchema = z.strictObject({
  prompt: PromptSchema,
  items: TicketCodesSchema.min(1),
  /** Codes of pending tasks the person ticked "Approve" for. */
  approvals: TicketCodesSchema.default([]),
  overrides: z
    .array(
      z.strictObject({
        code: TicketCodeSchema,
        level: RunLevelKeySchema.exactOptional(),
        effort: RunProfileEffortSchema.exactOptional(),
        selection: T3ModelSelectionSchema.exactOptional(),
      }),
    )
    .max(MAX_WORK_QUEUE_ITEMS)
    .default([]),
});

export const RetryWorkQueueItemBodySchema = z.strictObject({
  level: RunLevelKeySchema.exactOptional(),
});

interface WorkQueueRequestScope {
  readonly deps: WorkQueueServiceDeps;
  readonly actor: WorkQueueActor;
}

/**
 * Builds the organisation-scoped service for a request. Queue actions are
 * attributed to the signed-in person, so a request without one is refused.
 */
function requestScope(c: Context<AppEnv>): WorkQueueRequestScope | Response {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
  const orgId = c.get("orgId");
  if (!orgId) return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
  return {
    deps: { t3: buildServiceDeps(c), queueStore: new D1WorkQueueStore(c.env.DB, orgId) },
    actor: {
      id: user.id,
      name: user.displayName,
      ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
    },
  };
}

/** `POST /api/work-queue/plan` and `POST /api/work-queue`. */
export const workQueueRouter = new Hono<AppEnv>()
  .post("/plan", zValidator("json", PlanWorkQueueBodySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
    }
    return undefined;
  }), async (c) => {
    const scope = requestScope(c);
    if (scope instanceof Response) return scope;
    const body = c.req.valid("json");
    const plan = await planWorkQueuePrompt(scope.deps, {
      prompt: body.prompt,
      ...(body.items ? { items: body.items } : {}),
      actor: scope.actor,
      cache: caches.default,
      signal: c.req.raw.signal,
    });
    return c.json(plan);
  })
  .post("/", zValidator("json", ConfirmWorkQueueBodySchema, (result, c) => {
    if (!result.success) {
      return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
    }
    return undefined;
  }), async (c) => {
    const scope = requestScope(c);
    if (scope instanceof Response) return scope;
    const body = c.req.valid("json");
    try {
      const result = await confirmWorkQueue(scope.deps, {
        prompt: body.prompt,
        items: body.items,
        approvals: body.approvals,
        overrides: body.overrides,
        actor: scope.actor,
        onTaskApproved: (taskId) => markTaskFeedbackApproved(c, taskId),
      });
      return c.json(result, HTTP_CREATED);
    } catch (error: unknown) {
      if (error instanceof WorkQueueNothingToQueueError) {
        return c.json({ error: "nothing_to_queue", message: error.message, plan: error.plan }, HTTP_CONFLICT);
      }
      throw error;
    }
  });

function queueActionHandler(action: WorkQueueAction) {
  return async (c: Context<AppEnv>): Promise<Response> => {
    const scope = requestScope(c);
    if (scope instanceof Response) return scope;
    const id = c.req.param("id") ?? "";
    return c.json(await changeWorkQueueState(scope.deps, id, action, scope.actor));
  };
}

/** `GET /api/work-queues` and `POST /api/work-queues/:id/{pause,resume,cancel}`. */
export const workQueuesRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    const scope = requestScope(c);
    if (scope instanceof Response) return scope;
    const queues = await listWorkQueues(scope.deps, {
      includeClosed: c.req.query(INCLUDE_CLOSED_PARAM) === "true",
    });
    return c.json(queues);
  })
  .post("/:id/pause", queueActionHandler("pause"))
  .post("/:id/resume", queueActionHandler("resume"))
  .post("/:id/cancel", queueActionHandler("cancel"));

/** `POST /api/work-queue-items/:id/{skip,retry}`. */
export const workQueueItemsRouter = new Hono<AppEnv>()
  .post("/:id/skip", async (c) => {
    const scope = requestScope(c);
    if (scope instanceof Response) return scope;
    return c.json(await skipWorkQueueEntry(scope.deps, c.req.param("id"), scope.actor));
  })
  .post("/:id/retry", async (c) => {
    const scope = requestScope(c);
    if (scope instanceof Response) return scope;
    // The body is optional: an empty request retries on the task's current level.
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json(
          { error: "validation_error", details: [{ path: [], message: "Expected a JSON object" }] },
          HTTP_BAD_REQUEST,
        );
      }
    }
    const parsed = RetryWorkQueueItemBodySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.issues }, HTTP_BAD_REQUEST);
    }
    const entry = await retryWorkQueueEntry(scope.deps, c.req.param("id"), parsed.data, scope.actor);
    return c.json(entry, HTTP_CREATED);
  });
