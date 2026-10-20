import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CreateWebhookInputSchema,
  UpdateWebhookInputSchema,
  WebhookTokenSchema,
  extractTaskFromWebhookPayload,
  withTaskCodes,
} from "@bitig/core";
import type { AppEnv } from "../index";
import { recordAuthFailure } from "../rate-limit";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;

export const webhooksApiRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    const storage = c.get("storage");
    const token = c.req.query("token");
    if (token !== undefined) {
      const matched = await storage.getWebhookByToken(token);
      return c.json(matched === null ? [] : [matched]);
    }
    const projectId = c.req.query("projectId");
    const filter = projectId ? { projectId } : undefined;
    const webhooks = await storage.getWebhooks(filter);
    return c.json(webhooks);
  })
  .post(
    "/",
    zValidator("json", CreateWebhookInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const input = c.req.valid("json");
      const webhook = await storage.createWebhook(input);
      return c.json(webhook, HTTP_CREATED);
    },
  )
  .get("/:id", async (c) => {
    const storage = c.get("storage");
    const webhook = await storage.getWebhook(c.req.param("id"));
    if (!webhook) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    return c.json(webhook);
  })
  .patch(
    "/:id",
    zValidator("json", UpdateWebhookInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const updated = await storage.updateWebhook(c.req.param("id"), c.req.valid("json"));
      return c.json(updated);
    },
  )
  .delete("/:id", async (c) => {
    const storage = c.get("storage");
    await storage.deleteWebhook(c.req.param("id"));
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post("/:id/trigger", async (c) => {
    const storage = c.get("storage");
    const updated = await storage.recordWebhookTrigger(c.req.param("id"));
    return c.json(updated);
  });

export const webhookReceiverRouter = new Hono<AppEnv>().post("/:token", async (c) => {
  const rawToken = c.req.param("token");
  const parsedToken = WebhookTokenSchema.safeParse(rawToken);
  if (!parsedToken.success) {
    await recordAuthFailure(c);
    return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
  }

  const storage = c.get("storage");
  const webhook = await storage.getWebhookByToken(parsedToken.data);
  if (!webhook) {
    await recordAuthFailure(c);
    return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
  }

  if (!webhook.enabled) {
    return c.json(
      { error: "webhook_disabled", message: "Webhook is currently disabled" },
      HTTP_FORBIDDEN,
    );
  }

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json(
      { error: "validation_error", message: "Request body must be valid JSON" },
      HTTP_BAD_REQUEST,
    );
  }

  const taskInput = extractTaskFromWebhookPayload(webhook, payload);
  const task = await storage.saveTask(taskInput);
  await storage.recordWebhookTrigger(webhook.id);
  const project = await storage.getProject(task.projectId);
  const taskWithCode = withTaskCodes([task], project === null ? [] : [project])[0] ?? task;

  return c.json(taskWithCode, HTTP_CREATED);
});

