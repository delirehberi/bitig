import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  CheckHostFolderInputSchema,
  MAX_PARALLEL_CHILDREN_MAX,
  MAX_PARALLEL_CHILDREN_MIN,
  NotFoundError,
  RegisterHostFolderInputSchema,
  ReplyToT3RunInputSchema,
  RespondT3PendingRequestInputSchema,
  RunLevelKeySchema,
  RunProfileConfidenceSchema,
  RunProfileEffortSchema,
  RunProfileReasonSchema,
  RunProfileTouchesSchema,
  SendProjectT3MessageInputSchema,
  StartProjectT3ThreadInputSchema,
  StartT3ThreadInputSchema,
  StartUmbrellaReadyChildrenInputSchema,
  T3ModelSelectionSchema,
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
import { z } from "zod";
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
  getUmbrellaChildrenStatus,
  launchProjectThreadInT3,
  launchTaskInT3,
  listProjectT3ThreadsLive,
  listT3HostConnectionStatuses,
  listT3ModelCapabilities,
  listT3RunsLive,
  readProjectT3ThreadMessages,
  replyToTaskT3Run,
  resolveTaskRunProfileWithSelection,
  respondToTaskT3Request,
  sendProjectT3Message,
  settleProjectT3Thread,
  startReadyChildrenInT3,
  stopAllUmbrellaChildren,
  stopTaskT3Run,
  suggestTaskRunProfile,
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
export function requireOrgOwner(c: Context<AppEnv>): void {
  const role = c.get("orgRole");
  if (!role || !hasMinimumOrgRole(role, "owner")) {
    throw new ForbiddenRoleError("owner role required to manage organisation hosts and project mappings");
  }
}

export function buildHostFolderDeps(c: Context<AppEnv>): HostFolderDeps {
  return {
    store: new T3D1Store(c.env.DB, c.get("orgId")),
    storage: c.get("storage"),
    encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
    fetchFn: c.get("t3Fetch"),
    // Stops the T3 calls when the browser gives up on the request.
    signal: c.req.raw.signal,
  };
}

export function hostFolderErrorResponse(err: unknown, c: Context<AppEnv>): Response {
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

export function handleT3RouteError(err: unknown, c: Context<AppEnv>): Response {
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

export const PutTaskRunProfileBodySchema = z.strictObject({
  level: RunLevelKeySchema.nullable().exactOptional(),
  effort: RunProfileEffortSchema.nullable().exactOptional(),
  selection: T3ModelSelectionSchema.nullable().exactOptional(),
  touches: RunProfileTouchesSchema.nullable().exactOptional(),
  parallelSafe: z.boolean().nullable().exactOptional(),
  reason: RunProfileReasonSchema.nullable().exactOptional(),
  confidence: RunProfileConfidenceSchema.nullable().exactOptional(),
});

export const PutProjectRunSettingsBodySchema = z.strictObject({
  defaultRunLevel: RunLevelKeySchema.nullable().exactOptional(),
  defaultLevel: RunLevelKeySchema.nullable().exactOptional(),
  serialPaths: RunProfileTouchesSchema.exactOptional(),
  maxParallelChildren: z
    .number()
    .int()
    .min(MAX_PARALLEL_CHILDREN_MIN)
    .max(MAX_PARALLEL_CHILDREN_MAX)
    .exactOptional(),
});

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
    const orgStore = new T3D1Store(c.env.DB, stateRecord.orgId);
    if (stateRecord.hostId && !(await orgStore.getConnection(stateRecord.hostId))) {
      throw new NotFoundError("t3_host", stateRecord.hostId);
    }
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

async function executionHostId(c: Context<AppEnv>): Promise<string | undefined> {
  const selected = readHostIdQuery(c.req.query("hostId"));
  const taskId = c.req.query("taskId");
  let projectId = c.req.query("projectId");
  const store = new T3D1Store(c.env.DB, c.get("orgId"));
  let recorded: string | undefined;
  if (taskId) {
    const task = await c.get("storage").getTask(taskId);
    if (!task) throw new NotFoundError("task", taskId);
    if (projectId && projectId !== task.projectId) throw new NotFoundError("project", projectId);
    projectId = task.projectId;
    const run = await store.getAgentRunByTaskId(taskId);
    recorded = run?.hostId;
    if (run && !recorded) throw new ValidationError("t3Host", [{ code: "custom", path: ["hostId"], message: "The run has no recorded host. Ask the organisation owner to repair its binding." }]);
  }
  if (projectId) {
    if (!(await c.get("storage").getProject(projectId))) throw new NotFoundError("project", projectId);
    recorded ??= (await store.getProjectMapping(projectId))?.hostId;
    if (!recorded) throw new ValidationError("t3Host", [{ code: "custom", path: ["projectId"], message: "This project has no recorded host. Ask the organisation owner to connect it." }]);
    if (selected && selected !== recorded) throw new NotFoundError("t3_host", selected);
  }
  return recorded ?? selected;
}

async function disconnectHost(c: Context<AppEnv>, hostId?: string): Promise<Response> {
  requireOrgOwner(c);
  const store = new T3D1Store(c.env.DB, c.get("orgId"));
  const existing = await store.getConnection(hostId);
  if (!existing) {
    if (hostId) throw new NotFoundError("t3_host", hostId);
    return c.body(null, HTTP_NO_CONTENT);
  }
  const [runs, threads] = await Promise.all([store.listAgentRuns(), store.listProjectThreads()]);
  const activeCount = [...runs, ...threads].filter(
    (session) => (!session.hostId || session.hostId === existing.id) && (isActiveAgentRunState(session.state) || session.state === "offline"),
  ).length;
  if (activeCount > 0) {
    return c.json({ error: "host_busy", message: `T3 host "${existing.id}" has ${String(activeCount)} active session(s). Stop them before disconnecting it.` }, HTTP_CONFLICT);
  }
  await store.deleteConnection(existing.id);
  return c.body(null, HTTP_NO_CONTENT);
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
      requireOrgOwner(c);
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
    return disconnectHost(c, c.req.param("hostId"));
  })
  .get("/connection", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const hostId = await executionHostId(c);
    const status = await getT3ConnectionStatus(store, Date.now(), hostId);
    return c.json(status);
  })
  .delete("/connection", async (c) => {
    return disconnectHost(c, readHostIdQuery(c.req.query("hostId")));
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
      requireOrgOwner(c);
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
        if (existingHost.mcpUrl !== mcpUrl) {
          throw new ValidationError("t3Host", [{ code: "custom", path: ["mcpUrl"], message: "Reauthorisation must use the recorded host URL. Connect a different host separately." }]);
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
    const hostId = await executionHostId(c);
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
  // Every task run profile in the organisation plus its run levels, so task cards can show a level chip
  // without one request per task (#BIT-188).
  .get("/run-profiles", async (c) => {
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const [profiles, levels] = await Promise.all([store.listTaskRunProfiles(), store.listRunLevels()]);
    return c.json({ profiles, levels });
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
      requireOrgOwner(c);
      const storage = c.get("storage");
      const project = await storage.getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
      const { hostId, t3ProjectId, t3ProjectTitle, workspaceRoot } = c.req.valid("json");
      const store = new T3D1Store(c.env.DB, c.get("orgId"));
      const existing = await store.getProjectMapping(projectId);
      const host = await store.getConnection(hostId ?? existing?.hostId);
      if (!host) {
        throw new NotFoundError("t3_host", hostId ?? "unconnected");
      }
      if (existing && (existing.hostId !== host.id || existing.t3ProjectId !== t3ProjectId)) {
        await store.assertProjectIdle(projectId);
      }
      const mapping = await store.upsertProjectMapping({
        projectId,
        hostId: host.id,
        t3ProjectId,
        t3ProjectTitle,
        ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      });
      return c.json(mapping);
    },
  )
  .delete("/mappings/:projectId", async (c) => {
    requireOrgOwner(c);
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
      await settleProjectT3Thread(buildServiceDeps(c), c.req.param("projectId"), c.req.param("threadId"), readHostIdQuery(c.req.query("hostId")));
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
        { hostId: readHostIdQuery(c.req.query("hostId")), ...(afterPosition !== undefined ? { afterPosition } : {}) },
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
          { body: input.body, modelSelection: input.modelSelection, hostId: readHostIdQuery(c.req.query("hostId")) },
        );
        return c.json(thread, HTTP_CREATED);
      } catch (err) {
        return handleT3RouteError(err, c);
      }
    },
  )
  .get("/projects/:projectId/run-settings", async (c) => {
    const projectId = c.req.param("projectId");
    const project = await c.get("storage").getProject(projectId);
    if (!project) {
      throw new NotFoundError("project", projectId);
    }
    const store = new T3D1Store(c.env.DB, c.get("orgId"));
    const settings = await store.getProjectRunSettings(project.id);
    if (!settings) {
      throw new NotFoundError("project", projectId);
    }
    return c.json(settings);
  })
  .put(
    "/projects/:projectId/run-settings",
    zValidator("json", PutProjectRunSettingsBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      const project = await c.get("storage").getProject(projectId);
      if (!project) {
        throw new NotFoundError("project", projectId);
      }
      const body = c.req.valid("json");
      const store = new T3D1Store(c.env.DB, c.get("orgId"));
      const settings = await store.upsertProjectRunSettings(project.id, {
        ...(body.defaultRunLevel !== undefined
          ? { defaultRunLevel: body.defaultRunLevel }
          : body.defaultLevel !== undefined
            ? { defaultRunLevel: body.defaultLevel }
            : {}),
        ...(body.serialPaths !== undefined ? { serialPaths: body.serialPaths } : {}),
        ...(body.maxParallelChildren !== undefined
          ? { maxParallelChildren: body.maxParallelChildren }
          : {}),
      });
      return c.json(settings);
    },
  );

export const t3TaskRunsRouter = new Hono<AppEnv>()
  .get("/:id/run-profile", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await resolveTaskRunProfileWithSelection(buildServiceDeps(c), id, {
        hostId: readHostIdQuery(c.req.query("hostId")),
      });
      return c.json({
        profile: result.profile ?? null,
        resolved: result.resolved,
        ...(result.nextLevelUp ? { nextLevelUp: result.nextLevelUp } : {}),
        routerEnabled: result.routerEnabled,
      });
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .put(
    "/:id/run-profile",
    zValidator("json", PutTaskRunProfileBodySchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const id = c.req.param("id");
      const task = await c.get("storage").getTask(id);
      if (!task) {
        throw new NotFoundError("task", id);
      }
      const body = c.req.valid("json");
      const deps = buildServiceDeps(c);
      if (body.level !== undefined && body.level !== null) {
        const levels = await deps.store.listRunLevels();
        if (!levels.some((l) => l.key === body.level)) {
          throw new ValidationError("taskRunProfile", [
            {
              code: "custom",
              path: ["level"],
              message: `Run level "${body.level}" does not exist in this organisation.`,
              input: body.level,
            },
          ]);
        }
      }
      const saved = await deps.store.saveTaskRunProfile({
        taskId: task.id,
        ...(body.level !== undefined ? { level: body.level } : {}),
        ...(body.effort !== undefined ? { effort: body.effort } : {}),
        ...(body.selection !== undefined ? { selection: body.selection } : {}),
        ...(body.touches !== undefined ? { touches: body.touches } : {}),
        ...(body.parallelSafe !== undefined ? { parallelSafe: body.parallelSafe } : {}),
        source: "manual",
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
        ...(body.confidence !== undefined ? { confidence: body.confidence } : {}),
        updatedBy: c.get("user")?.id ?? c.req.header("X-Bitig-Actor") ?? "you",
      });
      const { resolved, nextLevelUp, routerEnabled } = await resolveTaskRunProfileWithSelection(deps, task.id, {
        hostId: readHostIdQuery(c.req.query("hostId")),
      });
      return c.json({
        profile: saved,
        resolved,
        ...(nextLevelUp ? { nextLevelUp } : {}),
        routerEnabled,
      });
    },
  )
  .delete("/:id/run-profile", async (c) => {
    const id = c.req.param("id");
    const task = await c.get("storage").getTask(id);
    if (!task) {
      throw new NotFoundError("task", id);
    }
    const deps = buildServiceDeps(c);
    await deps.store.deleteTaskRunProfile(task.id);
    const { resolved, nextLevelUp, routerEnabled } = await resolveTaskRunProfileWithSelection(deps, task.id, {
      hostId: readHostIdQuery(c.req.query("hostId")),
    });
    return c.json({
      profile: null,
      resolved,
      ...(nextLevelUp ? { nextLevelUp } : {}),
      routerEnabled,
    });
  })
  .post("/:id/run-profile/suggest", async (c) => {
    const id = c.req.param("id");
    const actor = c.get("user")?.id ?? c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? "router";
    try {
      const result = await suggestTaskRunProfile(buildServiceDeps(c), id, {
        actor,
        hostId: readHostIdQuery(c.req.query("hostId")),
        cache: caches.default,
        signal: c.req.raw.signal,
      });
      return c.json({
        profile: result.profile,
        resolved: result.resolved,
        suggestion: result.suggestion,
        stored: result.stored,
        routerEnabled: result.routerEnabled,
        ...(result.nextLevelUp ? { nextLevelUp: result.nextLevelUp } : {}),
      });
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
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
          providerInstanceId:
            input.providerInstanceId ?? input.modelSelection?.providerInstanceId,
          model: input.model ?? input.modelSelection?.model,
          options:
            input.options ?? input.modelOptions ?? input.modelSelection?.options,
          level: input.level,
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
  )
  .get("/:id/children", async (c) => {
    const id = c.req.param("id");
    try {
      const status = await getUmbrellaChildrenStatus(buildServiceDeps(c), id, {
        hostId: readHostIdQuery(c.req.query("hostId")),
      });
      return c.json(status);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post("/:id/children/start-ready", async (c) => {
    const id = c.req.param("id");
    let rawBody: unknown = {};
    const rawText = await c.req.text();
    if (rawText.trim() !== "") {
      try {
        rawBody = JSON.parse(rawText);
      } catch {
        return c.json({ error: "validation_error", message: "Invalid JSON body" }, HTTP_BAD_REQUEST);
      }
    }
    const parsed = StartUmbrellaReadyChildrenInputSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json({ error: "validation_error", details: parsed.error.issues }, HTTP_BAD_REQUEST);
    }
    const actor = c.req.header("X-Bitig-Actor") ?? c.req.header("X-Bitig-Agent") ?? "you";
    try {
      const result = await startReadyChildrenInT3(buildServiceDeps(c), {
        parentTaskRef: id,
        max: parsed.data.max,
        actor,
      });
      return c.json(result, HTTP_CREATED);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .post("/:id/children/stop", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await stopAllUmbrellaChildren(buildServiceDeps(c), id);
      return c.json(result);
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  });
