import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { verifyEvent, type Event } from "nostr-tools/pure";
import type { AppEnv } from "../index";
import { verifyCredentials } from "../auth";
import { recordAuthFailure } from "../rate-limit";
import { endSession, readSession, sessionsEnabled, startSession } from "../session";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVICE_UNAVAILABLE = 503;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const LOGIN_EVENT_KIND = 22242;
const LOGIN_EVENT_CONTENT = "Sign in to Bitig";
const HEX_64 = /^[0-9a-f]{64}$/;

const PasswordLoginSchema = z.object({
  username: z.string(),
  password: z.string(),
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

function uniqueTagValue(tags: readonly string[][], name: string): string | undefined {
  const matches = tags.filter((tag) => tag[0] === name && tag.length === 2);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}

/**
 * Dashboard sign-in. Mounted at /api/auth ahead of the /api/* auth guard, so
 * these routes are reachable without credentials (rate limiting, CSRF and the
 * failed-login budget still apply).
 */
export const sessionRouter = new Hono<AppEnv>()
  .post(
    "/login",
    zValidator("json", PasswordLoginSchema, (result, c) => {
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

      const { username, password } = c.req.valid("json");
      if (!(await verifyCredentials(config, username, password))) {
        if (config.BASIC_AUTH_PASS) await recordAuthFailure(c);
        return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
      }

      await startSession(c, config.BASIC_AUTH_USER);
      return c.json<SessionResponse>({ user: config.BASIC_AUTH_USER });
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
      await startSession(c, event.pubkey);
      return c.json<SessionResponse>({ user: event.pubkey });
    },
  )
  .post("/logout", (c) => {
    endSession(c);
    return c.body(null, HTTP_NO_CONTENT);
  })
  .get("/session", async (c) => {
    const session = await readSession(c);
    if (session.kind === "forged") await recordAuthFailure(c);
    if (session.kind !== "valid") return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);
    return c.json<SessionResponse>({ user: session.user });
  });
