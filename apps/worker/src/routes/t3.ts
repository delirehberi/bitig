import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CheckHostFolderInputSchema,
  NotFoundError,
  RegisterHostFolderInputSchema,
  ReplyToT3RunInputSchema,
  RespondT3PendingRequestInputSchema,
  SendProjectT3MessageInputSchema,
  StartProjectT3ThreadInputSchema,
  StartT3ThreadInputSchema,
  T3StartOAuthInputSchema,
  T3WorkspaceBusyError,
  UpdateT3HostInputSchema,
  UpsertT3ProjectMappingInputSchema,
  ValidationError,
  computeT3HostConnectionStatus,
  hasMinimumOrgRole,
  isActiveAgentRunState,
} from "@bitig/core";
import { D1Storage, T3D1Store } from "@bitig/storage-d1";
import type { Context } from "hono";
import { ForbiddenRoleError } from "../auth";
import type { AppEnv } from "../index";
import { publishRealtimeEvent, withRealtimeBroadcast } from "../realtime";
import { T3McpError, T3OAuthError, exchangeT3OAuthCode, startT3OAuthFlow } from "../t3/client";
import { encryptT3Token } from "../t3/crypto";
import {
  HostFolderError,
  checkHostFolder,
  registerHostFolder,
  unregisterHostFolder,
  type HostFolderDeps,
} from "../t3/host-folders";
import {
  createActiveT3McpClient,
  drainAllQueuedT3Runs,
  getT3ConnectionStatus,
  getTaskT3RunLiveStatus,
  launchProjectThreadInT3,
  launchTaskInT3,
  listProjectT3ThreadsLive,
  listT3HostConnectionStatuses,
  listT3ModelCapabilities,
  listT3RunsLive,
  readProjectT3ThreadMessages,
  replyToTaskT3Run,
  respondToTaskT3Request,
  sendProjectT3Message,
  settleProjectT3Thread,
  stopTaskT3Run,
  T3ModelSwitchConflictError,
  type T3ServiceDeps,
} from "../t3/service";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const HTTP_OK = 200;
const FORCE_QUERY_VALUES = new Set(["true", "false"]);

/** Host project operations change the T3 host, so only the organisation owner may run them (#BIT-148). */
function requireOrgOwner(c: Context<AppEnv>): void {
  const role = c.get("orgRole");
  if (!role || !hasMinimumOrgRole(role, "owner")) {
    throw new ForbiddenRoleError("owner role required to manage folders on the T3 host");
  }
}

function buildHostFolderDeps(c: Context<AppEnv>): HostFolderDeps {
  return {
    store: new T3D1Store(c.env.DB, c.get("orgId")),
    storage: c.get("storage"),
    encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
    fetchFn: c.get("t3Fetch"),
    // Stops the T3 calls when the browser gives up on the request.
    signal: c.req.raw.signal,
  };
}

function hostFolderErrorResponse(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof HostFolderError) {
    return c.json({ error: err.code, message: err.message }, err.status);
  }
  return handleT3RouteError(err, c);
}

export function buildServiceDeps(c: Context<AppEnv>): T3ServiceDeps {
  const orgId = c.get("orgId");
  return {
    store: new T3D1Store(c.env.DB, orgId),
    storage: c.get("storage"),
    encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
    fetchFn: c.get("t3Fetch"),
    publishRealtime: (event) => publishRealtimeEvent(c.env, event, orgId),
  };
}

function handleT3RouteError(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof T3ModelSwitchConflictError) {
    return c.json({ error: err.code, message: err.message, state: err.state }, HTTP_CONFLICT);
  }
  if (err instanceof T3WorkspaceBusyError) {
    return c.json({ error: "workspace_busy", message: err.message, session: err.session }, HTTP_CONFLICT);
  }
  if (err instanceof T3OAuthError || err instanceof T3McpError) {
    return c.json(
      {
        error: err.code,
        message: err.message,
      },
      HTTP_BAD_GATEWAY,
    );
  }
  throw err;
}

/**
 * Unauthenticated OAuth callback router. Browser top-level redirects from the T3
 * OAuth server do not carry Bitig's `SameSite=Strict` session cookie, so this
 * endpoint authenticates the flow using the single-use 256-bit `state` record
 * and PKCE `code_verifier` stored in D1.
 */
export const t3OauthCallbackRouter = new Hono<AppEnv>().get("/", async (c) => {
  const oauthError = c.req.query("error");
  if (oauthError) {
    const description = c.req.query("error_description") ?? oauthError;
    const redirectUrl = new URL("/settings", c.req.url);
    redirectUrl.searchParams.set("t3", "error");
    redirectUrl.searchParams.set("reason", description);
    return c.redirect(redirectUrl.toString(), HTTP_FOUND);
  }

  const state = c.req.query("state")?.trim() ?? "";
  const code = c.req.query("code")?.trim() ?? "";
  if (!state || !code) {
    return c.json(
      { error: "validation_error", message: "Missing OAuth state or authorization code" },
      HTTP_BAD_REQUEST,
    );
  }

  const encryptionKey = c.get("config").T3_ENCRYPTION_KEY;
  if (!encryptionKey) {
    return c.json(
      { error: "configuration_error", message: "T3_ENCRYPTION_KEY is not configured" },
      HTTP_BAD_REQUEST,
    );
  }

  const store = new T3D1Store(c.env.DB);
  const now = Date.now();
  const stateRecord = await store.consumeOauthState(state, now);
  if (!stateRecord) {
    return c.json(
      { error: "invalid_state", message: "OAuth state is invalid or has expired" },
      HTTP_BAD_REQUEST,
    );
  }

  try {
    const tokenResult = await exchangeT3OAuthCode({
      tokenEndpoint: stateRecord.tokenEndpoint,
      code,
      redirectUri: stateRecord.redirectUri,
      clientId: stateRecord.clientId,
      codeVerifier: stateRecord.codeVerifier,
      resource: stateRecord.mcpUrl,
      ...(c.get("t3Fetch") ? { fetchFn: c.get("t3Fetch") } : {}),
    });

    const encrypted = await encryptT3Token(tokenResult.accessToken, encryptionKey);
    const expiresAt = now + tokenResult.expiresInSeconds * 1000;

    const orgStore = new T3D1Store(c.env.DB, stateRecord.orgId);
    await orgStore.saveConnection({
      ...(stateRecord.hostId ? { id: stateRecord.hostId } : {}),
      orgId: stateRecord.orgId,
      ...(stateRecord.label ? { label: stateRecord.label } : {}),
      kind: stateRecord.kind,
      projectsRoot: stateRecord.projectsRoot,
      mcpUrl: stateRecord.mcpUrl,
      issuer: stateRecord.issuer,
      clientId: stateRecord.clientId,
      encryptedAccessToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      scope: tokenResult.scope,
      expiresAt,
      now,
    });

    const orgStorage = c.get("customStorageFactory")
      ? c.get("storage")
      : withRealtimeBroadcast(
          new D1Storage({ db: c.env.DB, bucket: c.env.ATTACHMENTS, orgId: stateRecord.orgId }),
          (event) => publishRealtimeEvent(c.env, event, stateRecord.orgId),
        );
    await drainAllQueuedT3Runs({
      store: orgStore,
      storage: orgStorage,
      encryptionKey,
      fetchFn: c.get("t3Fetch"),
      publishRealtime: (event) => publishRealtimeEvent(c.env, event, stateRecord.orgId),
    }).catch(() => undefined);

    const redirectUrl = new URL("/settings", c.req.url);
    redirectUrl.searchParams.set("t3", "connected");
    return c.redirect(redirectUrl.toString(), HTTP_FOUND);
  } catch (err) {
    return handleT3RouteError(err, c);
  }
});

function readHostIdQuery(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}

export const t3ApiRouter = new Hono<AppEnv>()
  .get("/hosts", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const hosts = await listT3HostConnectionStatuses(store);
    return c.json({ hosts });
  })
  .get("/hosts/:hostId", async (c) => {
    const hostId = c.req.param("hostId");
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const connection = await store.getConnection(hostId);
    if (!connection) {
      throw new NotFoundError("t3_host", hostId);
    }
    return c.json(computeT3HostConnectionStatus(connection));
  })
  .patch(
    "/hosts/:hostId",
    zValidator("json", UpdateT3HostInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const hostId = c.req.param("hostId");
      const patch = c.req.valid("json");
      const store = new T3D1Store(c.env.DB, c.get("orgId"));
      const updated = await store.updateConnection(hostId, patch);
      if (!updated) {
        throw new NotFoundError("t3_host", hostId);
      }
      return c.json(computeT3HostConnectionStatus(updated));
    },
  )
  .delete("/hosts/:hostId", async (c) => {
    const hostId = c.req.param("hostId");
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const existing = await store.getConnection(hostId);
    if (!existing) {
      throw new NotFoundError("t3_host", hostId);
    }
    const [runs, threads] = await Promise.all([
      store.listAgentRuns(),
      store.listProjectThreads(),
    ]);
    const activeCount =
      runs.filter((run) => run.hostId === hostId && isActiveAgentRunState(run.state)).length +
      threads.filter((thread) => thread.hostId === hostId && isActiveAgentRunState(thread.state)).length;
    if (activeCount > 0) {
      return c.json(
        {
          error: "host_busy",
          message: `This T3 host has ${String(activeCount)} active session(s). Stop them before removing the host.`,
        },
        HTTP_CONFLICT,
      );
    }
    await store.deleteConnection(hostId);
    return c.body(null, HTTP_NO_CONTENT);
  })
  .get("/connection", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const hostId = readHostIdQuery(c.req.query("hostId"));
    const status = await getT3ConnectionStatus(store, Date.now(), hostId);
    return c.json(status);
  })
  .delete("/connection", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const hostId = readHostIdQuery(c.req.query("hostId"));
    await store.deleteConnection(hostId);
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post(
    "/oauth/start",
    zValidator("json", T3StartOAuthInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const encryptionKey = c.get("config").T3_ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new ValidationError("startT3OAuth", [
          {
            code: "custom",
            path: ["T3_ENCRYPTION_KEY"],
            message: "T3_ENCRYPTION_KEY is not configured on this Worker",
            input: "",
          },
        ]);
      }

      const { mcpUrl, hostId, label, kind, projectsRoot } = c.req.valid("json");
      const redirectUri = new URL("/api/t3/oauth/callback", c.req.url).toString();
      const store = new T3D1Store(c.env.DB, c.get("orgId"));

      if (hostId) {
        const existingHost = await store.getConnection(hostId);
        if (!existingHost) {
          throw new NotFoundError("t3_host", hostId);
        }
      }

      try {
        const started = await startT3OAuthFlow({
          mcpUrl,
          redirectUri,
          ...(c.get("t3Fetch") ? { fetchFn: c.get("t3Fetch") } : {}),
        });
        const now = Date.now();
        await store.saveOauthState({
          state: started.state,
          orgId: c.get("orgId"),
          ...(hostId ? { hostId } : {}),
          ...(label ? { label } : {}),
          ...(kind ? { kind } : {}),
          ...(projectsRoot ? { projectsRoot } : {}),
          mcpUrl: started.mcpUrl,
          issuer: started.issuer,
          tokenEndpoint: started.tokenEndpoint,
          clientId: started.clientId,
          codeVerifier: started.codeVerifier,
          redirectUri: started.redirectUri,
          createdAt: now,
          expiresAt: now + OAUTH_STATE_TTL_MS,
        });

        return c.json({
          authorizationUrl: started.authorizationUrl,
          state: started.state,
        });
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  )
  .get("/projects", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const hostId = readHostIdQuery(c.req.query("hostId"));
    try {
      const client = await createActiveT3McpClient({
        store,
        encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
        hostId,
        fetchFn: c.get("t3Fetch"),
      });
      const projects = await client.listProjects();
      return c.json({ projects });
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .get("/capabilities", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const hostId = readHostIdQuery(c.req.query("hostId"));
    try {
      const capabilities = await listT3ModelCapabilities(
        {
          store,
          encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
          hostId,
          fetchFn: c.get("t3Fetch"),
        },
        caches.default,
      );
      return c.json({ capabilities });
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post(
    "/host-folders/check",
    zValidator("json", CheckHostFolderInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      requireOrgOwner(c);
      const { workspaceRoot, hostId } = c.req.valid("json");
      try {
        const result = await checkHostFolder(buildHostFolderDeps(c), workspaceRoot, hostId);
        return c.json(result);
      } catch (err) {
        return hostFolderErrorResponse(err, c);
      }
    },
  )
  .put(
    "/projects/:projectId/host-folder",
    zValidator("json", RegisterHostFolderInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      requireOrgOwner(c);
      const { workspaceRoot, hostId } = c.req.valid("json");
      try {
        const result = await registerHostFolder(
          buildHostFolderDeps(c),
          c.req.param("projectId"),
          workspaceRoot,
          hostId,
        );
        return c.json(result, result.created ? HTTP_CREATED : HTTP_OK);
      } catch (err) {
        return hostFolderErrorResponse(err, c);
      }
    },
  )
  .delete("/projects/:projectId/host-folder", async (c) => {
    requireOrgOwner(c);
    const force = c.req.query("force");
    if (force !== undefined && !FORCE_QUERY_VALUES.has(force)) {
      return c.json(
        { error: "validation_error", message: "force must be true or false" },
        HTTP_BAD_REQUEST,
      );
    }
    try {
      const result = await unregisterHostFolder(buildHostFolderDeps(c), c.req.param("projectId"), {
        force: force === "true",
      });
      return c.json(result);
    } catch (err) {
      return hostFolderErrorResponse(err, c);
    }
  })
  .get("/mappings", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const mappings = await store.listProjectMappings();
    return c.json({ mappings });
  })
  .get("/runs", async (c) => {
    const result = await listT3RunsLive(buildServiceDeps(c));
    return c.json(result);
  })
  .put(
    "/mappings/:projectId",
    zValidator("json", UpsertT3ProjectMappingInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      const storage = c.get("storage");
      const project = await storage.getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
      const { hostId, t3ProjectId, t3ProjectTitle } = c.req.valid("json");
      const store = new T3D1Store(c.env.DB, c.get("orgId"));
      if (hostId) {
        const host = await store.getConnection(hostId);
        if (!host) {
          throw new NotFoundError("t3_host", hostId);
        }
      }
      const mapping = await store.upsertProjectMapping({
        projectId,
        ...(hostId ? { hostId } : {}),
        t3ProjectId,
        t3ProjectTitle,
      });
      return c.json(mapping);
    },
  )
  .delete("/mappings/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    await store.deleteProjectMapping(projectId);
    return c.body(null, HTTP_NO_CONTENT);
  })
  // Project-level threads without a task (#BIT-127). `:projectId` is the Bitig project ID; the
  // sibling `GET /projects` lists the remote T3 projects instead.
  .get("/projects/:projectId/threads", async (c) => {
    try {
      const result = await listProjectT3ThreadsLive(buildServiceDeps(c), c.req.param("projectId"));
      return c.json(result);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post(
    "/projects/:projectId/threads",
    zValidator("json", StartProjectT3ThreadInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const input = c.req.valid("json");
      const actor = c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? "you";
      try {
        const thread = await launchProjectThreadInT3(buildServiceDeps(c), {
          projectId: c.req.param("projectId"),
          prompt: input.prompt,
          workspaceStrategy: input.workspaceStrategy,
          modelSelection: input.modelSelection,
          actor,
        });
        return c.json(thread, HTTP_CREATED);
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  )
  .post("/projects/:projectId/threads/:threadId/settle", async (c) => {
    try {
      await settleProjectT3Thread(buildServiceDeps(c), c.req.param("projectId"), c.req.param("threadId"));
      return c.body(null, HTTP_NO_CONTENT);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .get("/projects/:projectId/threads/:threadId/messages", async (c) => {
    const rawAfter = c.req.query("after")?.trim();
    let afterPosition: number | undefined;
    if (rawAfter !== undefined && rawAfter !== "") {
      if (!/^\d+$/u.test(rawAfter)) {
        return c.json(
          { error: "validation_error", message: "Query parameter 'after' must be a non-negative integer" },
          HTTP_BAD_REQUEST,
        );
      }
      afterPosition = Number(rawAfter);
      if (!Number.isSafeInteger(afterPosition)) {
        return c.json(
          { error: "validation_error", message: "Query parameter 'after' must be a non-negative integer" },
          HTTP_BAD_REQUEST,
        );
      }
    }
    try {
      const result = await readProjectT3ThreadMessages(
        buildServiceDeps(c),
        c.req.param("projectId"),
        c.req.param("threadId"),
        { ...(afterPosition !== undefined ? { afterPosition } : {}) },
      );
      return c.json(result);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post(
    "/projects/:projectId/threads/:threadId/messages",
    zValidator("json", SendProjectT3MessageInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const input = c.req.valid("json");
      try {
        const thread = await sendProjectT3Message(
          buildServiceDeps(c),
          c.req.param("projectId"),
          c.req.param("threadId"),
          { body: input.body, modelSelection: input.modelSelection },
        );
        return c.json(thread, HTTP_CREATED);
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  );

export const t3TaskRunsRouter = new Hono<AppEnv>()
  .get("/:id/t3-run", async (c) => {
    const id = c.req.param("id");
    const task = await c.get("storage").getTask(id);
    if (!task) {
      throw new NotFoundError("task", id);
    }
    try {
      const status = await getTaskT3RunLiveStatus(buildServiceDeps(c), id);
      return c.json(status);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post("/:id/t3-run/dispatch", async (c) => {
    const id = c.req.param("id");
    const task = await c.get("storage").getTask(id);
    if (!task) {
      throw new NotFoundError("task", id);
    }
    try {
      const status = await getTaskT3RunLiveStatus(buildServiceDeps(c), id);
      return c.json(status);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post(
    "/:id/t3-run",
    zValidator("json", StartT3ThreadInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const id = c.req.param("id");
      const input = c.req.valid("json");
      const actor = c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? "you";
      try {
        const result = await launchTaskInT3(buildServiceDeps(c), {
          taskRef: id,
          workspaceStrategy: input.workspaceStrategy,
          providerInstanceId: input.providerInstanceId,
          model: input.model,
          runtimeMode: input.runtimeMode,
          actor,
        });
        return c.json(result, HTTP_CREATED);
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  )
  .post(
    "/:id/t3-run/reply",
    zValidator("json", ReplyToT3RunInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const id = c.req.param("id");
      const input = c.req.valid("json");
      const actor = c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? "you";
      try {
        const result = await replyToTaskT3Run(buildServiceDeps(c), id, {
          body: input.body,
          author: input.author,
          modelSelection: input.modelSelection,
          freshSession: input.freshSession,
          actor,
        });
        return c.json(result, HTTP_CREATED);
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  )
  .post("/:id/t3-run/stop", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await stopTaskT3Run(buildServiceDeps(c), id);
      return c.json(result);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post(
    "/:id/t3-run/respond",
    zValidator("json", RespondT3PendingRequestInputSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const id = c.req.param("id");
      const body = c.req.valid("json");
      try {
        const result = await respondToTaskT3Request(buildServiceDeps(c), id, body);
        return c.json(result);
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  );
