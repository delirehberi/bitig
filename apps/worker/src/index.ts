import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { HTTPException } from "hono/http-exception";
import {
  NotFoundError,
  ProjectBusyError,
  ValidationError,
  type OrganisationRole,
  type StorageMode,
  type StorageProvider,
  type User,
} from "@bitig/core";
import { D1Storage } from "@bitig/storage-d1";
import { parseConfig, type AppConfig } from "./config";
import { ForbiddenRoleError, apiAuth, bearerAuth } from "./auth";
import { MailerError, createMailer, type Mailer } from "./mailer";
import { createNostrProfileFetcher, type NostrProfileFetcher } from "./nostr-profile";
import { projectsRouter } from "./routes/projects";
import { tasksRouter } from "./routes/tasks";
import { commentsRouter } from "./routes/comments";
import { attachmentsRouter } from "./routes/attachments";
import { backupRouter } from "./routes/backup";
import { mcpRouter } from "./routes/mcp";
import { mcpTokensRouter } from "./routes/mcp-tokens";
import { sessionRouter } from "./routes/session";
import { meRouter } from "./routes/me";
import { invitationsAcceptRouter, invitationsPublicRouter, orgsRouter } from "./routes/orgs";
import { adminRouter } from "./routes/admin";
import { t3ApiRouter, t3OauthCallbackRouter, t3TaskRunsRouter } from "./routes/t3";
import { webhookReceiverRouter, webhooksApiRouter } from "./routes/webhooks";
import {
  applyPublicFeedbackSecurityHeaders,
  feedbackFormsRouter,
  projectFeedbackFormsRouter,
  publicFeedbackRouter,
  runScheduledFeedbackCleanup,
  taskFeedbackRouter,
} from "./routes/feedback";
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
    customStorageFactory: boolean;
    t3Fetch: typeof fetch | undefined;
    mailer: Mailer;
    nostrProfileFetcher: NostrProfileFetcher;
    user: User | undefined;
    sessionId: string | undefined;
    orgId: string | undefined;
    orgRole: OrganisationRole | undefined;
    feedbackAllowedOrigins: string[] | undefined;
  };
}

const HTTP_NOT_FOUND = 404;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;
const HTTP_BAD_GATEWAY = 502;
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
  mailer?: Mailer;
  nostrProfileFetcher?: NostrProfileFetcher;
}

export function createApp(options?: CreateAppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const config = options?.config ?? parseConfig(c.env);
    c.set("config", config);
    c.set("customStorageFactory", Boolean(options?.storageFactory));
    c.set(
      "mailer",
      options?.mailer ??
        createMailer({
          emailBinding: c.env.EMAIL,
          resendApiKey: config.RESEND_API_KEY,
          mailFrom: config.MAIL_FROM,
        }),
    );
    c.set(
      "nostrProfileFetcher",
      options?.nostrProfileFetcher ?? createNostrProfileFetcher({ relays: config.NOSTR_PROFILE_RELAYS }),
    );
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

  app.use("/f/*", async (c, next) => {
    await next();
    applyPublicFeedbackSecurityHeaders(c);
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
        imgSrc: ["'self'", "data:", "blob:", "https:"],
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

  // Public feedback form page and submission endpoint (outside /api/*)
  app.route("/f", publicFeedbackRouter);

  // Rate limiting and CSRF protection on /api/* routes
  app.use("/api/*", rateLimit(API_POLICY));
  app.use("/api/*", csrfProtection());

  // Clients over the failed-login budget get 429 before any credentials are checked
  app.use("/api/*", authFailureGuard());

  // Sign-in, public invitation preview, and OAuth PKCE callback routes answer before the guard below
  app.route("/api/auth", sessionRouter);
  app.route("/api/invitations", invitationsPublicRouter);
  app.route("/api/t3/oauth/callback", t3OauthCallbackRouter);

  // A session cookie or Bearer personal access token guards every other /api/* route
  app.use("/api/*", apiAuth());

  // Multi-user account, organisation, invitation and admin routes
  app.route("/api/me", meRouter);
  app.route("/api/orgs", orgsRouter);
  app.route("/api/invitations", invitationsAcceptRouter);
  app.route("/api/admin", adminRouter);

  // REST API routes
  app.route("/api/projects", projectsRouter);
  app.route("/api/projects", projectFeedbackFormsRouter);
  app.route("/api/feedback-forms", feedbackFormsRouter);
  app.route("/api/tasks", tasksRouter);
  app.route("/api/tasks", taskFeedbackRouter);
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
    if (err instanceof ProjectBusyError) {
      const HTTP_CONFLICT = 409;
      return c.json({ error: "project_busy", message: err.message }, HTTP_CONFLICT);
    }
    if (err instanceof ForbiddenRoleError) {
      return c.json({ error: "forbidden", message: err.message }, HTTP_FORBIDDEN);
    }
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
    if (err instanceof MailerError) {
      return c.json(
        {
          error: "email_delivery_failed",
          message:
            "Could not send verification email. Ensure Cloudflare Email Sending is enabled for the sender domain or RESEND_API_KEY is configured.",
        },
        HTTP_BAD_GATEWAY,
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

export { runScheduledFeedbackCleanup } from "./routes/feedback";

export async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const now = controller.scheduledTime ? new Date(controller.scheduledTime) : undefined;
  const cleanupPromise = runScheduledFeedbackCleanup(env, { now });
  ctx.waitUntil(cleanupPromise);
  await cleanupPromise;
}

// Durable Object classes must be exported from the Worker's main module.
export { RateLimiter } from "./rate-limiter-do";
export { RealtimeHub } from "./realtime-do";
export { LoginChallenge } from "./login-challenge-do";

export default {
  fetch: app.fetch,
  scheduled,
} satisfies ExportedHandler<Env>;
