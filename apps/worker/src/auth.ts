import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./index";
import type { AppConfig } from "./config";
import { recordAuthFailure } from "./rate-limit";
import { readSession } from "./session";

const BASIC_PREFIX = "Basic ";
const HTTP_UNAUTHORIZED = 401;

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

/** Checks a user name and password against BASIC_AUTH_USER / BASIC_AUTH_PASS in constant time. */
export async function verifyCredentials(config: AppConfig, user: string, pass: string): Promise<boolean> {
  // If no password is configured, nothing can match.
  if (!config.BASIC_AUTH_PASS) return false;
  const [userMatch, passMatch] = await Promise.all([
    timingSafeEqualString(user, config.BASIC_AUTH_USER),
    timingSafeEqualString(pass, config.BASIC_AUTH_PASS),
  ]);
  return userMatch && passMatch;
}

function parseBasicHeader(header: string): { user: string; pass: string } | null {
  if (!header.startsWith(BASIC_PREFIX)) return null;
  let credentials: string;
  try {
    credentials = atob(header.slice(BASIC_PREFIX.length).trim());
  } catch {
    return null;
  }
  const colonIndex = credentials.indexOf(":");
  if (colonIndex === -1) return null;
  return { user: credentials.slice(0, colonIndex), pass: credentials.slice(colonIndex + 1) };
}

/*
 * Guards /api/*. The dashboard authenticates with the session cookie set by
 * POST /api/auth/login; scripts and API clients may still send an
 * `Authorization: Basic` header. A 401 deliberately carries no
 * `WWW-Authenticate: Basic` challenge, so browsers never show their native
 * login prompt; the dashboard sends people to /login instead.
 *
 * Failed attempts are counted toward AUTH_FAIL_POLICY only when the client
 * presented credentials: wrong Basic credentials or a cookie this server never
 * signed. A request with nothing is the normal unauthenticated probe, and an
 * expired session is not an attack.
 */
export function apiAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get("config");
    const unauthorized = () => c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED);

    const session = await readSession(c);
    if (session.kind === "valid") return next();
    if (session.kind === "forged") await recordAuthFailure(c);

    const authHeader = c.req.header("Authorization");
    if (authHeader === undefined) return unauthorized();

    const parsed = parseBasicHeader(authHeader);
    if (!parsed || !(await verifyCredentials(config, parsed.user, parsed.pass))) {
      // A server with no password configured is a misconfiguration, not an attack.
      if (config.BASIC_AUTH_PASS) await recordAuthFailure(c);
      return unauthorized();
    }

    return next();
  };
}

const BEARER_PREFIX = "Bearer ";
const MCP_REALM_HEADER_VALUE = 'Bearer realm="bitig-mcp"';

export function bearerAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get("config");

    // If no MCP auth token is configured, reject all requests for safety.
    if (!config.MCP_AUTH_TOKEN) {
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": MCP_REALM_HEADER_VALUE,
      });
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith(BEARER_PREFIX)) {
      if (authHeader !== undefined) await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": MCP_REALM_HEADER_VALUE,
      });
    }

    const token = authHeader.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": MCP_REALM_HEADER_VALUE,
      });
    }

    const tokenMatch = await timingSafeEqualString(token, config.MCP_AUTH_TOKEN);
    if (!tokenMatch) {
      await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": MCP_REALM_HEADER_VALUE,
      });
    }

    return next();
  };
}
