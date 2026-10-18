import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./index";
import { recordAuthFailure } from "./rate-limit";

const BASIC_PREFIX = "Basic ";
const REALM_HEADER_VALUE = 'Basic realm="bitig"';
const HTTP_UNAUTHORIZED = 401;

async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [aHash, bHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(aHash, bHash);
}

/*
 * Failed attempts are counted toward AUTH_FAIL_POLICY only when the client
 * presented credentials. A request with no Authorization header is the normal
 * unauthenticated probe (e.g. the dashboard before login), and a server with no
 * secret configured is a misconfiguration, not an attack.
 */
export function basicAuth(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const config = c.get("config");

    // If no password is configured, reject all requests for safety.
    if (!config.BASIC_AUTH_PASS) {
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": REALM_HEADER_VALUE,
      });
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith(BASIC_PREFIX)) {
      if (authHeader !== undefined) await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": REALM_HEADER_VALUE,
      });
    }

    const base64Credentials = authHeader.slice(BASIC_PREFIX.length).trim();
    let credentials: string;
    try {
      credentials = atob(base64Credentials);
    } catch {
      await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": REALM_HEADER_VALUE,
      });
    }

    const colonIndex = credentials.indexOf(":");
    if (colonIndex === -1) {
      await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": REALM_HEADER_VALUE,
      });
    }

    const user = credentials.slice(0, colonIndex);
    const pass = credentials.slice(colonIndex + 1);

    const [userMatch, passMatch] = await Promise.all([
      timingSafeEqualString(user, config.BASIC_AUTH_USER),
      timingSafeEqualString(pass, config.BASIC_AUTH_PASS),
    ]);

    if (!userMatch || !passMatch) {
      await recordAuthFailure(c);
      return c.json({ error: "unauthorized" }, HTTP_UNAUTHORIZED, {
        "WWW-Authenticate": REALM_HEADER_VALUE,
      });
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
