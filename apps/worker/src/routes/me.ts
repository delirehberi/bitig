import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  AvatarUrlSchema,
  DisplayNameSchema,
  EmailSchema,
  IdSchema,
  UsernameSchema,
  ValidationError,
  normalizeEmail,
} from "@bitig/core";
import {
  D1AccessTokenStore,
  D1AuthCodeStore,
  D1OrganisationStore,
  D1SessionStore,
  D1Storage,
  D1UserStore,
} from "@bitig/storage-d1";
import type { AppEnv } from "../index";
import { generateAccessToken, generateSixDigitCode, sha256Hex } from "../auth-crypto";
import { buildAccountDeleteEmail, buildEmailChangeEmail } from "../mailer";
import { disconnectRealtimeUser } from "../realtime";
import { endSession } from "../session";

const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;

const UpdateProfileSchema = z
  .object({
    displayName: DisplayNameSchema.optional(),
    username: UsernameSchema.optional(),
    avatarUrl: AvatarUrlSchema.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((val) => val !== undefined), {
    message: "At least one field must be provided",
  });

const RequestEmailChangeSchema = z.object({
  email: EmailSchema,
});

const VerifyEmailChangeSchema = z.object({
  email: EmailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
});

const CreateTokenSchema = z.object({
  orgId: IdSchema,
  name: z.string().trim().min(1).max(120),
  expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
});

const ConfirmDeleteSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/),
});

export class SoleOwnerConflictError extends Error {
  readonly orgId: string;
  readonly orgName: string;

  constructor(orgId: string, orgName: string) {
    super(`Transfer ownership of "${orgName}" before deleting this account`);
    this.name = "SoleOwnerConflictError";
    this.orgId = orgId;
    this.orgName = orgName;
  }
}

export async function deleteUserAccount(env: Env, userId: string): Promise<void> {
  const orgStore = new D1OrganisationStore(env.DB);
  const userStore = new D1UserStore(env.DB);
  const userOrgs = await orgStore.listForUser(userId);

  const orgPlans: { orgId: string; soleMember: boolean }[] = [];
  for (const m of userOrgs) {
    const members = await orgStore.listMembers(m.organisation.id);
    const owners = members.filter((mem) => mem.role === "owner");
    if (m.role === "owner" && owners.length <= 1 && members.length > 1) {
      throw new SoleOwnerConflictError(m.organisation.id, m.organisation.name);
    }
    orgPlans.push({
      orgId: m.organisation.id,
      soleMember: members.length === 1 && members[0]?.userId === userId,
    });
  }

  // Validate last-admin constraint before deleting sole-member organisations
  const targetUser = await userStore.getById(userId);
  if (!targetUser) {
    return;
  }
  if (targetUser.platformRole === "admin" && targetUser.status === "active") {
    const allAdmins = await userStore.list({ platformRole: "admin", status: "active" });
    if (allAdmins.filter((a) => a.id !== userId).length === 0) {
      throw new ValidationError("deleteUser", [
        {
          code: "custom",
          path: ["id"],
          message: "cannot delete the last platform admin",
          input: userId,
        },
      ]);
    }
  }

  for (const plan of orgPlans) {
    await disconnectRealtimeUser(env, plan.orgId, userId);
    if (plan.soleMember) {
      await orgStore.delete(plan.orgId);
    } else {
      await orgStore.removeMember(plan.orgId, userId);
    }
  }

  await userStore.delete(userId);
}

export const meRouter = new Hono<AppEnv>()
  .get("/", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const orgStore = new D1OrganisationStore(c.env.DB);
    const memberships = await orgStore.listForUser(user.id);

    let openTasks = 0;
    let completedTasks = 0;
    for (const m of memberships) {
      const storage = new D1Storage({
        db: c.env.DB,
        bucket: c.env.ATTACHMENTS,
        orgId: m.organisation.id,
      });
      const tasks = await storage.getTasks();
      for (const task of tasks) {
        if (task.status === "done") {
          completedTasks += 1;
        } else if (task.status !== "archived") {
          openTasks += 1;
        }
      }
    }

    return c.json({
      user,
      memberships,
      stats: { openTasks, completedTasks },
    });
  })
  .patch(
    "/",
    zValidator("json", UpdateProfileSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      const patch = c.req.valid("json");
      const userStore = new D1UserStore(c.env.DB);

      if (patch.username !== undefined && patch.username !== user.username) {
        const taken = await userStore.getByUsername(patch.username);
        if (taken && taken.id !== user.id) {
          return c.json({ error: "username_taken", message: "Username is already taken" }, HTTP_CONFLICT);
        }
      }

      const updated = await userStore.update(user.id, patch);
      c.set("user", updated);
      return c.json({ user: updated });
    },
  )
  .post(
    "/email",
    zValidator("json", RequestEmailChangeSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      const newEmail = normalizeEmail(c.req.valid("json").email);
      const userStore = new D1UserStore(c.env.DB);
      const existing = await userStore.getByEmail(newEmail);
      if (existing && existing.id !== user.id) {
        return c.json({ error: "email_taken", message: "Email is already in use" }, HTTP_CONFLICT);
      }

      const code = generateSixDigitCode();
      const codeStore = new D1AuthCodeStore(c.env.DB);
      await codeStore.issue({
        email: newEmail,
        codeHash: await sha256Hex(code),
        purpose: "email_change",
        payload: { userId: user.id },
      });
      await c.get("mailer").send(buildEmailChangeEmail(newEmail, code));
      return c.json({ status: "sent" });
    },
  )
  .post(
    "/email/verify",
    zValidator("json", VerifyEmailChangeSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      const body = c.req.valid("json");
      const newEmail = normalizeEmail(body.email);

      const codeStore = new D1AuthCodeStore(c.env.DB);
      const verified = await codeStore.verifyAndConsume({
        email: newEmail,
        codeHash: await sha256Hex(body.code),
        purpose: "email_change",
      });
      if (!verified.ok || verified.record.payload?.userId !== user.id) {
        return c.json(
          { error: "invalid_code", message: "Invalid or expired verification code" },
          HTTP_UNAUTHORIZED,
        );
      }

      const userStore = new D1UserStore(c.env.DB);
      const existing = await userStore.getByEmail(newEmail);
      if (existing && existing.id !== user.id) {
        return c.json({ error: "email_taken", message: "Email is already in use" }, HTTP_CONFLICT);
      }

      const updated = await userStore.update(user.id, {
        email: newEmail,
        emailVerifiedAt: new Date().toISOString(),
      });
      const sessionStore = new D1SessionStore(c.env.DB);
      await sessionStore.deleteAllForUser(user.id, c.get("sessionId"));
      c.set("user", updated);
      return c.json({ user: updated });
    },
  )
  .get("/sessions", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const currentId = c.get("sessionId");
    const sessions = await new D1SessionStore(c.env.DB).listForUser(user.id);
    return c.json(
      sessions.map((s) => ({
        ...s,
        current: s.id === currentId,
      })),
    );
  })
  .delete("/sessions/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const id = c.req.param("id");
    const deleted = await new D1SessionStore(c.env.DB).deleteForUser(id, user.id);
    if (!deleted) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post("/sessions/revoke-others", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const revokedCount = await new D1SessionStore(c.env.DB).deleteAllForUser(user.id, c.get("sessionId"));
    return c.json({ revokedCount });
  })
  .get("/tokens", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const tokens = await new D1AccessTokenStore(c.env.DB).listForUser(user.id);
    return c.json(tokens);
  })
  .post(
    "/tokens",
    zValidator("json", CreateTokenSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      const input = c.req.valid("json");
      const orgStore = new D1OrganisationStore(c.env.DB);
      const membership = await orgStore.getMembership(input.orgId, user.id);
      if (!membership) {
        return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
      }
      const { token, prefix } = generateAccessToken();
      const created = await new D1AccessTokenStore(c.env.DB).create({
        userId: user.id,
        orgId: input.orgId,
        name: input.name,
        tokenHash: await sha256Hex(token),
        prefix,
        expiresAt: input.expiresAt ?? null,
      });
      return c.json({ token, credential: created }, HTTP_CREATED);
    },
  )
  .delete("/tokens/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const id = c.req.param("id");
    const revoked = await new D1AccessTokenStore(c.env.DB).revoke(id, user.id);
    if (!revoked) {
      return c.json({ error: "not_found" }, HTTP_NOT_FOUND);
    }
    return c.body(null, HTTP_NO_CONTENT);
  })
  .post("/delete/code", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const code = generateSixDigitCode();
    await new D1AuthCodeStore(c.env.DB).issue({
      email: user.email,
      codeHash: await sha256Hex(code),
      purpose: "account_delete",
      payload: { userId: user.id },
    });
    await c.get("mailer").send(buildAccountDeleteEmail(user.email, code));
    return c.json({ status: "sent" });
  })
  .post(
    "/delete/confirm",
    zValidator("json", ConfirmDeleteSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const user = c.get("user");
      if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      const { code } = c.req.valid("json");
      const verified = await new D1AuthCodeStore(c.env.DB).verifyAndConsume({
        email: user.email,
        codeHash: await sha256Hex(code),
        purpose: "account_delete",
      });
      if (!verified.ok || verified.record.payload?.userId !== user.id) {
        return c.json(
          { error: "invalid_code", message: "Invalid or expired verification code" },
          HTTP_UNAUTHORIZED,
        );
      }
      try {
        await deleteUserAccount(c.env, user.id);
      } catch (error) {
        if (error instanceof SoleOwnerConflictError) {
          return c.json(
            { error: "sole_owner_conflict", message: error.message, orgId: error.orgId },
            HTTP_CONFLICT,
          );
        }
        throw error;
      }
      await endSession(c);
      return c.body(null, HTTP_NO_CONTENT);
    },
  );
