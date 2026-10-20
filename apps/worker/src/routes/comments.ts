import { Hono } from "hono";
import type { AppEnv } from "../index";

const HTTP_NO_CONTENT = 204;

/** Comments are listed and added under their task (`/api/tasks/:id/comments`); this deletes one by ID. */
export const commentsRouter = new Hono<AppEnv>().delete("/:id", async (c) => {
  const storage = c.get("storage");
  await storage.deleteComment(c.req.param("id"));
  return c.body(null, HTTP_NO_CONTENT);
});
