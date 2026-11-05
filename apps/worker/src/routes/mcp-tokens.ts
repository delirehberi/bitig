import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { CreateMcpTokenSchema, type McpTokenMetadata } from "@bitig/core";
import { McpTokenStore } from "@bitig/storage-d1";
import type { AppEnv } from "../index";
import { digestMcpToken, generateMcpToken } from "../mcp-token-crypto";

const MAX_BODY_BYTES = 2048;
const HTTP_BAD_REQUEST = 400;
const HTTP_CREATED = 201;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const HTTP_TOO_LARGE = 413;

export const mcpTokensRouter = new Hono<AppEnv>();

mcpTokensRouter.use("*", async (context, next) => {
  context.header("Cache-Control", "no-store");
  if (context.get("config").STORAGE_MODE !== "cloudflare") {
    return context.json({ error: "unavailable", message: "MCP tokens require Cloudflare storage." }, HTTP_CONFLICT);
  }
  return next();
});

mcpTokensRouter.onError((error, context) => {
  context.header("Cache-Control", "no-store");
  if (error instanceof HTTPException && error.status === HTTP_BAD_REQUEST) {
    return context.json({ error: "invalid_token_input" }, HTTP_BAD_REQUEST);
  }
  return context.json({
    error: "unavailable",
    message: "Token storage is unavailable. Reload the token list before retrying; a creation may have succeeded.",
  }, HTTP_UNAVAILABLE);
});

mcpTokensRouter.use("*", bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (context) => context.json({ error: "body_too_large" }, HTTP_TOO_LARGE),
}));

mcpTokensRouter.get("/", async (context) => {
  const store = new McpTokenStore(context.env.DB, context.get("orgId"));
  return context.json(await store.list(new Date().toISOString()));
});

mcpTokensRouter.post("/", zValidator("json", CreateMcpTokenSchema, (result, context) => {
  if (!result.success) return context.json({ error: "invalid_token_input" }, HTTP_BAD_REQUEST);
  return undefined;
}), async (context) => {
  const input = context.req.valid("json");
  const now = new Date().toISOString();
  const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt).toISOString();
  if (expiresAt !== null && expiresAt <= now) {
    return context.json({ error: "invalid_expiry", message: "Expiry must be in the future." }, HTTP_BAD_REQUEST);
  }
  const credential: McpTokenMetadata = {
    id: crypto.randomUUID(), label: input.label, transport: input.transport,
    createdAt: now, expiresAt, revokedAt: null,
  };
  const token = generateMcpToken();
  const store = new McpTokenStore(context.env.DB, context.get("orgId"));
  if (!(await store.create(credential, await digestMcpToken(token)))) {
    return context.json({ error: "token_limit", message: "Revoke an active token before creating another." }, HTTP_CONFLICT);
  }
  return context.json({ credential, token }, HTTP_CREATED);
});

mcpTokensRouter.delete("/:id", async (context) => {
  const parsed = z.uuid().safeParse(context.req.param("id"));
  if (!parsed.success) return context.json({ error: "invalid_token_id" }, HTTP_BAD_REQUEST);
  const credential = await new McpTokenStore(context.env.DB, context.get("orgId")).revoke(
    parsed.data,
    new Date().toISOString(),
  );
  if (credential === null) return context.json({ error: "not_found" }, HTTP_NOT_FOUND);
  return context.json(credential);
});

