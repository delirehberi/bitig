import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  T3_ALLOWED_MCP_TOOLS,
  T3GitMetadataSchema,
  findHostFolderPathIssue,
  hostFolderPathIssueMessage,
  T3PullRequestUrlSchema,
  type T3GitMetadata,
  T3_STOP_REASON_MAX,
  T3ModelCapabilitySchema,
  T3ModelOptionSchema,
  T3ModelSelectionOptionsSchema,
  T3PendingQuestionSchema,
  T3RemoteProjectSchema,
  T3ThreadMessageSchema,
  deriveLiveAgentRunState,
  normalizeT3McpUrl,
  type T3AllowedMcpTool,
  type T3ModelCapability,
  type T3ModelOption,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3PendingQuestion,
  type T3RemoteProject,
  type T3RunSummary,
  type T3RuntimeMode,
  type T3ThreadListItem,
  type T3ThreadMessage,
  type T3ThreadSummary,
  type T3WorkspaceStrategy,
} from "@bitig/core";
import { z } from "zod";
import { generateOauthState, generatePkcePair } from "./crypto";

const BITIG_OAUTH_CLIENT_NAME = "Bitig";
/** Requested only when the T3 host advertises no `scopes_supported`. */
const DEFAULT_OAUTH_SCOPE = "mcp:tools";
const OAUTH_SCOPES_MAX = 50;
const OAUTH_SCOPE_TOKEN_MAX = 200;
/** RFC 6749 §3.3 `scope-token`: printable ASCII except space, `"` and `\`. */
const OAUTH_SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]+$/u;
const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class T3OAuthError extends Error {
  override readonly name = "T3OAuthError";
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export class T3McpError extends Error {
  override readonly name = "T3McpError";
  readonly code: string;
  /**
   * The `code` T3 put in a failed tool result, when it sent one (e.g. `capability_denied`).
   * T3 reports tool failures as JSON text such as `{"_tag":"OrchestratorMcpFailure","code":…}`.
   */
  readonly t3Code: string | undefined;
  /** The human-readable `message` from such a failure, without the JSON wrapper. */
  readonly t3Message: string | undefined;

  constructor(code: string, message: string, details?: { t3Code?: string | undefined; t3Message?: string | undefined }) {
    super(message);
    this.code = code;
    this.t3Code = details?.t3Code;
    this.t3Message = details?.t3Message;
  }
}

/** JSON-RPC code the MCP SDK uses when a request exceeds its `timeout`. */
const MCP_REQUEST_TIMEOUT_CODE: number = ErrorCode.RequestTimeout;

/** Bounds a single T3 host project operation (connect + one tool call). */
export const T3_PROJECT_OPERATION_TIMEOUT_MS = 20_000;
/** `t3_project_list` page size; T3 caps `limit` at 100. */
const T3_PROJECT_LIST_PAGE_LIMIT = 100;
/** Stops paging after this many pages, so a misbehaving host cannot keep the Worker busy. */
const T3_PROJECT_LIST_MAX_PAGES = 50;

export interface T3CallOptions {
  /** Aborts the session, e.g. when the browser request that started it is cancelled. */
  readonly signal?: AbortSignal | undefined;
  /** Per-request timeout in milliseconds for connecting and each tool call. */
  readonly timeoutMs?: number | undefined;
}

const T3ToolFailureSchema = z.looseObject({
  code: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(4000).optional(),
});

function parseT3ToolFailure(text: string | undefined): { t3Code?: string; t3Message?: string } {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Plain-text failures carry no structured code; the text itself becomes the message.
    return {};
  }
  const parsed = T3ToolFailureSchema.safeParse(raw);
  if (!parsed.success) return {};
  return {
    t3Code: parsed.data.code,
    ...(parsed.data.message ? { t3Message: parsed.data.message } : {}),
  };
}

export interface T3CloudflareAccessCredentials {
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
}

/**
 * Wraps `fetch` to attach Cloudflare Access Service Token headers (`CF-Access-Client-Id`
 * and `CF-Access-Client-Secret`) when both credentials are configured on the Worker.
 */
export function createT3Fetch(
  baseFetch: typeof fetch = fetch,
  cfAccess?: T3CloudflareAccessCredentials,
): typeof fetch {
  const clientId = cfAccess?.clientId?.trim() ?? "";
  const clientSecret = cfAccess?.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) {
    return baseFetch;
  }

  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init?.headers) {
      const initHeaders = new Headers(init.headers);
      initHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }
    headers.set("CF-Access-Client-Id", clientId);
    headers.set("CF-Access-Client-Secret", clientSecret);

    if (input instanceof Request) {
      return baseFetch(new Request(input, { ...init, headers }));
    }
    return baseFetch(input, { ...init, headers });
  };
}

function isCloudflareAccessLoginRedirect(response: Response): boolean {
  const location = response.headers.get("location") ?? "";
  if (location.includes("/cdn-cgi/access/login")) {
    return true;
  }
  const wwwAuth = response.headers.get("www-authenticate") ?? "";
  if (wwwAuth.toLowerCase().includes("cloudflare-access")) {
    return true;
  }
  if (response.redirected && response.url.includes("/cdn-cgi/access/login")) {
    return true;
  }
  return false;
}

function assertHttpsOrLoopbackUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new T3OAuthError("invalid_metadata", `Invalid ${label} URL: ${rawUrl}`);
  }
  const isHttps = parsed.protocol === "https:";
  const isLoopbackHttp = parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  if (!isHttps && !isLoopbackHttp) {
    throw new T3OAuthError("invalid_metadata", `${label} must use https:// (or http:// on loopback)`);
  }
  return parsed;
}

const ProtectedResourceMetadataSchema = z.looseObject({
  resource: z.string().optional(),
  authorization_servers: z.array(z.string()).optional(),
});

const AuthorizationServerMetadataSchema = z.looseObject({
  issuer: z.string().min(1),
  authorization_endpoint: z.string().min(1),
  token_endpoint: z.string().min(1),
  registration_endpoint: z.string().min(1),
});

const ClientRegistrationResponseSchema = z.looseObject({
  client_id: z.string().min(1),
});

const TokenResponseSchema = z.looseObject({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
  scope: z.string().optional(),
});

export interface StartOAuthFlowResult {
  authorizationUrl: string;
  state: string;
  mcpUrl: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * Reads `scopes_supported` from OAuth metadata. A malformed field yields no scopes rather than
 * failing discovery, and invalid scope tokens are dropped.
 */
function parseScopesSupported(metadata: unknown): string[] {
  if (!metadata || typeof metadata !== "object" || !("scopes_supported" in metadata)) return [];
  const raw = metadata.scopes_supported;
  if (!Array.isArray(raw)) return [];
  const scopes = new Set<string>();
  for (const item of raw) {
    if (
      typeof item === "string" &&
      item.length <= OAUTH_SCOPE_TOKEN_MAX &&
      OAUTH_SCOPE_TOKEN.test(item) &&
      scopes.size < OAUTH_SCOPES_MAX
    ) {
      scopes.add(item);
    }
  }
  return [...scopes];
}

/**
 * The scope Bitig requests: every scope the T3 host advertises, so the owner can grant the full
 * access that host project operations need (#BIT-148). The protected resource's list wins
 * (RFC 9728), then the authorization server's (RFC 8414), then `mcp:tools`.
 */
export function resolveT3OAuthScope(resourceMetadata: unknown, authServerMetadata: unknown): string {
  const fromResource = parseScopesSupported(resourceMetadata);
  if (fromResource.length > 0) return fromResource.join(" ");
  const fromAuthServer = parseScopesSupported(authServerMetadata);
  if (fromAuthServer.length > 0) return fromAuthServer.join(" ");
  return DEFAULT_OAUTH_SCOPE;
}

export async function startT3OAuthFlow(input: {
  mcpUrl: string;
  redirectUri: string;
  clientName?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<StartOAuthFlowResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const { mcpUrl, origin } = normalizeT3McpUrl(input.mcpUrl);

  let authServerOrigin = origin;
  let resourceMetadata: unknown = null;
  const resourceMetaResponse = await fetchFn(new URL("/.well-known/oauth-protected-resource", origin), {
    headers: { Accept: "application/json" },
    redirect: "manual",
  }).catch((err: unknown) => {
    throw new T3OAuthError("unreachable_host", `Could not reach T3 host at ${origin}: ${String(err)}`);
  });

  if (isCloudflareAccessLoginRedirect(resourceMetaResponse)) {
    throw new T3OAuthError(
      "cloudflare_access_blocked",
      "Cloudflare Access blocked the request to T3. Verify your Service Auth policy allows the Worker's CF-Access-Client-Id / CF-Access-Client-Secret.",
    );
  }

  if (resourceMetaResponse.ok) {
    const rawMeta: unknown = await resourceMetaResponse.json().catch(() => ({}));
    resourceMetadata = rawMeta;
    const parsedMeta = ProtectedResourceMetadataSchema.safeParse(rawMeta);
    const firstServer = parsedMeta.success ? parsedMeta.data.authorization_servers?.[0] : undefined;
    if (firstServer) {
      authServerOrigin = assertHttpsOrLoopbackUrl(firstServer, "authorization_server").origin;
    }
  }

  const authMetaResponse = await fetchFn(
    new URL("/.well-known/oauth-authorization-server", authServerOrigin),
    {
      headers: { Accept: "application/json" },
      redirect: "manual",
    },
  ).catch((err: unknown) => {
    throw new T3OAuthError(
      "discovery_failed",
      `Failed to fetch OAuth metadata from ${authServerOrigin}: ${String(err)}`,
    );
  });

  if (isCloudflareAccessLoginRedirect(authMetaResponse)) {
    throw new T3OAuthError(
      "cloudflare_access_blocked",
      "Cloudflare Access blocked the request to T3. Verify your Service Auth policy allows the Worker's CF-Access-Client-Id / CF-Access-Client-Secret.",
    );
  }

  if (!authMetaResponse.ok) {
    throw new T3OAuthError(
      "discovery_failed",
      `OAuth metadata discovery returned HTTP ${String(authMetaResponse.status)}`,
    );
  }

  const authMetaJson: unknown = await authMetaResponse.json().catch(() => null);
  const parsedAuthMeta = AuthorizationServerMetadataSchema.safeParse(authMetaJson);
  if (!parsedAuthMeta.success) {
    throw new T3OAuthError("invalid_metadata", "T3 OAuth server returned invalid metadata");
  }

  const {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    registration_endpoint: registrationEndpoint,
  } = parsedAuthMeta.data;

  assertHttpsOrLoopbackUrl(authorizationEndpoint, "authorization_endpoint");
  assertHttpsOrLoopbackUrl(tokenEndpoint, "token_endpoint");
  assertHttpsOrLoopbackUrl(registrationEndpoint, "registration_endpoint");

  const registerResponse = await fetchFn(registrationEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_name: input.clientName ?? BITIG_OAUTH_CLIENT_NAME,
      redirect_uris: [input.redirectUri],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  }).catch((err: unknown) => {
    throw new T3OAuthError("registration_failed", `Dynamic client registration failed: ${String(err)}`);
  });

  if (!registerResponse.ok) {
    throw new T3OAuthError(
      "registration_failed",
      `Dynamic client registration returned HTTP ${String(registerResponse.status)}`,
    );
  }

  const registrationJson: unknown = await registerResponse.json().catch(() => null);
  const parsedRegistration = ClientRegistrationResponseSchema.safeParse(registrationJson);
  if (!parsedRegistration.success) {
    throw new T3OAuthError("registration_failed", "T3 registration endpoint did not return a client_id");
  }

  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = generateOauthState();

  const authUrl = new URL(authorizationEndpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", parsedRegistration.data.client_id);
  authUrl.searchParams.set("redirect_uri", input.redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", mcpUrl);
  authUrl.searchParams.set("scope", resolveT3OAuthScope(resourceMetadata, authMetaJson));

  return {
    authorizationUrl: authUrl.toString(),
    state,
    mcpUrl,
    issuer,
    tokenEndpoint,
    clientId: parsedRegistration.data.client_id,
    codeVerifier,
    redirectUri: input.redirectUri,
  };
}

export interface ExchangeOAuthCodeResult {
  accessToken: string;
  expiresInSeconds: number;
  scope: string;
}

export async function exchangeT3OAuthCode(input: {
  tokenEndpoint: string;
  code: string;
  redirectUri: string;
  clientId: string;
  codeVerifier: string;
  resource: string;
  fetchFn?: typeof fetch | undefined;
}): Promise<ExchangeOAuthCodeResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.clientId,
    code_verifier: input.codeVerifier,
    resource: input.resource,
  });

  const response = await fetchFn(input.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
  }).catch((err: unknown) => {
    throw new T3OAuthError("token_exchange_failed", `OAuth token request failed: ${String(err)}`);
  });

  if (!response.ok) {
    throw new T3OAuthError(
      "token_exchange_failed",
      `OAuth token endpoint returned HTTP ${String(response.status)}`,
    );
  }

  const json: unknown = await response.json().catch(() => null);
  const parsed = TokenResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new T3OAuthError("token_exchange_failed", "OAuth token endpoint returned an invalid payload");
  }

  return {
    accessToken: parsed.data.access_token,
    expiresInSeconds: parsed.data.expires_in ?? DEFAULT_TOKEN_TTL_SECONDS,
    scope: parsed.data.scope ?? DEFAULT_OAUTH_SCOPE,
  };
}

export interface T3LiveThreadReadout {
  gitMetadata?: T3GitMetadata | undefined;
  thread?: T3ThreadSummary | undefined;
  recentRuns?: T3RunSummary[] | undefined;
  pendingRequestIds: string[];
  pendingQuestions: T3PendingQuestion[];
  pendingRequestId?: string | undefined;
  /** Why the thread stopped or failed (e.g. usage limit, credit exhaustion, runtime error, #BIT-132). */
  stopReason?: string | undefined;
}

/** Only parse documented, thread-scoped fields; malformed optional data must not clear saved values. */
export function parseThreadGitMetadata(raw: unknown): T3GitMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const thread = raw as Record<string, unknown>;
  const metadata: T3GitMetadata = {};
  const branch = T3GitMetadataSchema.safeParse({ branch: thread.branch });
  if (thread.branch !== undefined && branch.success) Object.assign(metadata, branch.data);
  if (thread.worktreePath !== undefined) {
    const worktreePath = T3GitMetadataSchema.safeParse({ worktreePath: thread.worktreePath });
    if (worktreePath.success) Object.assign(metadata, worktreePath.data);
  }
  const prs = thread.pullRequests;
  if (Array.isArray(prs)) {
    const urls: string[] = [];
    for (const pr of prs) {
      if (!pr || typeof pr !== "object") return metadata;
      const parsed = T3PullRequestUrlSchema.safeParse((pr as Record<string, unknown>).url);
      if (!parsed.success) return metadata;
      urls.push(parsed.data);
    }
    const parsed = T3GitMetadataSchema.safeParse({ pullRequestUrls: [...new Set(urls)] });
    if (parsed.success) Object.assign(metadata, parsed.data);
  } else if (prs === undefined && thread.linkedPullRequest && typeof thread.linkedPullRequest === "object") {
    const parsed = T3PullRequestUrlSchema.safeParse((thread.linkedPullRequest as Record<string, unknown>).url);
    if (parsed.success) metadata.pullRequestUrls = [parsed.data];
  }
  return metadata;
}

/**
 * Extracts the current checked-out local branch from `t3_worktree_list` (`refs[]`),
 * used when `t3_thread_read` has `branch: null` (for example on root-checkout threads).
 */
export function parseWorktreeCurrentBranch(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const refs = (raw as Record<string, unknown>).refs;
  if (!Array.isArray(refs)) return undefined;
  for (const ref of refs) {
    if (!ref || typeof ref !== "object") continue;
    const rec = ref as Record<string, unknown>;
    if (rec.current !== true || rec.isRemote === true || typeof rec.name !== "string") continue;
    const parsed = T3GitMetadataSchema.safeParse({ branch: rec.name });
    if (parsed.success && typeof parsed.data.branch === "string") {
      return parsed.data.branch;
    }
  }
  return undefined;
}

export interface T3McpClientOptions {
  hostId?: string | undefined;
  mcpUrl: string;
  accessToken: string;
  fetchFn?: typeof fetch | undefined;
}

function assertAllowedTool(name: string): asserts name is T3AllowedMcpTool {
  if (!(T3_ALLOWED_MCP_TOOLS as readonly string[]).includes(name)) {
    throw new T3McpError(
      "forbidden_tool",
      `Tool "${name}" is not in T3_ALLOWED_MCP_TOOLS; Bitig only calls allowlisted T3 tools`,
    );
  }
}

class StreamableHttpAdapter implements Transport {
  readonly inner: StreamableHTTPClientTransport;

  constructor(url: URL, options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1]) {
    this.inner = new StreamableHTTPClientTransport(url, options);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(
    message: Parameters<Transport["send"]>[0],
    options?: Parameters<Transport["send"]>[1],
  ): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  set onclose(handler: () => void) {
    this.inner.onclose = handler;
  }

  set onerror(handler: (error: Error) => void) {
    this.inner.onerror = handler;
  }

  set onmessage(handler: NonNullable<Transport["onmessage"]>) {
    this.inner.onmessage = handler;
  }
}

function isTextContentItem(item: unknown): item is { text: string } {
  return (
    typeof item === "object" &&
    item !== null &&
    "text" in item &&
    typeof item.text === "string"
  );
}

function extractToolPayload(result: {
  isError?: boolean | undefined;
  structuredContent?: unknown;
  content?: unknown;
}): Record<string, unknown> {
  const contentItems: unknown[] = Array.isArray(result.content)
    ? result.content
    : [];

  if (result.isError) {
    const firstText = contentItems.find(isTextContentItem);
    throw new T3McpError(
      "tool_error",
      firstText?.text ?? "T3 MCP tool returned an error",
      parseT3ToolFailure(firstText?.text),
    );
  }

  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent as Record<string, unknown>;
  }

  for (const item of contentItems) {
    if (isTextContentItem(item)) {
      try {
        const parsed: unknown = JSON.parse(item.text);
        if (parsed && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Ignore non-JSON text blocks
      }
    }
  }
  return {};
}

/** Keeps the model options T3 lists (`[{ id, values, default? }]`), dropping malformed entries. */
function parseModelOptions(raw: unknown): T3ModelOption[] {
  if (!Array.isArray(raw)) return [];
  const options: T3ModelOption[] = [];
  for (const item of raw) {
    const parsed = T3ModelOptionSchema.safeParse(item);
    if (parsed.success) {
      options.push(parsed.data);
    }
  }
  return options;
}

/**
 * Reads `modelSelection` from a `t3_thread_configure` result. T3 names the provider instance
 * `instanceId`; options come as `[{ id, value }]`.
 */
function parseThreadModelSelection(payload: Record<string, unknown>): T3ModelSelection | undefined {
  const raw = payload.modelSelection;
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const model = typeof rec.model === "string" ? rec.model.trim() : "";
  const instanceId =
    typeof rec.instanceId === "string"
      ? rec.instanceId.trim()
      : typeof rec.provider === "string"
        ? rec.provider.trim()
        : "";
  if (!model || !instanceId) return undefined;
  const options = T3ModelSelectionOptionsSchema.safeParse(rec.options);
  return {
    providerInstanceId: instanceId,
    model,
    ...(options.success && options.data.length > 0 ? { options: options.data } : {}),
  };
}

function parseThreadSummary(rawThread: unknown): T3ThreadSummary | undefined {
  if (!rawThread || typeof rawThread !== "object") return undefined;
  const rec = rawThread as Record<string, unknown>;
  return {
    ...(typeof rec.status === "string" ? { status: rec.status } : {}),
    ...(typeof rec.pendingRequestCount === "number"
      ? { pendingRequestCount: rec.pendingRequestCount }
      : {}),
    ...(typeof rec.activeRunId === "string" || rec.activeRunId === null
      ? { activeRunId: rec.activeRunId }
      : {}),
    ...(typeof rec.itemCount === "number" && Number.isInteger(rec.itemCount) && rec.itemCount >= 0
      ? { itemCount: rec.itemCount }
      : {}),
  };
}

function parseRecentRuns(rawRuns: unknown): T3RunSummary[] {
  if (!Array.isArray(rawRuns)) return [];
  const recentRuns: T3RunSummary[] = [];
  for (const item of rawRuns) {
    if (item && typeof item === "object") {
      const rec = item as Record<string, unknown>;
      recentRuns.push({
        ...(typeof rec.status === "string" ? { status: rec.status } : {}),
        ...(typeof rec.state === "string" ? { state: rec.state } : {}),
      });
    }
  }
  return recentRuns;
}

const STOP_REASON_TAIL_WINDOW = 30;
const STOP_REASON_MAX_PAGES = 5;

function formatStopItemReason(rec: Record<string, unknown>): string | undefined {
  const title = typeof rec.title === "string" ? rec.title.trim() : "";
  const text = typeof rec.text === "string" ? rec.text.trim() : "";
  if (!title && !text) return undefined;
  const combined =
    !title || text === title || text.startsWith(title)
      ? text || title
      : !text || title.startsWith(text)
        ? title
        : `${title}: ${text}`;
  const singleLine = combined.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= T3_STOP_REASON_MAX
    ? singleLine
    : `${singleLine.slice(0, T3_STOP_REASON_MAX - 1).trimEnd()}\u2026`;
}

/**
 * Extracts why a T3 thread stopped or failed from `t3_thread_read` `items[]` (#BIT-132).
 * Scans the latest turn (after the last `user_message`) for `error` or `system_notice` items
 * (such as model usage limits, credit exhaustion, or terminal runtime errors) and falls back
 * to a short final assistant message when present.
 */
export function parseThreadStopReason(rawItems: unknown): string | undefined {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return undefined;
  const records: Record<string, unknown>[] = [];
  for (const item of rawItems) {
    if (item && typeof item === "object") {
      records.push(item as Record<string, unknown>);
    }
  }
  if (records.length === 0) return undefined;

  let lastUserIdx = -1;
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.type === "user_message") {
      lastUserIdx = i;
      break;
    }
  }
  const latestTurn = lastUserIdx >= 0 ? records.slice(lastUserIdx + 1) : records;

  let errorReason: string | undefined;
  let noticeReason: string | undefined;
  let assistantReason: string | undefined;

  for (const rec of latestTurn) {
    const type = typeof rec.type === "string" ? rec.type : "";
    if (type === "error") {
      const formatted = formatStopItemReason(rec);
      if (formatted) errorReason = formatted;
    } else if (type === "system_notice") {
      const formatted = formatStopItemReason(rec);
      if (formatted) noticeReason = formatted;
    } else if (type === "assistant_message") {
      const text = typeof rec.text === "string" ? rec.text.trim() : "";
      if (text.length > 0 && text.length <= 300) {
        assistantReason = text.replace(/\s+/g, " ");
      }
    }
  }

  if (errorReason && noticeReason && !errorReason.includes(noticeReason) && !noticeReason.includes(errorReason)) {
    const combined = `${errorReason} \u2014 ${noticeReason}`;
    return combined.length <= T3_STOP_REASON_MAX
      ? combined
      : `${combined.slice(0, T3_STOP_REASON_MAX - 1).trimEnd()}\u2026`;
  }
  return errorReason ?? noticeReason ?? assistantReason;
}

/**
 * Extracts user and assistant messages from `t3_thread_read` `items[]`, ignoring tool calls,
 * reasoning, or malformed entries (#BIT-131).
 */
export function parseThreadMessages(rawItems: unknown, maxCharsPerItem: number): T3ThreadMessage[] {
  if (!Array.isArray(rawItems)) return [];
  const messages: T3ThreadMessage[] = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const role =
      rec.type === "user_message"
        ? "user"
        : rec.type === "assistant_message"
          ? "assistant"
          : undefined;
    if (!role) continue;
    if (typeof rec.position !== "number" || !Number.isInteger(rec.position) || rec.position < 0) {
      continue;
    }
    if (typeof rec.text !== "string") continue;

    const overMax = maxCharsPerItem > 0 && rec.text.length > maxCharsPerItem;
    const text = overMax ? rec.text.slice(0, maxCharsPerItem) : rec.text;
    const truncated = rec.textTruncated === true || overMax;

    const parsed = T3ThreadMessageSchema.safeParse({
      position: rec.position,
      role,
      text,
      truncated,
      ...(typeof rec.status === "string" && rec.status.trim().length > 0
        ? { status: rec.status.trim() }
        : {}),
      ...(typeof rec.updatedAt === "string" && rec.updatedAt.trim().length > 0
        ? { updatedAt: rec.updatedAt.trim() }
        : {}),
    });
    if (parsed.success) {
      messages.push(parsed.data);
    }
  }
  return messages;
}

export interface T3ThreadMessagesReadout {
  thread?: T3ThreadSummary | undefined;
  recentRuns: T3RunSummary[];
  messages: T3ThreadMessage[];
  nextPosition: number | null;
  hasMore: boolean;
  stopReason?: string | undefined;
}

async function fetchStopReasonFromActivity(
  callTool: (name: T3AllowedMcpTool, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  threadId: string,
  threadSummary: T3ThreadSummary | undefined,
  fallbackItems: unknown,
): Promise<string | undefined> {
  const itemCount = threadSummary?.itemCount;
  let cursor =
    typeof itemCount === "number" && itemCount > STOP_REASON_TAIL_WINDOW
      ? Math.max(0, itemCount - STOP_REASON_TAIL_WINDOW - 1)
      : undefined;
  const collected: unknown[] = [];

  for (let page = 0; page < STOP_REASON_MAX_PAGES; page++) {
    const payload = await callTool("t3_thread_read", {
      threadId,
      view: "activity",
      limit: STOP_REASON_TAIL_WINDOW,
      runLimit: 1,
      ...(cursor !== undefined ? { afterPosition: cursor } : {}),
    }).catch((): Record<string, unknown> => ({}));

    const pageItems: unknown[] = Array.isArray(payload.items) ? (payload.items as unknown[]) : [];
    collected.push(...pageItems);

    const nextPos =
      typeof payload.nextPosition === "number" &&
      Number.isInteger(payload.nextPosition) &&
      payload.nextPosition >= 0
        ? payload.nextPosition
        : undefined;
    const advanced = nextPos !== undefined && nextPos !== cursor;
    cursor = nextPos;
    if (payload.hasMore !== true || !advanced) {
      break;
    }
  }

  return parseThreadStopReason(collected) ?? parseThreadStopReason(fallbackItems);
}

function parseRemoteProject(item: unknown): T3RemoteProject | undefined {
  if (!item || typeof item !== "object") {
    return undefined;
  }
  const rec = item as Record<string, unknown>;
  const id = typeof rec.id === "string" ? rec.id.trim() : "";
  const title =
    typeof rec.title === "string" && rec.title.trim().length > 0
      ? rec.title.trim()
      : typeof rec.displayName === "string" && rec.displayName.trim().length > 0
        ? rec.displayName.trim()
        : id;
  if (!id || !title) {
    return undefined;
  }
  const parsed = T3RemoteProjectSchema.safeParse({
    id,
    title,
    ...(typeof rec.workspaceRoot === "string" && rec.workspaceRoot.trim().length > 0
      ? { workspaceRoot: rec.workspaceRoot.trim() }
      : {}),
    ...(typeof rec.displayName === "string" && rec.displayName.trim().length > 0
      ? { displayName: rec.displayName.trim() }
      : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function parseRemoteProjects(rawProjects: unknown): T3RemoteProject[] {
  if (!Array.isArray(rawProjects)) return [];
  const projects: T3RemoteProject[] = [];
  for (const item of rawProjects) {
    const project = parseRemoteProject(item);
    if (project) projects.push(project);
  }
  return projects;
}

export class T3McpClient {
  private readonly hostId: string | undefined;
  private readonly mcpUrl: string;
  private readonly accessToken: string;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: T3McpClientOptions) {
    this.hostId = options.hostId;
    this.mcpUrl = normalizeT3McpUrl(options.mcpUrl).mcpUrl;
    this.accessToken = options.accessToken;
    this.fetchFn = options.fetchFn;
  }

  private async withSession<T>(
    run: (
      callTool: (name: T3AllowedMcpTool, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<T>,
    callOptions?: T3CallOptions,
  ): Promise<T> {
    const requestOptions = {
      ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      ...(callOptions?.timeoutMs !== undefined ? { timeout: callOptions.timeoutMs } : {}),
    };
    const transport = new StreamableHttpAdapter(new URL(this.mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
        },
      },
      ...(this.fetchFn ? { fetch: this.fetchFn } : {}),
    });

    const client = new Client({
      name: "bitig-worker",
      version: "1.0.0",
    });

    try {
      callOptions?.signal?.throwIfAborted();
      await client.connect(transport, requestOptions);
      return await run(async (name, args) => {
        assertAllowedTool(name);
        callOptions?.signal?.throwIfAborted();
        const result = await client.callTool({ name, arguments: args }, undefined, requestOptions);
        return extractToolPayload(
          result as unknown as {
            isError?: boolean | undefined;
            structuredContent?: unknown;
            content?: unknown;
          },
        );
      });
    } catch (err) {
      if (err instanceof T3McpError) {
        throw err;
      }
      if (callOptions?.signal?.aborted) {
        throw new T3McpError("aborted", "The T3 request was cancelled before it finished");
      }
      if (err instanceof McpError && err.code === MCP_REQUEST_TIMEOUT_CODE) {
        throw new T3McpError("timeout", `T3 host "${this.hostId ?? this.mcpUrl}" did not answer in time. Check that host's connection and retry.`);
      }
      throw new T3McpError("connection_error", `T3 host "${this.hostId ?? this.mcpUrl}" is unreachable. Check that host's connection and retry. ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      await transport.inner.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  async listProjects(): Promise<T3RemoteProject[]> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_project_list", {});
      return parseRemoteProjects(payload.projects);
    });
  }

  /**
   * Lists every T3 project, following `nextCursor` across pages. `t3_project_list` pages can
   * shift while paging, so a project may appear twice; duplicates are dropped by ID.
   */
  async listAllProjects(options?: T3CallOptions): Promise<T3RemoteProject[]> {
    return this.withSession(async (callTool) => {
      const byId = new Map<string, T3RemoteProject>();
      let cursor: number | undefined;
      for (let page = 0; page < T3_PROJECT_LIST_MAX_PAGES; page += 1) {
        const payload = await callTool("t3_project_list", {
          limit: T3_PROJECT_LIST_PAGE_LIMIT,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const project of parseRemoteProjects(payload.projects)) {
          if (!byId.has(project.id)) byId.set(project.id, project);
        }
        const next = payload.nextCursor;
        if (typeof next !== "number" || !Number.isInteger(next) || next < 0 || next === cursor) {
          return [...byId.values()];
        }
        cursor = next;
      }
      throw new T3McpError(
        "too_many_projects",
        `T3 returned more than ${String(T3_PROJECT_LIST_MAX_PAGES * T3_PROJECT_LIST_PAGE_LIMIT)} projects; cannot check folder registration`,
      );
    }, options);
  }

  /**
   * Registers an existing host folder as a T3 project (#BIT-148). Always sends `workspaceRoot`
   * (without it T3 creates a brand-new repository) and never `createWorkspaceRootIfMissing`, so
   * T3 fails instead of creating a missing folder.
   */
  async registerProject(
    input: { readonly title: string; readonly workspaceRoot: string },
    options?: T3CallOptions,
  ): Promise<T3RemoteProject> {
    const issue = findHostFolderPathIssue(input.workspaceRoot);
    if (issue) {
      throw new T3McpError("invalid_path", hostFolderPathIssueMessage(issue));
    }
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_project_create", {
        title: input.title,
        workspaceRoot: input.workspaceRoot,
      });
      const project = parseRemoteProject(
        payload.project && typeof payload.project === "object" ? payload.project : payload,
      );
      if (!project) {
        throw new T3McpError("invalid_response", "T3 registered the folder but did not return the project ID");
      }
      return project;
    }, options);
  }

  /**
   * Unregisters a T3 project. T3 keeps the folder on disk; `force` is needed when the project
   * still has threads.
   */
  async unregisterProject(
    t3ProjectId: string,
    input?: { readonly force?: boolean | undefined },
    options?: T3CallOptions,
  ): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_project_delete", {
        projectId: t3ProjectId,
        ...(input?.force ? { force: true } : {}),
      });
    }, options);
  }

  async listThreads(input?: {
    readonly allProjects?: boolean | undefined;
    readonly projectId?: string | undefined;
    readonly includeSubagents?: boolean | undefined;
    readonly limit?: number | undefined;
  }): Promise<T3ThreadListItem[]> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_thread_list", {
        allProjects: input?.allProjects ?? true,
        includeSubagents: input?.includeSubagents ?? false,
        limit: input?.limit ?? 100,
        ...(input?.projectId ? { projectId: input.projectId } : {}),
      });
      const rawThreads = Array.isArray(payload.threads) ? payload.threads : [];
      const threads: T3ThreadListItem[] = [];
      for (const item of rawThreads) {
        if (!item || typeof item !== "object") {
          continue;
        }
        const rec = item as Record<string, unknown>;
        const threadId =
          typeof rec.threadId === "string" && rec.threadId.trim().length > 0
            ? rec.threadId.trim()
            : typeof rec.id === "string" && rec.id.trim().length > 0
              ? rec.id.trim()
              : "";
        if (!threadId) {
          continue;
        }
        threads.push({
          threadId,
          ...(typeof rec.projectId === "string" && rec.projectId.trim().length > 0
            ? { projectId: rec.projectId.trim() }
            : {}),
          ...(typeof rec.title === "string" && rec.title.trim().length > 0
            ? { title: rec.title.trim() }
            : {}),
          ...(typeof rec.link === "string" && rec.link.trim().length > 0
            ? { link: rec.link.trim() }
            : {}),
          ...(typeof rec.status === "string" && rec.status.trim().length > 0
            ? { status: rec.status.trim() }
            : {}),
          ...(typeof rec.pendingRequestCount === "number"
            ? { pendingRequestCount: rec.pendingRequestCount }
            : {}),
          ...(typeof rec.activeRunId === "string" || rec.activeRunId === null
            ? { activeRunId: rec.activeRunId }
            : {}),
          ...(typeof rec.settled === "boolean" ? { settled: rec.settled } : {}),
          ...(typeof rec.model === "string" && rec.model.trim().length > 0
            ? { model: rec.model.trim() }
            : {}),
          ...(typeof rec.providerInstanceId === "string" && rec.providerInstanceId.trim().length > 0
            ? { providerInstanceId: rec.providerInstanceId.trim() }
            : {}),
          ...(typeof rec.updatedAt === "string" && rec.updatedAt.trim().length > 0
            ? { updatedAt: rec.updatedAt.trim() }
            : {}),
          gitMetadata: parseThreadGitMetadata(rec),
        });
      }
      return threads;
    });
  }

  async listModelCapabilities(): Promise<T3ModelCapability[]> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("orchestrator_capabilities", {});
      const rawTargets = Array.isArray(payload.providers)
        ? payload.providers
        : Array.isArray(payload.targets)
          ? payload.targets
          : [];
      const capabilities: T3ModelCapability[] = [];
      for (const target of rawTargets) {
        if (!target || typeof target !== "object") {
          continue;
        }
        const rec = target as Record<string, unknown>;
        if (rec.canRunChildTask === false) {
          continue;
        }
        const providerInstanceId =
          typeof rec.providerInstanceId === "string" ? rec.providerInstanceId.trim() : "";
        if (!providerInstanceId) {
          continue;
        }
        const driverKind = typeof rec.driverKind === "string" ? rec.driverKind.trim() : undefined;
        const displayName = typeof rec.displayName === "string" ? rec.displayName.trim() : undefined;
        const models = Array.isArray(rec.models) ? rec.models : [];
        for (const modelEntry of models) {
          if (typeof modelEntry === "string" && modelEntry.trim().length > 0) {
            const parsed = T3ModelCapabilitySchema.safeParse({
              providerInstanceId,
              ...(driverKind ? { driverKind } : {}),
              ...(displayName ? { displayName } : {}),
              model: modelEntry.trim(),
            });
            if (parsed.success) {
              capabilities.push(parsed.data);
            }
          } else if (modelEntry && typeof modelEntry === "object") {
            const mRec = modelEntry as Record<string, unknown>;
            const modelSlug =
              typeof mRec.model === "string"
                ? mRec.model.trim()
                : typeof mRec.id === "string"
                  ? mRec.id.trim()
                  : typeof mRec.slug === "string"
                    ? mRec.slug.trim()
                    : "";
            const label =
              typeof mRec.label === "string"
                ? mRec.label.trim()
                : typeof mRec.name === "string"
                  ? mRec.name.trim()
                  : undefined;
            if (!modelSlug) {
              continue;
            }
            const options = parseModelOptions(mRec.options);
            const parsed = T3ModelCapabilitySchema.safeParse({
              providerInstanceId,
              ...(driverKind ? { driverKind } : {}),
              ...(displayName ? { displayName } : {}),
              model: modelSlug,
              ...(label ? { label } : {}),
              ...(options.length > 0 ? { options } : {}),
            });
            if (parsed.success) {
              capabilities.push(parsed.data);
            }
          }
        }
      }
      return capabilities;
    });
  }

  async launchThread(input: {
    projectId: string;
    title: string;
    prompt: string;
    clientRequestId: string;
    workspaceStrategy: T3WorkspaceStrategy;
    /** Base ref for worktree creation (defaults to `HEAD`; set to the umbrella's branch or headSha for child launches, #BIT-190). */
    baseRef?: string | undefined;
    /** Branch name for worktree creation (e.g. `bitig/<child-code>` for child launches, #BIT-190). */
    branch?: string | undefined;
    /** Whether to create the worktree branch from `origin/<baseRef>` (set `false` for local umbrella refs, #BIT-190). */
    startFromOrigin?: boolean | undefined;
    providerInstanceId?: string | undefined;
    model?: string | undefined;
    /** Model options (e.g. effort) sent with the model, in the `t3_thread_configure` shape. */
    options?: readonly T3ModelSelectionOption[] | undefined;
    /** Permission/approval scope for the T3 thread (#BIT-166). */
    runtimeMode?: T3RuntimeMode | undefined;
  }): Promise<{ threadId: string; link?: string | undefined; gitMetadata?: T3GitMetadata | undefined }> {
    return this.withSession(async (callTool) => {
      const args: Record<string, unknown> = {
        projectId: input.projectId,
        title: input.title,
        message: input.prompt,
        clientRequestId: input.clientRequestId,
      };
      if (input.workspaceStrategy === "worktree") {
        args.workspaceStrategy = {
          type: "worktree",
          baseRef: input.baseRef ?? "HEAD",
          ...(input.branch ? { branch: input.branch } : {}),
          ...(input.startFromOrigin !== undefined ? { startFromOrigin: input.startFromOrigin } : {}),
        };
      }
      if (input.model) {
        args.modelSelection = {
          model: input.model,
          ...(input.providerInstanceId ? { instanceId: input.providerInstanceId } : {}),
          ...(input.options && input.options.length > 0
            ? { options: input.options.map((opt) => ({ id: opt.id, value: opt.value })) }
            : {}),
        };
      }
      if (input.runtimeMode) {
        args.runtimeMode = input.runtimeMode;
      }

      const payload = await callTool("t3_thread_launch", args);
      const threadObj =
        payload.thread && typeof payload.thread === "object"
          ? (payload.thread as Record<string, unknown>)
          : undefined;
      const threadId =
        typeof payload.threadId === "string" && payload.threadId.trim().length > 0
          ? payload.threadId.trim()
          : typeof threadObj?.threadId === "string" && threadObj.threadId.trim().length > 0
            ? threadObj.threadId.trim()
            : typeof threadObj?.id === "string" && threadObj.id.trim().length > 0
              ? threadObj.id.trim()
              : "";
      if (!threadId) {
        throw new T3McpError("invalid_response", "t3_thread_launch did not return a threadId");
      }
      const link =
        typeof payload.link === "string" && payload.link.trim().length > 0
          ? payload.link.trim()
          : typeof threadObj?.link === "string" && threadObj.link.trim().length > 0
            ? threadObj.link.trim()
            : undefined;
      const gitMetadata = parseThreadGitMetadata(threadObj ?? payload);
      if (typeof gitMetadata.branch !== "string") {
        const worktreeListPayload = await callTool("t3_worktree_list", {
          threadId,
          refKind: "local",
          limit: 200,
        }).catch((): Record<string, unknown> => ({}));
        const currentBranch = parseWorktreeCurrentBranch(worktreeListPayload);
        if (currentBranch) {
          gitMetadata.branch = currentBranch;
        } else if (input.branch) {
          gitMetadata.branch = input.branch;
        }
      }
      return {
        threadId,
        ...(link ? { link } : {}),
        ...(Object.keys(gitMetadata).length > 0 ? { gitMetadata } : {}),
      };
    });
  }

  async readThreadLiveStatus(threadId: string): Promise<T3LiveThreadReadout> {
    return this.withSession(async (callTool) => {
      const [threadPayload, pendingListPayload, worktreeListPayload] = await Promise.all([
        callTool("t3_thread_read", {
          threadId,
          limit: 5,
          runLimit: 5,
        }),
        callTool("t3_pending_request", {
          action: "list",
          threadId,
        }).catch((): Record<string, unknown> => ({})),
        callTool("t3_worktree_list", {
          threadId,
          refKind: "local",
          limit: 200,
        }).catch((): Record<string, unknown> => ({})),
      ]);

      const thread = parseThreadSummary(threadPayload.thread);
      const gitMetadata = parseThreadGitMetadata(threadPayload.thread);
      if (typeof gitMetadata.branch !== "string") {
        const currentBranch = parseWorktreeCurrentBranch(worktreeListPayload);
        if (currentBranch) {
          gitMetadata.branch = currentBranch;
        }
      }
      const recentRuns = parseRecentRuns(threadPayload.recentRuns);

      const rawRequestIds: unknown[] = Array.isArray(pendingListPayload.requestIds)
        ? pendingListPayload.requestIds
        : [];
      const pendingRequestIds = rawRequestIds.filter(
        (id: unknown): id is string => typeof id === "string" && id.trim().length > 0,
      );

      let pendingRequestId: string | undefined = pendingRequestIds[0];
      const pendingQuestions: T3PendingQuestion[] = [];

      if (pendingRequestId) {
        const readPending = await callTool("t3_pending_request", {
          action: "read",
          requestId: pendingRequestId,
        }).catch((): Record<string, unknown> => ({}));
        if (typeof readPending.requestId === "string" && readPending.requestId.trim().length > 0) {
          pendingRequestId = readPending.requestId.trim();
        }
        const rawQuestions: unknown[] = Array.isArray(readPending.questions) ? readPending.questions : [];
        for (const q of rawQuestions) {
          const parsed = T3PendingQuestionSchema.safeParse(q);
          if (parsed.success) {
            pendingQuestions.push(parsed.data);
          }
        }
      }

      const liveState = deriveLiveAgentRunState({
        thread,
        recentRuns,
        pendingRequestIds,
      });
      const stopReason =
        liveState === "failed" || liveState === "stopped"
          ? await fetchStopReasonFromActivity(callTool, threadId, thread, threadPayload.items)
          : undefined;

      return {
        gitMetadata,
        ...(thread ? { thread } : {}),
        recentRuns,
        pendingRequestIds,
        pendingQuestions,
        ...(pendingRequestId ? { pendingRequestId } : {}),
        ...(stopReason ? { stopReason } : {}),
      };
    });
  }

  /**
   * Reads why a failed or stopped T3 thread ended (#BIT-132), using `t3_thread_read` (`view: "activity"`)
   * on the tail of the timeline.
   */
  async readThreadStopReason(threadId: string): Promise<string | undefined> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_thread_read", {
        threadId,
        view: "activity",
        limit: STOP_REASON_TAIL_WINDOW,
        runLimit: 1,
      });
      const thread = parseThreadSummary(payload.thread);
      const itemCount = thread?.itemCount;
      if (typeof itemCount === "number" && itemCount > STOP_REASON_TAIL_WINDOW) {
        return fetchStopReasonFromActivity(callTool, threadId, thread, payload.items);
      }
      return parseThreadStopReason(payload.items);
    });
  }

  /**
   * Reads user and assistant messages from a T3 thread (`t3_thread_read` `view: "messages"`, #BIT-131),
   * paged forward with `afterPosition` (exclusive).
   */
  async readThreadMessages(
    threadId: string,
    options: {
      readonly afterPosition?: number | undefined;
      readonly limit: number;
      readonly maxCharsPerItem: number;
    },
  ): Promise<T3ThreadMessagesReadout> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_thread_read", {
        threadId,
        view: "messages",
        limit: options.limit,
        maxCharsPerItem: options.maxCharsPerItem,
        runLimit: 5,
        ...(options.afterPosition !== undefined ? { afterPosition: options.afterPosition } : {}),
      });
      const thread = parseThreadSummary(payload.thread);
      const recentRuns = parseRecentRuns(payload.recentRuns);
      const messages = parseThreadMessages(payload.items, options.maxCharsPerItem);
      const nextPosition =
        typeof payload.nextPosition === "number" &&
        Number.isInteger(payload.nextPosition) &&
        payload.nextPosition >= 0
          ? payload.nextPosition
          : messages.at(-1)?.position ?? null;
      const hasMore = payload.hasMore === true;
      const liveState = deriveLiveAgentRunState({ thread, recentRuns });
      const stopReason =
        !hasMore && (liveState === "failed" || liveState === "stopped")
          ? await fetchStopReasonFromActivity(callTool, threadId, thread, payload.items)
          : undefined;
      return {
        ...(thread ? { thread } : {}),
        recentRuns,
        messages,
        nextPosition,
        hasMore,
        ...(stopReason ? { stopReason } : {}),
      };
    });
  }

  async sendThreadMessage(input: {
    threadId: string;
    prompt: string;
    clientRequestId?: string | undefined;
  }): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_thread_send", {
        threadId: input.threadId,
        message: input.prompt,
        mode: "auto",
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      });
    });
  }

  /** The thread's current provider instance, model and options, or `undefined` when T3 does not say. */
  async readThreadModel(threadId: string): Promise<T3ModelSelection | undefined> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_thread_configure", { threadId });
      return parseThreadModelSelection(payload);
    });
  }

  /**
   * Switches the thread's provider instance, model and options. T3 keeps the thread's permission
   * modes and hands the new model a bounded history of the thread.
   */
  async configureThreadModel(threadId: string, selection: T3ModelSelection): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_thread_configure", {
        threadId,
        modelSelection: {
          instanceId: selection.providerInstanceId,
          model: selection.model,
          ...(selection.options && selection.options.length > 0
            ? { options: selection.options.map((opt) => ({ id: opt.id, value: opt.value })) }
            : {}),
        },
      });
    });
  }

  async interruptThread(threadId: string): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_thread_interrupt", {
        threadId,
        stop: true,
      });
    });
  }

  async settleThread(threadId: string): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_thread_organize", {
        action: "settle",
        threadId,
      });
    });
  }

  async respondToPendingRequest(input: {
    threadId: string;
    requestId: string;
    answers: Record<string, string | string[]>;
  }): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_pending_request", {
        action: "respond",
        threadId: input.threadId,
        requestId: input.requestId,
        answers: input.answers,
      });
    });
  }
}
