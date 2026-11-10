import type { Context, MiddlewareHandler } from "hono";
import {
  BOOTSTRAP_ADMIN_USER_ID,
  DEFAULT_ORGANISATION_ID,
  IdSchema,
  hasMinimumOrgRole,
  type McpTokenTransport,
  type OperationOptions,
  type OrganisationRole,
  type StorageProvider,
  type User,
} from "@bitig/core";
import {
  D1AccessTokenStore,
  D1OrganisationStore,
  D1Storage,
  D1UserStore,
  McpTokenStore,
  T3D1Store,
} from "@bitig/storage-d1";
import type { AppEnv } from "./index";
import { ACCESS_TOKEN_PREFIX, sha256Hex } from "./auth-crypto";
import { ensureBootstrap, TEST_BOOTSTRAP_TOKEN_ID } from "./bootstrap";
import { recordAuthFailure } from "./rate-limit";
import { publishRealtimeEvent, withRealtimeBroadcast } from "./realtime";
import { readSession } from "./session";
import { digestMcpToken, MANAGED_MCP_TOKEN_PATTERN } from "./mcp-token-crypto";

const BEARER_PREFIX = "Bearer ";
const MCP_REALM_HEADER_VALUE = 'Bearer realm="bitig-mcp"';
const URL_TOKEN_PARAM = "token";
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAVAILABLE = 503;

export class ForbiddenRoleError extends Error {
  override readonly name = "ForbiddenRoleError";
}

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

function assertMinRole(actual: OrganisationRole | undefined, min: OrganisationRole): void {
  if (!actual || !hasMinimumOrgRole(actual, min)) {
    throw new ForbiddenRoleError(`Forbidden: ${min} role required`);
  }
}

export interface StorageGuardOptions {
  readonly user?: User | undefined;
  readonly orgRole?: OrganisationRole | undefined;
  readonly strictHumanAttribution?: boolean | undefined;
  readonly isMcp?: boolean | undefined;
  readonly beforeDeleteProject?: ((projectId: string) => Promise<void>) | undefined;
}

function applyUserOpts(
  opts: OperationOptions | undefined,
  guard: StorageGuardOptions,
): OperationOptions | undefined {
  const { user, strictHumanAttribution, isMcp } = guard;
  if (!user) return opts;
  if (strictHumanAttribution) {
    return {
      ...opts,
      actor: user.displayName,
      userId: user.id,
      ...(user.avatarUrl !== undefined ? { userAvatarUrl: user.avatarUrl } : {}),
    };
  }
  if (isMcp) {
    return {
      ...opts,
      actor: opts?.actor ?? user.displayName,
      userId: user.id,
      ...(user.avatarUrl !== undefined ? { userAvatarUrl: user.avatarUrl } : {}),
    };
  }
  return opts;
}

export function withUserAndRoleGuard(
  storage: StorageProvider,
  guard: StorageGuardOptions,
): StorageProvider {
  const { user, orgRole, strictHumanAttribution, isMcp } = guard;
  return {
    getProjects: (opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getProjects(opts);
    },
    getProject: (id, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getProject(id, opts);
    },
    createProject: (input, opts) => {
      assertMinRole(orgRole, "owner");
      return storage.createProject(input, applyUserOpts(opts, guard));
    },
    updateProject: (id, patch, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.updateProject(id, patch, applyUserOpts(opts, guard));
    },
    deleteProject: async (id, opts) => {
      assertMinRole(orgRole, "owner");
      await guard.beforeDeleteProject?.(id);
      return storage.deleteProject(id, applyUserOpts(opts, guard));
    },

    getTasks: (filter, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getTasks(filter, opts);
    },
    getTask: (id, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getTask(id, opts);
    },
    saveTask: (input, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.saveTask(input, applyUserOpts(opts, guard));
    },
    updateTask: (id, patch, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.updateTask(id, patch, applyUserOpts(opts, guard));
    },
    deleteTask: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.deleteTask(id, applyUserOpts(opts, guard));
    },
    completeTask: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.completeTask(id, applyUserOpts(opts, guard));
    },

    getCheckpoints: (taskId, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getCheckpoints(taskId, opts);
    },
    saveCheckpoint: (input, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.saveCheckpoint(input, applyUserOpts(opts, guard));
    },

    getComments: (taskId, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getComments(taskId, opts);
    },
    addComment: (input, opts) => {
      assertMinRole(orgRole, "editor");
      if (user && strictHumanAttribution) {
        return storage.addComment(
          {
            ...input,
            authorType: "human",
            author: user.displayName,
            authorId: user.id,
            ...(user.avatarUrl !== undefined ? { authorAvatarUrl: user.avatarUrl } : {}),
          },
          applyUserOpts(opts, guard),
        );
      }
      if (user && isMcp) {
        return storage.addComment(
          {
            ...input,
            authorId: user.id,
            ...(user.avatarUrl !== undefined ? { authorAvatarUrl: user.avatarUrl } : {}),
          },
          applyUserOpts(opts, guard),
        );
      }
      return storage.addComment(input, opts);
    },
    deleteComment: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.deleteComment(id, applyUserOpts(opts, guard));
    },

    getAttachments: (taskId, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getAttachments(taskId, opts);
    },
    getAttachment: (id, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getAttachment(id, opts);
    },
    addAttachment: (input, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.addAttachment(input, applyUserOpts(opts, guard));
    },
    deleteAttachment: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.deleteAttachment(id, applyUserOpts(opts, guard));
    },

    getWebhooks: (filter, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getWebhooks(filter, opts);
    },
    getWebhook: (id, opts) => {
      assertMinRole(orgRole, "viewer");
      return storage.getWebhook(id, opts);
    },
    getWebhookByToken: (token, opts) => storage.getWebhookByToken(token, opts),
    createWebhook: (input, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.createWebhook(input, applyUserOpts(opts, guard));
    },
    updateWebhook: (id, patch, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.updateWebhook(id, patch, applyUserOpts(opts, guard));
    },
    deleteWebhook: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.deleteWebhook(id, applyUserOpts(opts, guard));
    },
    recordWebhookTrigger: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.recordWebhookTrigger(id, applyUserOpts(opts, guard));
    },

    exportProject: (id, opts) => {
      assertMinRole(orgRole, "editor");
      return storage.exportProject(id, opts);
    },
    importProject: (bundle, opts) => {
      assertMinRole(orgRole, "owner");
      return storage.importProject(bundle, applyUserOpts(opts, guard));
    },
    exportAll: (opts) => {
      assertMinRole(orgRole, "editor");
      return storage.exportAll(opts);
    },
    importBackup: (backup, opts) => {
      assertMinRole(orgRole, "owner");
      return storage.importBackup(backup, applyUserOpts(opts, guard));
    },
  };
}

function isUserOrAdminPath(path: string): boolean {
  return (
    path === "/api/me" ||
    path.startsWith("/api/me/") ||
    path === "/api/orgs" ||
    path.startsWith("/api/orgs/") ||
    path === "/api/invitations/accept" ||
    path.startsWith("/api/admin/") ||
    path === "/api/admin"
  );
}

function configureScopedStorage(c: Context<AppEnv>, guard: StorageGuardOptions, orgId: string): void {
  const baseStorage = c.get("customStorageFactory")
    ? c.get("storage")
    : withRealtimeBroadcast(
        new D1Storage({ db: c.env.DB, bucket: c.env.ATTACHMENTS, orgId }),
        (event) => publishRealtimeEvent(c.env, event, orgId),
      );
  c.set("storage", withUserAndRoleGuard(baseStorage, {
    ...guard,
    beforeDeleteProject: (projectId) => new T3D1Store(c.env.DB, orgId).assertProjectIdle(projectId),
  }));
}

export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get("user");
    if (user?.platformRole !== "admin") {
      return c.json({ error: "forbidden", message: "Platform admin access required" }, HTTP_FORBIDDEN);
    }
    return next();
  };
}

export function requireOrgRole(minRole: OrganisationRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const orgId = c.get("orgId");
    const role = c.get("orgRole");
    if (!orgId || !role) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    if (!hasMinimumOrgRole(role, minRole)) {
      return c.json({ error: "forbidden", message: `Requires ${minRole} role` }, HTTP_FORBIDDEN);
    }
    return next();
  };
}

function requiredWorkspaceRole(method: string, path: string): OrganisationRole {
  if (path === "/api/backup/restore") return "owner";
  if (path === "/api/backup" || /^\/api\/projects\/[^/]+\/export$/.test(path)) return "editor";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return "viewer";
  return "editor";
}

/*
 * Guards /api/*. The dashboard authenticates with the server-side session
 * cookie set by POST /api/auth/verify; scripts and API clients authenticate
 * with a per-user personal access token (`Authorization: Bearer btg_...`).
 */
export function apiAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get("config");
    const unauthorized = () => c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);

    const session = await readSession(c);
    if (session.kind === "forged") await recordAuthFailure(c);

    let user: User | undefined;
    let tokenOrgId: string | undefined;
    let tokenRole: OrganisationRole | undefined;
    let tokenId: string | undefined;

    if (session.kind === "valid") {
      user = session.user;
    } else {
      const authHeader = c.req.header("Authorization");
      if (authHeader === undefined) return unauthorized();
      if (!authHeader.startsWith(BEARER_PREFIX)) {
        await recordAuthFailure(c);
        return unauthorized();
      }
      const rawToken = authHeader.slice(BEARER_PREFIX.length).trim();
      if (!rawToken.startsWith(ACCESS_TOKEN_PREFIX)) {
        await recordAuthFailure(c);
        return unauthorized();
      }
      await ensureBootstrap(c.env.DB, config);
      const verified = await new D1AccessTokenStore(c.env.DB).verifyByHash(await sha256Hex(rawToken));
      if (!verified) {
        await recordAuthFailure(c);
        return unauthorized();
      }
      user = verified.user;
      tokenOrgId = verified.orgId;
      tokenRole = verified.orgRole;
      tokenId = verified.token.id;
      c.set("user", user);
    }

    const headerOrg = c.req.header("X-Bitig-Org")?.trim();
    const queryOrg = c.req.query("orgId")?.trim();
    const requestedOrgRef =
      headerOrg && headerOrg.length > 0
        ? headerOrg
        : queryOrg && queryOrg.length > 0
          ? queryOrg
          : undefined;
    const orgStore = new D1OrganisationStore(c.env.DB);
    const userOrAdmin = isUserOrAdminPath(c.req.path);
    const minRole = requiredWorkspaceRole(c.req.method, c.req.path);

    if (tokenOrgId !== undefined && tokenRole !== undefined) {
      if (requestedOrgRef) {
        const org = await orgStore.getById(tokenOrgId);
        if (!org || (requestedOrgRef !== org.id && requestedOrgRef !== org.slug)) {
          return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
        }
      }
      c.set("orgId", tokenOrgId);
      c.set("orgRole", tokenRole);
      if (!userOrAdmin && !hasMinimumOrgRole(tokenRole, minRole)) {
        return c.json({ error: "forbidden", message: `Requires ${minRole} role` }, HTTP_FORBIDDEN);
      }
      const strictHumanAttribution =
        !c.get("customStorageFactory") && tokenId !== TEST_BOOTSTRAP_TOKEN_ID;
      configureScopedStorage(c, { user, orgRole: tokenRole, strictHumanAttribution }, tokenOrgId);
      return next();
    }

    if (requestedOrgRef) {
      const org = IdSchema.safeParse(requestedOrgRef).success
        ? await orgStore.getById(requestedOrgRef)
        : await orgStore.getBySlug(requestedOrgRef);
      if (!org) {
        return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
      }
      const membership = await orgStore.getMembership(org.id, user.id);
      if (!membership) {
        return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
      }
      c.set("orgId", org.id);
      c.set("orgRole", membership.role);
      if (!userOrAdmin && !hasMinimumOrgRole(membership.role, minRole)) {
        return c.json({ error: "forbidden", message: `Requires ${minRole} role` }, HTTP_FORBIDDEN);
      }
      configureScopedStorage(
        c,
        { user, orgRole: membership.role, strictHumanAttribution: !c.get("customStorageFactory") },
        org.id,
      );
      return next();
    }

    const memberships = await orgStore.listForUser(user.id);
    const preferred =
      memberships.find((m) => m.organisation.id === DEFAULT_ORGANISATION_ID) ?? memberships[0];
    if (preferred) {
      c.set("orgId", preferred.organisation.id);
      c.set("orgRole", preferred.role);
      if (!userOrAdmin && !hasMinimumOrgRole(preferred.role, minRole)) {
        return c.json({ error: "forbidden", message: `Requires ${minRole} role` }, HTTP_FORBIDDEN);
      }
      configureScopedStorage(
        c,
        { user, orgRole: preferred.role, strictHumanAttribution: !c.get("customStorageFactory") },
        preferred.organisation.id,
      );
      return next();
    }

    if (userOrAdmin) {
      return next();
    }

    return c.json({ error: "not_found", message: "No organisation membership found" }, HTTP_NOT_FOUND);
  };
}

async function resolveLegacyOrManagedMcpTokenOrgId(
  db: D1Database,
  token: string,
  legacyToken: string,
  transport: McpTokenTransport,
): Promise<string | null> {
  if (legacyToken && (await timingSafeEqualString(token, legacyToken))) {
    return DEFAULT_ORGANISATION_ID;
  }
  if (!MANAGED_MCP_TOKEN_PATTERN.test(token)) return null;
  return new McpTokenStore(db).resolveOrgId(
    await digestMcpToken(token),
    transport,
    new Date().toISOString(),
  );
}

/*
 * Guards /mcp. Clients authenticate with a per-user personal access token
 * (`Authorization: Bearer btg_...`), which scopes `/mcp` to that token's
 * organisation and user role. Also supports managed MCP tokens (`bitig_mcp_...`)
 * and legacy `MCP_AUTH_TOKEN` / `MCP_URL_TOKEN` bindings (associated with the
 * bootstrap admin in the default organisation).
 */
export function bearerAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get("config");
    const unauthorized = () =>
      c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": MCP_REALM_HEADER_VALUE,
      });

    const authHeader = c.req.header("Authorization");
    if (authHeader === undefined) {
      const urlToken = c.req.query(URL_TOKEN_PARAM);
      if (urlToken === undefined) return unauthorized();
      let resolvedOrgId: string | null;
      try {
        resolvedOrgId = await resolveLegacyOrManagedMcpTokenOrgId(
          c.env.DB,
          urlToken,
          config.MCP_URL_TOKEN,
          "query",
        );
      } catch {
        return c.json(
          { error: "unavailable", message: "MCP token verification is temporarily unavailable." },
          HTTP_UNAVAILABLE,
        );
      }
      if (!resolvedOrgId) {
        await recordAuthFailure(c);
        return unauthorized();
      }
      c.set("orgId", resolvedOrgId);
      c.set("orgRole", "owner");
      configureScopedStorage(c, { orgRole: "owner", isMcp: true }, resolvedOrgId);
      return next();
    }

    if (!authHeader.startsWith(BEARER_PREFIX)) {
      await recordAuthFailure(c);
      return unauthorized();
    }

    const token = authHeader.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      await recordAuthFailure(c);
      return unauthorized();
    }

    if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
      await ensureBootstrap(c.env.DB, config);
      const verified = await new D1AccessTokenStore(c.env.DB).verifyByHash(await sha256Hex(token));
      if (!verified) {
        await recordAuthFailure(c);
        return unauthorized();
      }
      c.set("user", verified.user);
      c.set("orgId", verified.orgId);
      c.set("orgRole", verified.orgRole);
      configureScopedStorage(
        c,
        { user: verified.user, orgRole: verified.orgRole, isMcp: true },
        verified.orgId,
      );
      return next();
    }

    if (!config.MCP_AUTH_TOKEN && !MANAGED_MCP_TOKEN_PATTERN.test(token)) {
      return unauthorized();
    }
    let resolvedOrgId: string | null;
    try {
      resolvedOrgId = await resolveLegacyOrManagedMcpTokenOrgId(
        c.env.DB,
        token,
        config.MCP_AUTH_TOKEN,
        "bearer",
      );
    } catch {
      return c.json(
        { error: "unavailable", message: "MCP token verification is temporarily unavailable." },
        HTTP_UNAVAILABLE,
      );
    }
    if (!resolvedOrgId) {
      await recordAuthFailure(c);
      return unauthorized();
    }

    try {
      await ensureBootstrap(c.env.DB, config);
      const bootstrapUser = await new D1UserStore(c.env.DB).getById(BOOTSTRAP_ADMIN_USER_ID);
      if (bootstrapUser) c.set("user", bootstrapUser);
    } catch {
      // Tables may not be initialized in unit tests that mock only mcp_tokens.
    }
    c.set("orgId", resolvedOrgId);
    c.set("orgRole", "owner");
    configureScopedStorage(c, { orgRole: "owner", isMcp: true }, resolvedOrgId);
    return next();
  };
}
