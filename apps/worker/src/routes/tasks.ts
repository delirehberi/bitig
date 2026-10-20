import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { CreateCommentInputSchema, CreateTaskInputSchema, UpdateTaskInputSchema } from "@bitig/core";
import type { AppEnv } from "../index";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;

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
      const task = await storage.saveTask(input);
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
      const updated = await storage.updateTask(id, patch);
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
    const completed = await storage.completeTask(id);
    return c.json(completed);
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
      const comment = await storage.addComment({ ...c.req.valid("json"), taskId: c.req.param("id") });
      return c.json(comment, HTTP_CREATED);
    },
  );
