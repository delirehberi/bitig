import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CreateHostBoundProjectInputSchema,
  NotFoundError,
  ProjectBundleSchema,
  UpdateHostBoundProjectInputSchema,
} from "@bitig/core";
import type { AppEnv } from "../index";
import {
  createProjectFromHostFolder,
  registerHostFolder,
  unregisterHostFolder,
} from "../t3/host-folders";
import { buildHostFolderDeps, hostFolderErrorResponse, requireOrgOwner } from "./t3";

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
    zValidator("json", CreateHostBoundProjectInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const { hostId, workspaceRoot, ...projectInput } = c.req.valid("json");
      if (workspaceRoot === undefined) {
        const project = await storage.createProject(projectInput);
        return c.json(project, HTTP_CREATED);
      }
      requireOrgOwner(c);
      try {
        const result = await createProjectFromHostFolder(buildHostFolderDeps(c), projectInput, {
          workspaceRoot,
          hostId,
        });
        return c.json(
          {
            ...result.project,
            mapping: result.mapping,
            created: result.created,
          },
          HTTP_CREATED,
        );
      } catch (err) {
        return hostFolderErrorResponse(err, c);
      }
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
    zValidator("json", UpdateHostBoundProjectInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const storage = c.get("storage");
      const id = c.req.param("id");
      const { hostId, workspaceRoot, force, ...projectPatch } = c.req.valid("json");
      if (workspaceRoot === undefined && hostId === undefined) {
        const updated = await storage.updateProject(id, projectPatch);
        return c.json(updated);
      }
      requireOrgOwner(c);
      const hasProjectPatch = Object.values(projectPatch).some((value) => value !== undefined);
      try {
        if (workspaceRoot === null || workspaceRoot === undefined) {
          const detached = await unregisterHostFolder(buildHostFolderDeps(c), id, { force });
          const project = hasProjectPatch
            ? await storage.updateProject(id, projectPatch)
            : await storage.getProject(id);
          if (!project) {
            throw new NotFoundError("project", id);
          }
          return c.json({
            ...project,
            mapping: null,
            unregistered: detached.unregistered,
          });
        }
        const updatedProject = hasProjectPatch
          ? await storage.updateProject(id, projectPatch)
          : undefined;
        const attached = await registerHostFolder(
          buildHostFolderDeps(c),
          id,
          workspaceRoot,
          hostId ?? undefined,
        );
        const project = updatedProject ?? (await storage.getProject(id));
        if (!project) {
          throw new NotFoundError("project", id);
        }
        return c.json({
          ...project,
          mapping: attached.mapping,
          created: attached.created,
        });
      } catch (err) {
        return hostFolderErrorResponse(err, c);
      }
    },
  )
  .delete("/:id", async (c) => {
    const storage = c.get("storage");
    const id = c.req.param("id");
    await storage.deleteProject(id);
    return c.body(null, HTTP_NO_CONTENT);
  });
