import { Hono } from "hono";
import {
  IdSchema,
  NotFoundError,
  OrganisationRoleSchema,
  OrganisationSlugSchema,
  ValidationError,
  hasMinimumOrgRole,
} from "@bitig/core";
import {
  D1AccessTokenStore,
  D1InvitationStore,
  D1OrganisationStore,
  D1Storage,
  D1UserStore,
} from "@bitig/storage-d1";
import { z } from "zod";
import type { AppEnv } from "../index";
import { ForbiddenRoleError } from "../auth";
import { generateOpaqueToken, sha256Hex } from "../auth-crypto";
import { buildInvitationEmail } from "../mailer";
import { disconnectRealtimeUser } from "../realtime";

const createOrgBodySchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  slug: OrganisationSlugSchema.optional(),
});

const updateOrgBodySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: OrganisationSlugSchema.optional(),
});

const updateMemberRoleBodySchema = z.object({
  role: OrganisationRoleSchema,
});

const createInvitationBodySchema = z.object({
  email: z.email(),
  role: OrganisationRoleSchema.default("editor"),
});

const acceptInvitationBodySchema = z.object({
  token: z.string().trim().min(1),
});

export const orgsRouter = new Hono<AppEnv>();

async function resolveOrgForMember(db: D1Database, idOrSlug: string, userId: string) {
  const orgStore = new D1OrganisationStore(db);
  const org = IdSchema.safeParse(idOrSlug).success
    ? await orgStore.getById(idOrSlug)
    : await orgStore.getBySlug(idOrSlug);
  if (!org) {
    throw new NotFoundError("organisation", idOrSlug);
  }
  const membership = await orgStore.getMembership(org.id, userId);
  if (!membership) {
    // Non-members get 404 so organisation existence is not leaked
    throw new NotFoundError("organisation", idOrSlug);
  }
  return { orgStore, org, membership };
}

orgsRouter.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const orgStore = new D1OrganisationStore(c.env.DB);
  const organisations = await orgStore.listForUser(user.id);
  return c.json({ organisations });
});

orgsRouter.post("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = createOrgBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const orgStore = new D1OrganisationStore(c.env.DB);
  const organisation = await orgStore.create(
    {
      name: parsed.data.name,
      ...(parsed.data.slug ? { slug: parsed.data.slug } : {}),
    },
    user.id,
  );

  return c.json({ organisation, role: "owner" as const }, 201);
});

orgsRouter.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { org, membership } = await resolveOrgForMember(c.env.DB, c.req.param("id"), user.id);
  return c.json({ organisation: org, role: membership.role });
});

orgsRouter.patch("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { orgStore, org, membership } = await resolveOrgForMember(
    c.env.DB,
    c.req.param("id"),
    user.id,
  );
  if (!hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = updateOrgBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const updated = await orgStore.rename(org.id, parsed.data);
  return c.json({ organisation: updated, role: membership.role });
});

orgsRouter.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { orgStore, org, membership } = await resolveOrgForMember(
    c.env.DB,
    c.req.param("id"),
    user.id,
  );
  if (!hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  const members = await orgStore.listMembers(org.id);
  await orgStore.delete(org.id);

  for (const member of members) {
    await disconnectRealtimeUser(c.env, org.id, member.userId);
  }

  return c.json({ ok: true });
});

orgsRouter.get("/:id/export", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { org, membership } = await resolveOrgForMember(c.env.DB, c.req.param("id"), user.id);
  if (!hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  const orgStorage = new D1Storage({
    db: c.env.DB,
    bucket: c.env.ATTACHMENTS,
    orgId: org.id,
  });
  const backup = await orgStorage.exportAll();
  return c.json({
    organisation: {
      id: org.id,
      name: org.name,
      slug: org.slug,
    },
    backup,
  });
});

orgsRouter.get("/:id/members", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { orgStore, org } = await resolveOrgForMember(c.env.DB, c.req.param("id"), user.id);
  const invStore = new D1InvitationStore(c.env.DB);
  const userStore = new D1UserStore(c.env.DB);
  const [rawMembers, invitations] = await Promise.all([
    orgStore.listMembers(org.id),
    invStore.listPendingForOrg(org.id),
  ]);

  const members = await Promise.all(
    rawMembers.map(async (m) => {
      const memberUser = await userStore.getById(m.userId);
      return {
        ...m,
        email: memberUser?.email ?? "",
        username: memberUser?.username ?? m.userId,
        displayName: memberUser?.displayName ?? m.userId,
        ...(memberUser?.avatarUrl !== undefined ? { avatarUrl: memberUser.avatarUrl } : {}),
      };
    }),
  );

  return c.json({ members, invitations });
});

orgsRouter.patch("/:id/members/:userId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { orgStore, org, membership } = await resolveOrgForMember(
    c.env.DB,
    c.req.param("id"),
    user.id,
  );
  if (!hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = updateMemberRoleBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const targetUserId = c.req.param("userId");
  const updated = await orgStore.updateMemberRole(org.id, targetUserId, parsed.data.role);
  return c.json({ membership: updated });
});

orgsRouter.delete("/:id/members/:userId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { orgStore, org, membership } = await resolveOrgForMember(
    c.env.DB,
    c.req.param("id"),
    user.id,
  );
  const targetUserId = c.req.param("userId");
  const isSelf = targetUserId === user.id;
  if (!isSelf && !hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  await orgStore.removeMember(org.id, targetUserId);
  const tokenStore = new D1AccessTokenStore(c.env.DB);
  await tokenStore.revokeAllForUserInOrg(targetUserId, org.id);
  await disconnectRealtimeUser(c.env, org.id, targetUserId);

  return c.json({ ok: true });
});

orgsRouter.get("/:id/invitations", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { org } = await resolveOrgForMember(c.env.DB, c.req.param("id"), user.id);
  const invStore = new D1InvitationStore(c.env.DB);
  const invitations = await invStore.listPendingForOrg(org.id);
  return c.json({ invitations });
});

orgsRouter.post("/:id/invitations", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { orgStore, org, membership } = await resolveOrgForMember(
    c.env.DB,
    c.req.param("id"),
    user.id,
  );
  if (!hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = createInvitationBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const email = parsed.data.email.trim().toLowerCase();
  const userStore = new D1UserStore(c.env.DB);
  const existingUser = await userStore.getByEmail(email);
  if (existingUser) {
    const existingMembership = await orgStore.getMembership(org.id, existingUser.id);
    if (existingMembership) {
      throw new ValidationError("createInvitation", [
        {
          code: "custom",
          path: ["email"],
          message: `User ${email} is already a member of this organisation`,
          input: email,
        },
      ]);
    }
  }

  const rawToken = generateOpaqueToken(24);
  const tokenHash = await sha256Hex(rawToken);
  const invStore = new D1InvitationStore(c.env.DB);
  const invitation = await invStore.create({
    orgId: org.id,
    email,
    role: parsed.data.role,
    tokenHash,
    invitedBy: user.id,
  });

  const requestUrl = new URL(c.req.url);
  const origin = c.req.header("Origin") ?? `${requestUrl.protocol}//${requestUrl.host}`;
  const acceptUrl = `${origin}/login?invite=${encodeURIComponent(rawToken)}`;

  const mailer = c.get("mailer");
  await mailer.send(
    buildInvitationEmail({
      to: email,
      orgName: org.name,
      inviterName: user.displayName || user.username,
      role: parsed.data.role,
      acceptUrl,
    }),
  );

  return c.json({ invitation, token: rawToken, acceptUrl }, 201);
});

orgsRouter.delete("/:id/invitations/:invId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const { org, membership } = await resolveOrgForMember(c.env.DB, c.req.param("id"), user.id);
  if (!hasMinimumOrgRole(membership.role, "owner")) {
    throw new ForbiddenRoleError("owner role required");
  }

  const invStore = new D1InvitationStore(c.env.DB);
  const revoked = await invStore.revoke(c.req.param("invId"), org.id);
  if (!revoked) {
    throw new NotFoundError("invitation", c.req.param("invId"));
  }
  return c.json({ ok: true });
});

export const invitationsPublicRouter = new Hono<AppEnv>();

invitationsPublicRouter.get("/info", async (c) => {
  const rawToken = c.req.query("token")?.trim() ?? "";
  if (!rawToken) {
    return c.json({ error: "validation_error", message: "Missing token parameter" }, 400);
  }
  const tokenHash = await sha256Hex(rawToken);
  const invStore = new D1InvitationStore(c.env.DB);
  const inv = await invStore.getByTokenHash(tokenHash);
  if (!inv) {
    return c.json({ error: "not_found", message: "Invitation is invalid or expired" }, 404);
  }
  return c.json({
    invitation: {
      id: inv.id,
      orgId: inv.orgId,
      orgName: inv.orgName,
      orgSlug: inv.orgSlug,
      email: inv.email,
      role: inv.role,
      expiresAt: inv.expiresAt,
    },
  });
});

export const invitationsAcceptRouter = new Hono<AppEnv>();

invitationsAcceptRouter.post("/accept", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const rawBody: unknown = await c.req.json().catch(() => null);
  const parsed = acceptInvitationBodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.issues }, 400);
  }

  const tokenHash = await sha256Hex(parsed.data.token);
  const invStore = new D1InvitationStore(c.env.DB);
  const inv = await invStore.getByTokenHash(tokenHash);
  if (!inv) {
    return c.json(
      { error: "invalid_invitation", message: "Invitation is invalid, expired, or already used" },
      400,
    );
  }

  if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
    return c.json(
      {
        error: "email_mismatch",
        message: `This invitation was sent to ${inv.email}, but you are signed in as ${user.email}`,
      },
      403,
    );
  }

  const orgStore = new D1OrganisationStore(c.env.DB);
  const org = await orgStore.getById(inv.orgId);
  if (!org) {
    throw new NotFoundError("organisation", inv.orgId);
  }

  const existing = await orgStore.getMembership(org.id, user.id);
  if (!existing) {
    await orgStore.addMember(org.id, user.id, inv.role);
  }
  await invStore.accept(inv.id);

  return c.json({
    ok: true,
    orgId: org.id,
    role: existing ? existing.role : inv.role,
    organisation: org,
  });
});
