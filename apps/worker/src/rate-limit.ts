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

const FEEDBACK_IP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const FEEDBACK_IP_MAX_SUBMISSIONS = 5;

const FEEDBACK_FORM_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FEEDBACK_FORM_MAX_SUBMISSIONS = 60;

/** Per-IP per-form feedback submission limit (`feedback:<publicId>:<ip>`, 5 per 10 min). */
export const FEEDBACK_POLICY: RateLimitPolicy = {
  name: "feedback",
  windowMs: FEEDBACK_IP_WINDOW_MS,
  max: FEEDBACK_IP_MAX_SUBMISSIONS,
};

/** Per-form feedback submission limit (`feedback-form:<publicId>`, 60 per hour). */
export const FEEDBACK_FORM_POLICY: RateLimitPolicy = {
  name: "feedback-form",
  windowMs: FEEDBACK_FORM_WINDOW_MS,
  max: FEEDBACK_FORM_MAX_SUBMISSIONS,
};

export function feedbackIpRateLimitKey(publicId: string, ip: string): string {
  return `${FEEDBACK_POLICY.name}:${publicId}:${ip}`;
}

export function feedbackFormRateLimitKey(publicId: string): string {
  return `${FEEDBACK_FORM_POLICY.name}:${publicId}`;
}

function limiterStubByKey(c: Context<AppEnv>, key: string): DurableObjectStub<RateLimiter> {
  const namespace = c.env.RATE_LIMITER;
  return namespace.get(namespace.idFromName(key));
}

function limiterStub(c: Context<AppEnv>, policy: RateLimitPolicy): DurableObjectStub<RateLimiter> {
  return limiterStubByKey(c, `${policy.name}:${getClientIp(c)}`);
}

export interface FeedbackRateLimitCheckResult {
  readonly limited: boolean;
  readonly reason?: "ip" | "form" | undefined;
  readonly resetSeconds?: number | undefined;
}

/**
 * Checks and records both feedback submission rate limits on the `RateLimiter`
 * Durable Object:
 * 1. Per IP per form (`feedback:<publicId>:<ip>`, 5 per 10 min)
 * 2. Per form (`feedback-form:<publicId>`, 60 per hour)
 *
 * Fails open if the Durable Object is unavailable.
 */
export async function checkFeedbackRateLimits(
  c: Context<AppEnv>,
  publicId: string,
  ip: string = getClientIp(c),
): Promise<FeedbackRateLimitCheckResult> {
  const ipKey = feedbackIpRateLimitKey(publicId, ip);
  try {
    const ipResult = await limiterStubByKey(c, ipKey).hit(
      FEEDBACK_POLICY.max,
      FEEDBACK_POLICY.windowMs,
    );
    if (ipResult.limited) {
      return {
        limited: true,
        reason: "ip",
        resetSeconds: ipResult.resetSeconds,
      };
    }
  } catch (error) {
    console.error("feedback IP rate limiter unavailable, allowing request", {
      key: ipKey,
      error,
    });
  }

  const formKey = feedbackFormRateLimitKey(publicId);
  try {
    const formResult = await limiterStubByKey(c, formKey).hit(
      FEEDBACK_FORM_POLICY.max,
      FEEDBACK_FORM_POLICY.windowMs,
    );
    if (formResult.limited) {
      return {
        limited: true,
        reason: "form",
        resetSeconds: formResult.resetSeconds,
      };
    }
  } catch (error) {
    console.error("feedback form rate limiter unavailable, allowing request", {
      key: formKey,
      error,
    });
  }

  return { limited: false };
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
