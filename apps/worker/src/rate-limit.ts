import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./index";
import type { RateLimiter, RateLimitResult } from "./rate-limiter-do";

export interface RateLimitPolicy {
  /** Prefix of the Durable Object name; keeps each policy's counters separate. */
  readonly name: string;
  readonly windowMs: number;
  readonly max: number;
}

export function getClientIp(c: Context<AppEnv>): string {
  const cfIp = c.req.header("cf-connecting-ip");
  if (cfIp) return cfIp;
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return "127.0.0.1";
}

const HTTP_TOO_MANY_REQUESTS = 429;

const API_WINDOW_MS = 60 * 1000; // 1 minute
const API_MAX_REQUESTS = 1000;

const MCP_WINDOW_MS = 60 * 1000; // 1 minute
const MCP_MAX_REQUESTS = 1000;

const WEBHOOK_WINDOW_MS = 60 * 1000; // 1 minute
const WEBHOOK_MAX_REQUESTS = 120;

const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const AUTH_FAIL_MAX_ATTEMPTS = 10;

export const API_POLICY: RateLimitPolicy = { name: "api", windowMs: API_WINDOW_MS, max: API_MAX_REQUESTS };
export const MCP_POLICY: RateLimitPolicy = { name: "mcp", windowMs: MCP_WINDOW_MS, max: MCP_MAX_REQUESTS };
export const WEBHOOK_POLICY: RateLimitPolicy = {
  name: "webhook",
  windowMs: WEBHOOK_WINDOW_MS,
  max: WEBHOOK_MAX_REQUESTS,
};
/** Shared by Basic Auth (/api) and Bearer auth (/mcp): one failure budget per client. */
export const AUTH_FAIL_POLICY: RateLimitPolicy = {
  name: "auth-fail",
  windowMs: AUTH_FAIL_WINDOW_MS,
  max: AUTH_FAIL_MAX_ATTEMPTS,
};

function limiterStub(c: Context<AppEnv>, policy: RateLimitPolicy): DurableObjectStub<RateLimiter> {
  const namespace = c.env.RATE_LIMITER;
  return namespace.get(namespace.idFromName(`${policy.name}:${getClientIp(c)}`));
}

function tooManyRequests(c: Context<AppEnv>, result: RateLimitResult): Response {
  c.header("Retry-After", String(result.resetSeconds));
  return c.json(
    {
      error: "too_many_requests",
      message: "Rate limit exceeded. Please try again later.",
    },
    HTTP_TOO_MANY_REQUESTS,
  );
}

/*
 * Every limiter call fails open: if the Durable Object is unavailable the error
 * is logged and the request continues. Authentication still runs on every
 * request, and a limiter outage must not lock the owner out of their data.
 */

export function rateLimit(policy: RateLimitPolicy): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let result: RateLimitResult;
    try {
      result = await limiterStub(c, policy).hit(policy.max, policy.windowMs);
    } catch (error) {
      console.error("rate limiter unavailable, allowing request", { policy: policy.name, error });
      return next();
    }

    c.header("RateLimit-Limit", String(result.limit));
    c.header("RateLimit-Remaining", String(result.remaining));
    c.header("RateLimit-Reset", String(result.resetSeconds));

    if (result.limited) return tooManyRequests(c, result);
    return next();
  };
}

/** Rejects clients that used up their failed-login budget, before credentials are checked. */
export function authFailureGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    let result: RateLimitResult;
    try {
      result = await limiterStub(c, AUTH_FAIL_POLICY).peek(AUTH_FAIL_POLICY.max, AUTH_FAIL_POLICY.windowMs);
    } catch (error) {
      console.error("auth failure limiter unavailable, allowing request", { error });
      return next();
    }

    if (result.limited) return tooManyRequests(c, result);
    return next();
  };
}

/** Counts a failed authentication attempt against the client's budget. */
export async function recordAuthFailure(c: Context<AppEnv>): Promise<void> {
  try {
    await limiterStub(c, AUTH_FAIL_POLICY).record(AUTH_FAIL_POLICY.windowMs);
  } catch (error) {
    console.error("auth failure limiter unavailable, failure not recorded", { error });
  }
}
