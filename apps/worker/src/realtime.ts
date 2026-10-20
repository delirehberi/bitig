import { Hono } from "hono";
import type { RealtimeEvent, StorageProvider } from "@bitig/core";
import type { AppEnv } from "./index";

const WORKSPACE_HUB_NAME = "workspace";
const HTTP_FORBIDDEN = 403;
const HTTP_UPGRADE_REQUIRED = 426;

/**
 * Publishes a realtime mutation event to the workspace Durable Object. Fails
 * open so an unavailable Durable Object never aborts a completed storage write.
 */
export async function publishRealtimeEvent(env: Env, event: RealtimeEvent): Promise<void> {
  try {
    const stub = env.REALTIME_HUB.get(env.REALTIME_HUB.idFromName(WORKSPACE_HUB_NAME));
    await stub.publish(event);
  } catch (error) {
    console.error("realtime hub unavailable, event not broadcast", { type: event.type, error });
  }
}

/**
 * Wraps a `StorageProvider` so that every successful mutation broadcasts a
 * `RealtimeEvent` through `notify`. Both `/api/*` and `/mcp` share the request's
 * storage instance, so every mutation path is covered.
 */
export function withRealtimeBroadcast(
  storage: StorageProvider,
  notify: (event: RealtimeEvent) => Promise<void>,
): StorageProvider {
  return {
    getProjects: (opts) => storage.getProjects(opts),
    getProject: (id, opts) => storage.getProject(id, opts),
    createProject: async (input, opts) => {
      const project = await storage.createProject(input, opts);
      await notify({ type: "project.created", project });
      return project;
    },
    updateProject: async (id, patch, opts) => {
      const project = await storage.updateProject(id, patch, opts);
      await notify({ type: "project.updated", project });
      return project;
    },
    deleteProject: async (id, opts) => {
      await storage.deleteProject(id, opts);
      await notify({ type: "project.deleted", id });
    },

    getTasks: (filter, opts) => storage.getTasks(filter, opts),
    getTask: (id, opts) => storage.getTask(id, opts),
    saveTask: async (input, opts) => {
      const task = await storage.saveTask(input, opts);
      await notify({ type: "task.created", task });
      return task;
    },
    updateTask: async (id, patch, opts) => {
      const task = await storage.updateTask(id, patch, opts);
      await notify({ type: "task.updated", task });
      return task;
    },
    deleteTask: async (id, opts) => {
      await storage.deleteTask(id, opts);
      await notify({ type: "task.deleted", id });
    },
    completeTask: async (id, opts) => {
      const task = await storage.completeTask(id, opts);
      await notify({ type: "task.updated", task });
      return task;
    },

    getComments: (taskId, opts) => storage.getComments(taskId, opts),
    addComment: async (input, opts) => {
      const comment = await storage.addComment(input, opts);
      await notify({ type: "comment.created", comment });
      return comment;
    },
    deleteComment: async (id, opts) => {
      await storage.deleteComment(id, opts);
      await notify({ type: "comment.deleted", id });
    },

    exportProject: (id, opts) => storage.exportProject(id, opts),
    importProject: async (bundle, opts) => {
      const project = await storage.importProject(bundle, opts);
      await notify({ type: "sync" });
      return project;
    },
    exportAll: (opts) => storage.exportAll(opts),
    importBackup: async (backup, opts) => {
      await storage.importBackup(backup, opts);
      await notify({ type: "sync" });
    },
  };
}

/**
 * Upgrades authenticated `GET /api/realtime` requests to a WebSocket managed by
 * the `RealtimeHub` Durable Object.
 */
export const realtimeRouter = new Hono<AppEnv>().get("/", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json(
      { error: "upgrade_required", message: "Expected Upgrade: websocket" },
      HTTP_UPGRADE_REQUIRED,
    );
  }

  const origin = c.req.header("origin");
  if (origin) {
    const selfOrigin = new URL(c.req.url).origin;
    const config = c.get("config");
    if (origin !== selfOrigin && !config.ALLOWED_ORIGINS.includes(origin)) {
      return c.json(
        { error: "forbidden", message: "Cross-site WebSocket connection blocked: origin not allowed" },
        HTTP_FORBIDDEN,
      );
    }
  }

  const stub = c.env.REALTIME_HUB.get(c.env.REALTIME_HUB.idFromName(WORKSPACE_HUB_NAME));
  return stub.fetch(c.req.raw);
});

