import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { CookieOptions } from "hono/utils/cookie";
import type { AppConfig } from "./config";
import type { AppEnv } from "./index";

/*
 * Dashboard sessions are stateless: the cookie carries the user name and an
 * expiry, signed with HMAC-SHA256 under SESSION_SECRET. Rotating the secret (or
 * changing BASIC_AUTH_USER) invalidates every session. The `__Host-` prefix pins
 * the cookie to this origin over HTTPS with Path=/.
 */
export const SESSION_COOKIE = "bitig_session";
const SESSION_PREFIX = "host";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const MS_PER_SECOND = 1000;
const VALUE_SEPARATOR = ":";

const COOKIE_OPTIONS: CookieOptions = {
  prefix: SESSION_PREFIX,
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  path: "/",
};

export type SessionLookup =
  | { kind: "none" }
  | { kind: "valid"; user: string }
  /** Signature mismatch: someone presented a cookie this server never issued. */
  | { kind: "forged" }
  /** Correctly signed but expired or for a user that no longer exists. */
  | { kind: "stale" };

export function sessionsEnabled(config: AppConfig): boolean {
  return config.SESSION_SECRET.length > 0;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / MS_PER_SECOND);
}

/** The signed payload: `<expiresAt unix seconds>:<user>`. Exported for tests. */
export function sessionValue(user: string, expiresAtSeconds: number): string {
  return `${String(expiresAtSeconds)}${VALUE_SEPARATOR}${user}`;
}

export async function startSession(c: Context<AppEnv>, user: string): Promise<void> {
  const { SESSION_SECRET } = c.get("config");
  await setSignedCookie(c, SESSION_COOKIE, sessionValue(user, nowSeconds() + SESSION_TTL_SECONDS), SESSION_SECRET, {
    ...COOKIE_OPTIONS,
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function endSession(c: Context<AppEnv>): void {
  deleteCookie(c, SESSION_COOKIE, COOKIE_OPTIONS);
}

export async function readSession(c: Context<AppEnv>): Promise<SessionLookup> {
  const config = c.get("config");
  if (!sessionsEnabled(config)) return { kind: "none" };

  const value = await getSignedCookie(c, config.SESSION_SECRET, SESSION_COOKIE, SESSION_PREFIX);
  if (value === undefined) return { kind: "none" };
  if (value === false) return { kind: "forged" };

  const separator = value.indexOf(VALUE_SEPARATOR);
  const expiresAt = Number(value.slice(0, separator));
  const user = value.slice(separator + 1);
  if (separator === -1 || !Number.isInteger(expiresAt)) return { kind: "forged" };
  if (expiresAt <= nowSeconds() || user !== config.BASIC_AUTH_USER) return { kind: "stale" };
  return { kind: "valid", user };
}
