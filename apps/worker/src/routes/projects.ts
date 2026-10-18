import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { CreateProjectInputSchema, ProjectBundleSchema, UpdateProjectInputSchema } from "@bitig/core";
import type { AppEnv } from "../index";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;

export const projectsRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    const storage = c.get("storage");
    const projects = await storage.getProjects();
    return c.json(projects);
  })
  .post(
    "/",
    zValidator("json", CreateProjectInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const input = c.req.valid("json");
      const project = await storage.createProject(input);
      return c.json(project, HTTP_CREATED);
    },
  )
  .post(
    "/import",
    zValidator("json", ProjectBundleSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const bundle = c.req.valid("json");
      const project = await storage.importProject(bundle);
      return c.json(project, HTTP_CREATED);
    },
  )
  .get("/:id/export", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    const bundle = await storage.exportProject(id);
    return c.json(bundle);
  })
  .get("/:id", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    const project = await storage.getProject(id);
    if (!project) {
      return c.json({ error: "not_found" }, 404);
    }
    return c.json(project);
  })
  .patch(
    "/:id",
    zValidator("json", UpdateProjectInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const id = c.req.param("id");
      const patch = c.req.valid("json");
      const updated = await storage.updateProject(id, patch);
      return c.json(updated);
    },
  )
  .delete("/:id", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    await storage.deleteProject(id);
    return c.body(null, HTTP_NO_CONTENT);
  });
