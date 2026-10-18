import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./index";

const HTTP_FORBIDDEN = 403;
const MUTATING_METHODS = new Set(["POST", "PATCH", "DELETE", "PUT"]);

export function csrfProtection(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (!MUTATING_METHODS.has(method)) {
      return next();
    }

    const config = c.get("config");
    const reqUrl = new URL(c.req.url);
    const selfOrigin = reqUrl.origin;
    const origin = c.req.header("origin");

    if (origin) {
      const isSelf = origin === selfOrigin;
      const isAllowed = config.ALLOWED_ORIGINS.includes(origin);
      if (!isSelf && !isAllowed) {
        return c.json({ error: "forbidden", message: "Cross-site request blocked: origin not allowed" }, HTTP_FORBIDDEN);
      }
      return next();
    }

    const referer = c.req.header("referer");
    if (referer) {
      try {
        const refOrigin = new URL(referer).origin;
        const isSelf = refOrigin === selfOrigin;
        const isAllowed = config.ALLOWED_ORIGINS.includes(refOrigin);
        if (!isSelf && !isAllowed) {
          return c.json({ error: "forbidden", message: "Cross-site request blocked: referer not allowed" }, HTTP_FORBIDDEN);
        }
      } catch {
        return c.json({ error: "forbidden", message: "Invalid referer header" }, HTTP_FORBIDDEN);
      }
      return next();
    }

    // If neither Origin nor Referer is present, verify Sec-Fetch-Site and Content-Type / custom headers
    const secFetchSite = c.req.header("sec-fetch-site");
    if (secFetchSite === "cross-site") {
      return c.json({ error: "forbidden", message: "Cross-site request blocked" }, HTTP_FORBIDDEN);
    }

    // Simple HTML form submissions that bypass preflights use these content-types
    const contentType = c.req.header("content-type")?.toLowerCase();
    const isFormContent =
      contentType &&
      (contentType.includes("application/x-www-form-urlencoded") ||
        contentType.includes("multipart/form-data") ||
        contentType.includes("text/plain"));

    if (isFormContent) {
      return c.json(
        { error: "forbidden", message: "Form-encoded cross-site requests are not permitted" },
        HTTP_FORBIDDEN,
      );
    }

    return next();
  };
}
