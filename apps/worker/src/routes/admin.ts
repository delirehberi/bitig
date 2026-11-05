import { Hono } from "hono";
import {
  NotFoundError,
  PlatformRoleSchema,
  UserStatusSchema,
  UsernameSchema,
} from "@bitig/core";
import {
  D1AccessTokenStore,
  D1AuthCodeStore,
  D1OrganisationStore,
  D1SessionStore,
  D1Storage,
  D1UserStore,
} from "@bitig/storage-d1";
import { z } from "zod";
import type { AppEnv } from "../index";
import { requireAdmin } from "../auth";
import { generateSixDigitCode, sha256Hex } from "../auth-crypto";
import { buildSignInCodeEmail } from "../mailer";
import { disconnectRealtimeUser } from "../realtime";
import { deleteUserAccount } from "./me";

const createAdminUserBodySchema = z.object({
  email: z.email(),
  username: UsernameSchema.optional(),
  displayName: z.string().trim().max(120).optional(),
  platformRole: PlatformRoleSchema.default("user"),
});

const updateAdminUserBodySchema = z.object({
  username: UsernameSchema.optional(),
  displayName: z.string().trim().max(120).optional(),
  platformRole: PlatformRoleSchema.optional(),
  status: UserStatusSchema.optional(),
});

function deriveUsernameFromEmail(email: string): string {
  const local = (email.split("@")[0] ?? "user")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (local.length >= 2) return local.slice(0, 32);
  return `user-${local || "account"}`;
}

export const adminRouter = new Hono<AppEnv>();

adminRouter.use("*", requireAdmin());

adminRouter.get("/users", async (c) => {
  const search = c.req.query("search") ?? c.req.query("q") ?? undefined;
  const roleParam = c.req.query("platformRole") ?? c.req.query("role") ?? undefined;
  const statusParam = c.req.query("status") ?? undefined;
  const limitParam = c.req.query("limit");
  const offsetParam = c.req.query("offset");

  const platformRole = roleParam ? PlatformRoleSchema.safeParse(roleParam).data : undefined;
  const status = statusParam ? UserStatusSchema.safeParse(statusParam).data : undefined;
  const limit = limitParam ? Math.min(200, Math.max(1, Number.parseInt(limitParam, 10) || 50)) : 50;
  const offset = offsetParam ? Math.max(0, Number.parseInt(offsetParam, 10) || 0) : 0;

  const userStore = new D1UserStore(c.env.DB);
  const orgStore = new D1OrganisationStore(c.env.DB);
  const allMatching = await userStore.list({
    search,
    platformRole,
    status,
  });
  const sliced = allMatching.slice(offset, offset + limit);

  const usersWithOrgCount = await Promise.all(
    sliced.map(async (u) => {
      const memberships = await orgStore.listForUser(u.id);
      return {
        ...u,
        orgCount: memberships.length,
      };
    }),
  );

  return c.json({
    users: usersWithOrgCount,
    total: allMatching.length,
    limit,
    offset,
  });
});

adminRouter.get("/users/:id", async (c) => {
  const userStore = new D1UserStore(c.env.DB);
  const orgStore = new D1OrganisationStore(c.env.DB);
  const user = await userStore.getById(c.req.param("id"));
  if (!user) {
    throw new NotFoundError("user", c.req.param("id"));
  }
  const memberships = await orgStore.listForUser(user.id);
  return c.json({ user, memberships });
});

adminRouter.post("/users", async (c) => {
  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = createAdminUserBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const userStore = new D1UserStore(c.env.DB);
  const email = parsed.data.email.trim().toLowerCase();
  let username = parsed.data.username ?? deriveUsernameFromEmail(email);
  if (!parsed.data.username) {
    const existing = await userStore.getByUsername(username);
    if (existing) {
      username = `${username.slice(0, 24)}-${crypto.randomUUID().slice(0, 6)}`;
    }
  }

  const created = await userStore.create({
    email,
    username,
    displayName: parsed.data.displayName ?? username,
    platformRole: parsed.data.platformRole,
    status: "active",
  });

  // Send a sign-in code so the new user can immediately sign in
  const code = generateSixDigitCode();
  const codeHash = await sha256Hex(code);
  const authCodeStore = new D1AuthCodeStore(c.env.DB);
  await authCodeStore.issue({
    email: created.email,
    purpose: "sign_in",
    codeHash,
  });

  const mailer = c.get("mailer");
  await mailer.send(buildSignInCodeEmail(created.email, code));

  return c.json({ user: created }, 201);
});

adminRouter.patch("/users/:id", async (c) => {
  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = updateAdminUserBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const targetId = c.req.param("id");
  const userStore = new D1UserStore(c.env.DB);
  const orgStore = new D1OrganisationStore(c.env.DB);
  const memberships = await orgStore.listForUser(targetId);

  const updated = await userStore.update(targetId, parsed.data);

  if (parsed.data.status === "disabled") {
    const sessionStore = new D1SessionStore(c.env.DB);
    const tokenStore = new D1AccessTokenStore(c.env.DB);
    await sessionStore.deleteAllForUser(targetId);
    await tokenStore.revokeAllForUser(targetId);
    for (const m of memberships) {
      await disconnectRealtimeUser(c.env, m.organisation.id, targetId);
    }
  }

  return c.json({ user: updated });
});

adminRouter.delete("/users/:id", async (c) => {
  const targetId = c.req.param("id");
  await deleteUserAccount(c.env, targetId);
  return c.json({ ok: true });
});

adminRouter.get("/orgs", async (c) => {
  const orgStore = new D1OrganisationStore(c.env.DB);
  const orgs = await orgStore.listAll();
  const detailed = await Promise.all(
    orgs.map(async (org) => {
      const members = await orgStore.listMembers(org.id);
      const orgStorage = new D1Storage({
        db: c.env.DB,
        bucket: c.env.ATTACHMENTS,
        orgId: org.id,
      });
      const projects = await orgStorage.getProjects();
      return {
        ...org,
        memberCount: members.length,
        projectCount: projects.length,
      };
    }),
  );
  return c.json({ organisations: detailed });
});
