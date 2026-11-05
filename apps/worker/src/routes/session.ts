import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { verifyEvent, type Event } from "nostr-tools/pure";
import {
  DEFAULT_ORGANISATION_ID,
  DisplayNameSchema,
  EmailSchema,
  OrganisationNameSchema,
  UsernameSchema,
  normalizeEmail,
  type User,
  type UserOrganisationMembership,
} from "@bitig/core";
import {
  D1AccessTokenStore,
  D1AuthCodeStore,
  D1InvitationStore,
  D1OrganisationStore,
  D1UserStore,
} from "@bitig/storage-d1";
import type { AppEnv } from "../index";
import { ACCESS_TOKEN_PREFIX, generateSixDigitCode, sha256Hex } from "../auth-crypto";
import { ensureBootstrap } from "../bootstrap";
import { buildSignInCodeEmail } from "../mailer";
import { getClientIp, recordAuthFailure } from "../rate-limit";
import { endSession, readSession, sessionsEnabled, startSession } from "../session";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVICE_UNAVAILABLE = 503;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LOGIN_EVENT_KIND = 22242;
const LOGIN_EVENT_CONTENT = "Sign in to Bitig";
const HEX_64 = /^[0-9a-f]{64}$/;
const EMAIL_RATE_WINDOW_MS = 15 * 60 * 1000;
const EMAIL_RATE_MAX = 10;
const NOSTR_EMAIL_SUFFIX = "@nostr.local";

const RequestCodeSchema = z.object({
  email: EmailSchema,
});

const RegisterSchema = z.object({
  email: EmailSchema,
  username: UsernameSchema,
  displayName: DisplayNameSchema,
  inviteToken: z.string().trim().min(1).optional(),
  organisationName: OrganisationNameSchema.optional(),
});

const VerifyCodeSchema = z.object({
  email: EmailSchema,
  code: z.string().trim().regex(/^\d{6}$/),
  inviteToken: z.string().trim().min(1).optional(),
  organisationName: OrganisationNameSchema.optional(),
});

const SignedLoginSchema = z.object({
  id: z.string().regex(HEX_64),
  pubkey: z.string().regex(HEX_64),
  created_at: z.number().int().nonnegative(),
  kind: z.literal(LOGIN_EVENT_KIND),
  tags: z.array(z.array(z.string())),
  content: z.literal(LOGIN_EVENT_CONTENT),
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});

export interface SessionResponse {
  user: string;
}

export interface AuthMeResponse {
  user: User;
  memberships: UserOrganisationMembership[];
  needsOnboarding: boolean;
}

function uniqueTagValue(tags: readonly string[][], name: string): string | undefined {
  const matches = tags.filter((tag) => tag[0] === name && tag.length === 2);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

async function checkEmailAndIpRateLimit(env: Env, ip: string, email: string): Promise<number | null> {
  try {
    const ipStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`auth-code-ip:${ip}`));
    const ipHit = await ipStub.hit(EMAIL_RATE_MAX, EMAIL_RATE_WINDOW_MS);
    if (ipHit.limited) return ipHit.resetSeconds;

    const emailStub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`auth-code-email:${email}`));
    const emailHit = await emailStub.hit(EMAIL_RATE_MAX, EMAIL_RATE_WINDOW_MS);
    if (emailHit.limited) return emailHit.resetSeconds;
  } catch (error) {
    console.error("auth code rate limiter unavailable, allowing request", { error });
  }
  return null;
}

async function resolveCurrentUser(c: Context<AppEnv>): Promise<User | null> {
  const session = await readSession(c);
  if (session.kind === "forged") {
    await recordAuthFailure(c);
    return null;
  }
  if (session.kind === "valid") {
    return session.user;
  }
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const rawToken = authHeader.slice("Bearer ".length).trim();
    if (rawToken.startsWith(ACCESS_TOKEN_PREFIX)) {
      await ensureBootstrap(c.env.DB, c.get("config"));
      const verified = await new D1AccessTokenStore(c.env.DB).verifyByHash(await sha256Hex(rawToken));
      if (verified) return verified.user;
    }
    await recordAuthFailure(c);
  }
  return null;
}

export const sessionRouter = new Hono<AppEnv>()
  .post(
    "/code",
    zValidator("json", RequestCodeSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const config = c.get("config");
      if (!sessionsEnabled(config)) {
        return c.json(
          { error: "sessions_not_configured", message: "SESSION_SECRET is not set on the Worker" },
          HTTP_SERVICE_UNAVAILABLE,
        );
      }

      const email = normalizeEmail(c.req.valid("json").email);
      const resetSeconds = await checkEmailAndIpRateLimit(c.env, getClientIp(c), email);
      if (resetSeconds !== null) {
        c.header("Retry-After", String(resetSeconds));
        return c.json(
          { error: "too_many_requests", message: "Rate limit exceeded. Please try again later." },
          HTTP_TOO_MANY_REQUESTS,
        );
      }

      await ensureBootstrap(c.env.DB, config);
      const userStore = new D1UserStore(c.env.DB);
      const user = await userStore.getByEmail(email);

      if (user?.status === "active") {
        const code = generateSixDigitCode();
        const codeStore = new D1AuthCodeStore(c.env.DB);
        await codeStore.issue({
          email,
          codeHash: await sha256Hex(code),
          purpose: "sign_in",
        });
        await c.get("mailer").send(buildSignInCodeEmail(email, code));
      }

      // Always return the same response so account existence cannot be probed.
      return c.json({ status: "sent" });
    },
  )
  .post(
    "/register",
    zValidator("json", RegisterSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const config = c.get("config");
      if (!sessionsEnabled(config)) {
        return c.json(
          { error: "sessions_not_configured", message: "SESSION_SECRET is not set on the Worker" },
          HTTP_SERVICE_UNAVAILABLE,
        );
      }

      const input = c.req.valid("json");
      const email = normalizeEmail(input.email);
      const username = input.username.trim().toLowerCase();
      const displayName = input.displayName.trim();

      const resetSeconds = await checkEmailAndIpRateLimit(c.env, getClientIp(c), email);
      if (resetSeconds !== null) {
        c.header("Retry-After", String(resetSeconds));
        return c.json(
          { error: "too_many_requests", message: "Rate limit exceeded. Please try again later." },
          HTTP_TOO_MANY_REQUESTS,
        );
      }

      await ensureBootstrap(c.env.DB, config);
      const userStore = new D1UserStore(c.env.DB);
      const [existingEmail, existingUsername] = await Promise.all([
        userStore.getByEmail(email),
        userStore.getByUsername(username),
      ]);

      if (!existingEmail && existingUsername) {
        return c.json(
          { error: "username_taken", message: "Username is already taken" },
          HTTP_CONFLICT,
        );
      }

      const code = generateSixDigitCode();
      const codeStore = new D1AuthCodeStore(c.env.DB);

      if (existingEmail) {
        if (existingEmail.status === "active") {
          await codeStore.issue({
            email,
            codeHash: await sha256Hex(code),
            purpose: "sign_in",
            ...(input.inviteToken ? { payload: { inviteToken: input.inviteToken } } : {}),
          });
          await c.get("mailer").send(buildSignInCodeEmail(email, code));
        }
        return c.json({ status: "sent" });
      }

      await codeStore.issue({
        email,
        codeHash: await sha256Hex(code),
        purpose: "register",
        payload: {
          username,
          displayName,
          ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}),
        },
      });
      await c.get("mailer").send(buildSignInCodeEmail(email, code));
      return c.json({ status: "sent" });
    },
  )
  .post(
    "/verify",
    zValidator("json", VerifyCodeSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const config = c.get("config");
      if (!sessionsEnabled(config)) {
        return c.json(
          { error: "sessions_not_configured", message: "SESSION_SECRET is not set on the Worker" },
          HTTP_SERVICE_UNAVAILABLE,
        );
      }

      const body = c.req.valid("json");
      const email = normalizeEmail(body.email);

      await ensureBootstrap(c.env.DB, config);
      const codeStore = new D1AuthCodeStore(c.env.DB);
      const verified = await codeStore.verifyAndConsume({
        email,
        codeHash: await sha256Hex(body.code),
        purpose: ["sign_in", "register"],
      });

      if (!verified.ok) {
        await recordAuthFailure(c);
        return c.json(
          { error: "invalid_code", message: "Invalid or expired verification code", reason: verified.reason },
          HTTP_UNAUTHORIZED,
        );
      }

      const userStore = new D1UserStore(c.env.DB);
      const orgStore = new D1OrganisationStore(c.env.DB);
      let user = await userStore.getByEmail(email);
      const nowIso = new Date().toISOString();

      if (!user) {
        const payload = verified.record.payload;
        if (verified.record.purpose !== "register" || !payload?.username || !payload.displayName) {
          await recordAuthFailure(c);
          return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
        }
        const usernameTaken = await userStore.getByUsername(payload.username);
        if (usernameTaken) {
          return c.json({ error: "username_taken", message: "Username is already taken" }, HTTP_CONFLICT);
        }
        user = await userStore.create({
          email,
          username: payload.username,
          displayName: payload.displayName,
          platformRole: email === config.BOOTSTRAP_ADMIN_EMAIL ? "admin" : "user",
          status: "active",
          emailVerifiedAt: nowIso,
          lastLoginAt: nowIso,
        });
      } else {
        if (user.status !== "active") {
          await recordAuthFailure(c);
          return c.json({ error: "account_disabled", message: "Account is disabled" }, HTTP_FORBIDDEN);
        }
        user = await userStore.update(user.id, {
          emailVerifiedAt: user.emailVerifiedAt ?? nowIso,
          lastLoginAt: nowIso,
        });
      }

      const inviteToken = body.inviteToken ?? verified.record.payload?.inviteToken;
      if (inviteToken) {
        const invStore = new D1InvitationStore(c.env.DB);
        const inv = await invStore.getByTokenHash(await sha256Hex(inviteToken));
        if (inv && normalizeEmail(inv.email) === email) {
          await invStore.accept(inv.id);
          const existingMembership = await orgStore.getMembership(inv.orgId, user.id);
          if (!existingMembership) {
            await orgStore.addMember(inv.orgId, user.id, inv.role);
          }
        }
      } else if (body.organisationName) {
        const existingOrgs = await orgStore.listForUser(user.id);
        if (existingOrgs.length === 0) {
          await orgStore.create({ name: body.organisationName }, user.id);
        }
      }

      await startSession(c, user.id);
      const memberships = await orgStore.listForUser(user.id);
      return c.json({
        user: user.username,
        profile: user,
        memberships,
        needsOnboarding: memberships.length === 0,
      });
    },
  )
  .post("/challenge", async (c) => {
    const config = c.get("config");
    if (!sessionsEnabled(config) || config.NOSTR_AUTH_PUBKEYS.length === 0) {
      return c.json(
        { error: "sessions_not_configured", message: "SESSION_SECRET or NOSTR_AUTH_PUBKEYS is not set" },
        HTTP_SERVICE_UNAVAILABLE,
      );
    }
    const nonce = crypto.randomUUID();
    const origin = new URL(c.req.url).origin;
    const expiresAt = Date.now() + CHALLENGE_TTL_MS;
    const createdAt = Math.floor(Date.now() / 1000);
    const stub = c.env.LOGIN_CHALLENGE.get(c.env.LOGIN_CHALLENGE.idFromName(nonce));
    await stub.issue({ origin, expiresAt, createdAt });
    return c.json({
      nonce,
      expiresAt,
      event: {
        kind: LOGIN_EVENT_KIND,
        created_at: createdAt,
        content: LOGIN_EVENT_CONTENT,
        tags: [["challenge", nonce], ["origin", origin], ["action", "login"]],
      },
    });
  })
  .post(
    "/nostr",
    zValidator("json", SignedLoginSchema, (result, c) => {
      if (!result.success) {
        return c.json({ error: "validation_error", details: result.error.issues }, HTTP_BAD_REQUEST);
      }
      return undefined;
    }),
    async (c) => {
      const config = c.get("config");
      if (!sessionsEnabled(config)) {
        return c.json(
          { error: "sessions_not_configured", message: "SESSION_SECRET is not set on the Worker" },
          HTTP_SERVICE_UNAVAILABLE,
        );
      }

      const event = c.req.valid("json") as Event;
      const nonce = uniqueTagValue(event.tags, "challenge");
      const eventOrigin = uniqueTagValue(event.tags, "origin");
      const action = uniqueTagValue(event.tags, "action");
      const requestOrigin = new URL(c.req.url).origin;
      const authorized = config.NOSTR_AUTH_PUBKEYS.includes(event.pubkey);
      if (
        !nonce ||
        event.tags.length !== 3 ||
        eventOrigin !== requestOrigin ||
        action !== "login" ||
        !authorized ||
        !verifyEvent(event)
      ) {
        await recordAuthFailure(c);
        return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      }
      const stub = c.env.LOGIN_CHALLENGE.get(c.env.LOGIN_CHALLENGE.idFromName(nonce));
      if (!(await stub.consume(requestOrigin, event.created_at))) {
        await recordAuthFailure(c);
        return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      }

      await ensureBootstrap(c.env.DB, config);
      const userStore = new D1UserStore(c.env.DB);
      const orgStore = new D1OrganisationStore(c.env.DB);
      const nostrEmail = `${event.pubkey}${NOSTR_EMAIL_SUFFIX}`;
      let user = await userStore.getByEmail(nostrEmail);
      const nowIso = new Date().toISOString();
      if (!user) {
        user = await userStore.create({
          email: nostrEmail,
          username: `nostr-${event.pubkey.slice(0, 16)}`,
          displayName: `Nostr (${event.pubkey.slice(0, 8)})`,
          platformRole: "admin",
          status: "active",
          emailVerifiedAt: nowIso,
          lastLoginAt: nowIso,
        });
      } else {
        if (user.status !== "active") {
          await recordAuthFailure(c);
          return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
        }
        user = await userStore.update(user.id, { lastLoginAt: nowIso });
      }
      const existingMembership = await orgStore.getMembership(DEFAULT_ORGANISATION_ID, user.id);
      if (!existingMembership) {
        await orgStore.addMember(DEFAULT_ORGANISATION_ID, user.id, "owner");
      }

      await startSession(c, user.id);
      return c.json<SessionResponse>({ user: event.pubkey });
    },
  )
  .post("/logout", async (c) => {
    await endSession(c);
    return c.body(null, HTTP_NO_CONTENT);
  })
  .get("/session", async (c) => {
    const user = await resolveCurrentUser(c);
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const legacyId = user.email.endsWith(NOSTR_EMAIL_SUFFIX)
      ? user.email.slice(0, -NOSTR_EMAIL_SUFFIX.length)
      : user.username;
    return c.json<SessionResponse>({ user: legacyId });
  })
  .get("/me", async (c) => {
    const user = await resolveCurrentUser(c);
    if (!user) return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    const orgStore = new D1OrganisationStore(c.env.DB);
    const memberships = await orgStore.listForUser(user.id);
    return c.json<AuthMeResponse>({
      user,
      memberships,
      needsOnboarding: memberships.length === 0,
    });
  });
