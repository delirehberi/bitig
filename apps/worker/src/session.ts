import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { User } from "@bitig/core";
import { D1SessionStore, type SessionInfo } from "@bitig/storage-d1";
import type { AppConfig } from "./config";
import type { AppEnv } from "./index";
import { generateOpaqueToken, SESSION_TTL_MS, sha256Hex } from "./auth-crypto";
import { ensureBootstrap } from "./bootstrap";

/*
 * Dashboard sessions are stored server-side in D1 (`sessions` table) and tied
 * to a User ID. The cookie carries an opaque random session token signed with
 * HMAC-SHA256 under SESSION_SECRET. The `__Host-` prefix pins the cookie to
 * this origin over HTTPS with Path=/.
 */
export const SESSION_COOKIE = "bitig_session";
const SESSION_PREFIX = "host";
const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

const COOKIE_OPTIONS: CookieOptions = {
  prefix: SESSION_PREFIX,
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: "/",
};

export type SessionLookup =
  | { kind: "none" }
  | { kind: "valid"; user: User; session: SessionInfo }
  /** Signature mismatch: someone presented a cookie this server never issued. */
  | { kind: "forged" }
  /** Correctly signed but expired, revoked, or for a user that is disabled or deleted. */
  | { kind: "stale" };

export function sessionsEnabled(config: AppConfig): boolean {
  return config.SESSION_SECRET.length > 0;
}

export async function startSession(c: Context<AppEnv>, userId: string): Promise<SessionInfo> {
  const config = c.get("config");
  await ensureBootstrap(c.env.DB, config);
  const token = generateOpaqueToken(32);
  const sessionId = await sha256Hex(token);
  const store = new D1SessionStore(c.env.DB);
  const session = await store.create({
    id: sessionId,
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS,
    userAgent: c.req.header("user-agent"),
    ip: c.req.header("cf-connecting-ip"),
  });
  await setSignedCookie(c, SESSION_COOKIE, token, config.SESSION_SECRET, {
    ...COOKIE_OPTIONS,
    maxAge: SESSION_TTL_SECONDS,
  });
  return session;
}

export async function endSession(c: Context<AppEnv>): Promise<void> {
  const config = c.get("config");
  if (sessionsEnabled(config)) {
    const value = await getSignedCookie(c, config.SESSION_SECRET, SESSION_COOKIE, SESSION_PREFIX);
    if (typeof value === "string" && value.length > 0) {
      await ensureBootstrap(c.env.DB, config);
      const sessionId = await sha256Hex(value);
      const store = new D1SessionStore(c.env.DB);
      await store.delete(sessionId);
    }
  }
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}

export async function readSession(c: Context<AppEnv>): Promise<SessionLookup> {
  const config = c.get("config");
  if (!sessionsEnabled(config)) return { kind: "none" };

  const value = await getSignedCookie(c, config.SESSION_SECRET, SESSION_COOKIE, SESSION_PREFIX);
  if (value === undefined) return { kind: "none" };
  if (value === false || value.trim().length === 0) return { kind: "forged" };

  await ensureBootstrap(c.env.DB, config);
  const sessionId = await sha256Hex(value);
  const store = new D1SessionStore(c.env.DB);
  const found = await store.getWithUser(sessionId);
  if (!found) return { kind: "stale" };

  await store.touch(found.session.id);
  c.set("user", found.user);
  c.set("sessionId", found.session.id);
  return { kind: "valid", user: found.user, session: found.session };
}
