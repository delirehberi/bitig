import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../index";
import { verifyCredentials } from "../auth";
import { recordAuthFailure } from "../rate-limit";
import { endSession, readSession, sessionsEnabled, startSession } from "../session";

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NO_CONTENT = 204;
const HTTP_SERVICE_UNAVAILABLE = 503;

const LoginSchema = z.object({
  username: z.string(),
  password: z.string(),
});

export interface SessionResponse {
  user: string;
}

/**
 * Dashboard sign-in. Mounted at /api/auth ahead of the /api/* auth guard, so
 * these routes are reachable without credentials (rate limiting, CSRF and the
 * failed-login budget still apply).
 */
export const sessionRouter = new Hono<AppEnv>()
  .post(
    "/login",
    zValidator("json", LoginSchema, (result, c) => {
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
