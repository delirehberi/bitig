import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import {
  NotFoundError,
  RespondT3PendingRequestInputSchema,
  StartT3ThreadInputSchema,
  T3StartOAuthInputSchema,
  UpsertT3ProjectMappingInputSchema,
  ValidationError,
} from "@bitig/core";
import { T3D1Store } from "@bitig/storage-d1";
import type { Context } from "hono";
import type { AppEnv } from "../index";
import { publishRealtimeEvent } from "../realtime";
import { T3McpError, T3OAuthError, exchangeT3OAuthCode, startT3OAuthFlow } from "../t3/client";
import { encryptT3Token } from "../t3/crypto";
import {
  createActiveT3McpClient,
  getT3ConnectionStatus,
  getTaskT3RunLiveStatus,
  launchTaskInT3,
  respondToTaskT3Request,
  stopTaskT3Run,
  type T3ServiceDeps,
} from "../t3/service";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_FOUND = 302;
const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export function buildServiceDeps(c: Context<AppEnv>): T3ServiceDeps {
  return {
    store: new T3D1Store(c.env.DB),
    storage: c.get("storage"),
    encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
    fetchFn: c.get("t3Fetch"),
    publishRealtime: (event) => publishRealtimeEvent(c.env, event),
  };
}

function handleT3RouteError(err: unknown, c: Context<AppEnv>): Response {
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

    await store.saveConnection({
      mcpUrl: stateRecord.mcpUrl,
      issuer: stateRecord.issuer,
      clientId: stateRecord.clientId,
      encryptedAccessToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      scope: tokenResult.scope,
      expiresAt,
      now,
    });

    const redirectUrl = new URL("/settings?t3=connected", c.req.url);
    return c.redirect(redirectUrl.toString(), HTTP_FOUND);
  } catch (err) {
    return handleT3RouteError(err, c);
  }
});

export const t3ApiRouter = new Hono<AppEnv>()
  .get("/connection", async (c) => {
    const store = new T3D1Store(c.env.DB);
    const status = await getT3ConnectionStatus(store);
    return c.json(status);
  })
  .delete("/connection", async (c) => {
    const store = new T3D1Store(c.env.DB);
    await store.deleteConnection();
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

      const { mcpUrl } = c.req.valid("json");
      const redirectUri = new URL("/api/t3/oauth/callback", c.req.url).toString();
      const store = new T3D1Store(c.env.DB);

      try {
        const started = await startT3OAuthFlow({
          mcpUrl,
          redirectUri,
          ...(c.get("t3Fetch") ? { fetchFn: c.get("t3Fetch") } : {}),
        });
        const now = Date.now();
        await store.saveOauthState({
          state: started.state,
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
    const store = new T3D1Store(c.env.DB);
    try {
      const client = await createActiveT3McpClient({
        store,
        encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
        fetchFn: c.get("t3Fetch"),
      });
      const projects = await client.listProjects();
      return c.json({ projects });
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .get("/capabilities", async (c) => {
    const store = new T3D1Store(c.env.DB);
    try {
      const client = await createActiveT3McpClient({
        store,
        encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
        fetchFn: c.get("t3Fetch"),
      });
      const capabilities = await client.listModelCapabilities();
      return c.json({ capabilities });
    } catch (err) {
      return handleT3RouteError(err, c);
    }
  })
  .get("/mappings", async (c) => {
    const store = new T3D1Store(c.env.DB);
    const mappings = await store.listProjectMappings();
    return c.json({ mappings });
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
      const { t3ProjectId, t3ProjectTitle } = c.req.valid("json");
      const store = new T3D1Store(c.env.DB);
      const mapping = await store.upsertProjectMapping({
        projectId,
        t3ProjectId,
        t3ProjectTitle,
      });
      return c.json(mapping);
    },
  )
  .delete("/mappings/:projectId", async (c) => {
    const projectId = c.req.param("projectId");
    const store = new T3D1Store(c.env.DB);
    await store.deleteProjectMapping(projectId);
    return c.body(null, HTTP_NO_CONTENT);
  });

export const t3TaskRunsRouter = new Hono<AppEnv>()
  .get("/:id/t3-run", async (c) => {
    const id = c.req.param("id");
    const task = await c.get("storage").getTask(id);
    if (!task) {
      throw new NotFoundError("task", id);
    }
    const status = await getTaskT3RunLiveStatus(buildServiceDeps(c), id);
    return c.json(status);
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
