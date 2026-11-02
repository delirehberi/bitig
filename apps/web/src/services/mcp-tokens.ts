import {
  CreatedMcpTokenSchema, McpTokenListSchema, McpTokenMetadataSchema,
  type CreatedMcpToken, type CreateMcpTokenInput, type McpTokenMetadata,
} from "@bitig/core";

const TOKEN_API_PATH = "/api/mcp-tokens";
const REQUEST_TIMEOUT_MS = 15_000;
const UNCERTAIN_CREATION = " If you were creating a token, reload the list and revoke any token whose secret you did not receive before trying again.";
const HTTP_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  400: "Check the client name, authentication type, and expiry.",
  401: "Your session has expired. Sign in again.",
  403: "This token-management request was not allowed.",
  409: "Token capacity is reached, or Cloudflare storage is unavailable. Revoke an active token if the limit is reached.",
  503: "Token storage is temporarily unavailable.",
};

class McpTokenRequestError extends Error {}

async function tokenRequest(
  path: string, method: string, signal: AbortSignal, body?: CreateMcpTokenInput,
): Promise<unknown> {
  try {
    const response = await fetch(`${TOKEN_API_PATH}${path}`, {
      method, credentials: "same-origin", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Bitig-Request": "true" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new McpTokenRequestError(`${HTTP_ERROR_MESSAGES[response.status] ?? `Token request failed (HTTP ${String(response.status)}).`}${UNCERTAIN_CREATION}`);
    }
    return await response.json();
  } catch (error) {
    if (signal.aborted) throw error;
    if (error instanceof McpTokenRequestError) throw error;
    throw new Error(`Could not complete the token request. Check your connection and reload.${UNCERTAIN_CREATION}`, { cause: error });
  }
}

function parseResponse<Result>(schema: { parse(value: unknown): Result }, value: unknown): Result {
  try {
    return schema.parse(value);
  } catch {
    throw new Error(`The server returned an invalid token response.${UNCERTAIN_CREATION}`);
  }
}

export async function listMcpTokens(signal: AbortSignal): Promise<McpTokenMetadata[]> {
  return parseResponse(McpTokenListSchema, await tokenRequest("", "GET", signal));
}

export async function createMcpToken(input: CreateMcpTokenInput, signal: AbortSignal): Promise<CreatedMcpToken> {
  return parseResponse(CreatedMcpTokenSchema, await tokenRequest("", "POST", signal, input));
}

export async function revokeMcpToken(id: string, signal: AbortSignal): Promise<McpTokenMetadata> {
  return parseResponse(McpTokenMetadataSchema, await tokenRequest(`/${encodeURIComponent(id)}`, "DELETE", signal));
}
