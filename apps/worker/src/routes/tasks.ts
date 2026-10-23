import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CreateCommentInputSchema,
  CreateTaskInputSchema,
  UpdateTaskInputSchema,
  buildMentionIndex,
  checkNewTaskStatus,
  checkStatusChange,
  type OperationOptions,
} from "@bitig/core";
import type { Context } from "hono";
import type { AppEnv } from "../index";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;

/** Query flag a person sets, after confirming, to start or complete a task despite unfinished dependencies. */
const OVERRIDE_BLOCKED_PARAM = "overrideBlocked";

/**
 * Options for a status change by a person: the actor header, and the blockers they overrode.
 * Without `?overrideBlocked=true` a blocked change is refused, so the dashboard can confirm first.
 */
async function statusChangeOptions(
  c: Context<AppEnv>,
  id: string,
  status: Parameters<typeof checkStatusChange>[2] | undefined,
  context: string,
): Promise<OperationOptions> {
  const actor = c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent");
  const overrideBlockedBy =
    status === undefined
      ? []
      : await checkStatusChange(c.get("storage"), id, status, context, {
          overrideBlocked: c.req.query(OVERRIDE_BLOCKED_PARAM) === "true",
        });
  return {
    ...(actor ? { actor } : {}),
    ...(overrideBlockedBy.length > 0 ? { overrideBlockedBy } : {}),
  };
}

export const tasksRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    const storage = c.get("storage");
    const projectId = c.req.query("projectId");
    const filter = projectId ? { projectId } : undefined;
    const tasks = await storage.getTasks(filter);
    return c.json(tasks);
  })
  .post(
    "/",
    zValidator("json", CreateTaskInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const input = c.req.valid("json");
      const actor = c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent");
      await checkNewTaskStatus(storage, input, "saveTask");
      const task = await storage.saveTask(input, actor ? { actor } : undefined);
      return c.json(task, HTTP_CREATED);
    },
  )
  .get("/:id", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    const task = await storage.getTask(id);
    if (!task) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(task);
  })
  .patch(
    "/:id",
    zValidator("json", UpdateTaskInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const id = c.req.param("id");
      const patch = c.req.valid("json");
      const updated = await storage.updateTask(id, patch, await statusChangeOptions(c, id, patch.status, "updateTask"));
      return c.json(updated);
    },
  )
  .delete("/:id", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    await storage.deleteTask(id);
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post("/:id/complete", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    const completed = await storage.completeTask(id, await statusChangeOptions(c, id, "done", "completeTask"));
    return c.json(completed);
  })
  // Mention links, derived on read: what the task mentions (text and comments) and who mentions it.
  .get("/:id/links", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    const task = await storage.getTask(id);
    if (!task) {
      return c.json({ error: "not_found" }, 404);
    }
    const [comments, tasks, projects] = await Promise.all([
      storage.getComments(id),
      storage.getTasks(),
      storage.getProjects(),
    ]);
    return c.json(buildMentionIndex(tasks, projects).linksFor(task, comments));
  })
  .get("/:id/comments", async (c) => {
    const storage = c.get("storage");
    const comments = await storage.getComments(c.req.param("id"));
    return c.json(comments);
  })
  .post(
    "/:id/comments",
    zValidator("json", CreateCommentInputSchema.omit({ taskId: true }), (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const comment = await storage.addComment(
        { ...c.req.valid("json"), taskId: c.req.param("id") },
        { actor: c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? "you" },
      );
      return c.json(comment, HTTP_CREATED);
    },
  );
