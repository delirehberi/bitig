import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import { NotFoundError, ValidationError, type StorageMode, type StorageProvider } from "@bitig/core";
import { D1Storage } from "@bitig/storage-d1";
import { parseConfig, type AppConfig } from "./config";
import { apiAuth, bearerAuth } from "./auth";
import { projectsRouter } from "./routes/projects";
import { tasksRouter } from "./routes/tasks";
import { commentsRouter } from "./routes/comments";
import { attachmentsRouter } from "./routes/attachments";
import { backupRouter } from "./routes/backup";
import { mcpRouter } from "./routes/mcp";
import { mcpTokensRouter } from "./routes/mcp-tokens";
import { sessionRouter } from "./routes/session";
import { t3ApiRouter, t3OauthCallbackRouter, t3TaskRunsRouter } from "./routes/t3";
import { webhookReceiverRouter, webhooksApiRouter } from "./routes/webhooks";
import { API_POLICY, MCP_POLICY, WEBHOOK_POLICY, authFailureGuard, rateLimit } from "./rate-limit";
import { csrfProtection } from "./csrf";
import { publishRealtimeEvent, realtimeRouter, withRealtimeBroadcast } from "./realtime";
import { createT3Fetch } from "./t3/client";
import pkg from "../package.json" with { type: "json" };

export interface AppEnv {
  Bindings: Env;
  Variables: {
    config: AppConfig;
    storage: StorageProvider;
    t3Fetch: typeof fetch | undefined;
  };
}

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;
const HTTP_INTERNAL_ERROR = 500;
const CORS_MAX_AGE_SECONDS = 600;

export interface HealthResponse {
  status: "ok";
  version: string;
  storageMode: StorageMode;
}

export interface CreateAppOptions {
  storageFactory?: (env: Env) => StorageProvider;
  config?: AppConfig;
  t3Fetch?: typeof fetch;
}

export function createApp(options?: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const config = options?.config ?? parseConfig(c.env);
    c.set("config", config);
    const hasCfAccess =
      config.T3_CF_ACCESS_CLIENT_ID.length > 0 && config.T3_CF_ACCESS_CLIENT_SECRET.length > 0;
    c.set(
      "t3Fetch",
      hasCfAccess
        ? createT3Fetch(options?.t3Fetch ?? fetch, {
            clientId: config.T3_CF_ACCESS_CLIENT_ID,
            clientSecret: config.T3_CF_ACCESS_CLIENT_SECRET,
          })
        : options?.t3Fetch,
    );
    const baseStorage = options?.storageFactory
      ? options.storageFactory(c.env)
      : new D1Storage({ db: c.env.DB, bucket: c.env.ATTACHMENTS });
    c.set(
      "storage",
      withRealtimeBroadcast(baseStorage, (event) => publishRealtimeEvent(c.env, event)),
    );
    await next();
  });

  app.use(
    "*",
    secureHeaders({
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      referrerPolicy: "no-referrer",
      xFrameOptions: "DENY",
      xContentTypeOptions: "nosniff",
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  app.use(
    "/api/*",
    cors({
      // Hono types this context loosely; re-validate env rather than trusting `any`.
      origin: (origin, c) => (parseConfig(c.env).ALLOWED_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      maxAge: CORS_MAX_AGE_SECONDS,
    }),
  );

  app.get("/health", (c) =>
    c.json<HealthResponse>({
      status: "ok",
      version: pkg.version,
      storageMode: c.get("config").STORAGE_MODE,
    }),
  );

  // Rate limiting and CSRF protection on /api/* routes
  app.use("/api/*", rateLimit(API_POLICY));
  app.use("/api/*", csrfProtection());

  // Clients over the failed-login budget get 429 before any credentials are checked
  app.use("/api/*", authFailureGuard());

  // Sign-in and OAuth PKCE callback routes answer before the guard below
  app.route("/api/auth", sessionRouter);
  app.route("/api/t3/oauth/callback", t3OauthCallbackRouter);

  // A session cookie or Basic credentials guard every other /api/* route
  app.use("/api/*", apiAuth());

  // REST API routes
  app.route("/api/projects", projectsRouter);
  app.route("/api/tasks", tasksRouter);
  app.route("/api/tasks", t3TaskRunsRouter);
  app.route("/api/comments", commentsRouter);
  app.route("/api/attachments", attachmentsRouter);
  app.route("/api/webhooks", webhooksApiRouter);
  app.route("/api/backup", backupRouter);
  app.route("/api/realtime", realtimeRouter);
  app.route("/api/t3", t3ApiRouter);
  app.route("/api/mcp-tokens", mcpTokensRouter);

  // Incoming webhook receiver endpoint guarded by secret token in the URL and rate limiting
  app.use("/webhooks/*", rateLimit(WEBHOOK_POLICY));
  app.use("/webhooks/*", authFailureGuard());
  app.route("/webhooks", webhookReceiverRouter);

  // Remote MCP endpoint guarded by Bearer token authentication and rate limiting
  app.use("/mcp", rateLimit(MCP_POLICY));
  app.use("/mcp/*", rateLimit(MCP_POLICY));
  app.use("/mcp", authFailureGuard());
  app.use("/mcp/*", authFailureGuard());
  app.use("/mcp", bearerAuth());
  app.use("/mcp/*", bearerAuth());
  app.route("/mcp", mcpRouter);

  app.notFound((c) => c.json({ error: "not_found" }, HTTP_NOT_FOUND));

  app.onError((err, c) => {
    if (err instanceof NotFoundError) {
      return c.json({ error: "not_found", message: err.message }, HTTP_NOT_FOUND);
    }
    if (err instanceof ValidationError) {
      // `details` matches the route validators' shape, so API clients can rebuild the error.
      return c.json(
        { error: "validation_error", message: err.message, details: err.issues },
        HTTP_BAD_REQUEST,
      );
    }
    if (err instanceof HTTPException) {
      return err.getResponse();
    }
    // Log the details server-side; never leak internals to the client.
    console.error("unhandled worker error", { path: c.req.path, error: err });
    return c.json({ error: "internal_error" }, HTTP_INTERNAL_ERROR);
  });

  return app;
}

const app = createApp();

// Durable Object classes must be exported from the Worker's main module.
export { RateLimiter } from "./rate-limiter-do";
export { RealtimeHub } from "./realtime-do";
export { LoginChallenge } from "./login-challenge-do";

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
