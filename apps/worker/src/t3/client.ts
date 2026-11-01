import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  T3_ALLOWED_MCP_TOOLS,
  T3ModelCapabilitySchema,
  T3PendingQuestionSchema,
  T3RemoteProjectSchema,
  normalizeT3McpUrl,
  type T3AllowedMcpTool,
  type T3ModelCapability,
  type T3PendingQuestion,
  type T3RemoteProject,
  type T3RunSummary,
  type T3ThreadSummary,
  type T3WorkspaceStrategy,
} from "@bitig/core";
import { z } from "zod";
import { generateOauthState, generatePkcePair } from "./crypto";

const BITIG_OAUTH_CLIENT_NAME = "Bitig";
const DEFAULT_OAUTH_SCOPE = "mcp:tools";
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

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
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

export async function startT3OAuthFlow(input: {
  mcpUrl: string;
  redirectUri: string;
  clientName?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): Promise<StartOAuthFlowResult> {
  const fetchFn = input.fetchFn ?? fetch;
  const { mcpUrl, origin } = normalizeT3McpUrl(input.mcpUrl);

  let authServerOrigin = origin;
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
  authUrl.searchParams.set("scope", DEFAULT_OAUTH_SCOPE);

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
  thread?: T3ThreadSummary | undefined;
  recentRuns?: T3RunSummary[] | undefined;
  pendingRequestIds: string[];
  pendingQuestions: T3PendingQuestion[];
  pendingRequestId?: string | undefined;
}

export interface T3McpClientOptions {
  mcpUrl: string;
  accessToken: string;
  fetchFn?: typeof fetch | undefined;
}

function assertAllowedTool(name: string): asserts name is T3AllowedMcpTool {
  if (!(T3_ALLOWED_MCP_TOOLS as readonly string[]).includes(name)) {
    throw new T3McpError(
      "forbidden_tool",
      `Tool "${name}" is not in T3_ALLOWED_MCP_TOOLS; Bitig never mutates T3 projects`,
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
    throw new T3McpError("tool_error", firstText?.text ?? "T3 MCP tool returned an error");
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

export class T3McpClient {
  private readonly mcpUrl: string;
  private readonly accessToken: string;
  private readonly fetchFn: typeof fetch | undefined;

  constructor(options: T3McpClientOptions) {
    this.mcpUrl = normalizeT3McpUrl(options.mcpUrl).mcpUrl;
    this.accessToken = options.accessToken;
    this.fetchFn = options.fetchFn;
  }

  private async withSession<T>(
    run: (
      callTool: (name: T3AllowedMcpTool, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
    ) => Promise<T>,
  ): Promise<T> {
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
      await client.connect(transport);
      return await run(async (name, args) => {
        assertAllowedTool(name);
        const result = await client.callTool({ name, arguments: args });
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
      throw new T3McpError("connection_error", err instanceof Error ? err.message : String(err));
    } finally {
      await transport.inner.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  async listProjects(): Promise<T3RemoteProject[]> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("t3_project_list", {});
      const rawProjects = Array.isArray(payload.projects) ? payload.projects : [];
      const projects: T3RemoteProject[] = [];
      for (const item of rawProjects) {
        if (!item || typeof item !== "object") {
          continue;
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
          continue;
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
        if (parsed.success) {
          projects.push(parsed.data);
        }
      }
      return projects;
    });
  }

  async listModelCapabilities(): Promise<T3ModelCapability[]> {
    return this.withSession(async (callTool) => {
      const payload = await callTool("orchestrator_capabilities", {});
      const rawTargets = Array.isArray(payload.targets) ? payload.targets : [];
      const capabilities: T3ModelCapability[] = [];
      for (const target of rawTargets) {
        if (!target || typeof target !== "object") {
          continue;
        }
        const rec = target as Record<string, unknown>;
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
            const parsed = T3ModelCapabilitySchema.safeParse({
              providerInstanceId,
              ...(driverKind ? { driverKind } : {}),
              ...(displayName ? { displayName } : {}),
              model: modelSlug,
              ...(label ? { label } : {}),
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
    providerInstanceId?: string | undefined;
    model?: string | undefined;
  }): Promise<{ threadId: string; link?: string | undefined }> {
    return this.withSession(async (callTool) => {
      const args: Record<string, unknown> = {
        projectId: input.projectId,
        title: input.title,
        prompt: input.prompt,
        clientRequestId: input.clientRequestId,
      };
      if (input.workspaceStrategy === "worktree") {
        args.workspaceStrategy = {
          type: "worktree",
          baseRef: "HEAD",
        };
      }
      if (input.model) {
        args.modelSelection = {
          model: input.model,
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
        };
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
      return {
        threadId,
        ...(link ? { link } : {}),
      };
    });
  }

  async readThreadLiveStatus(threadId: string): Promise<T3LiveThreadReadout> {
    return this.withSession(async (callTool) => {
      const [threadPayload, pendingListPayload] = await Promise.all([
        callTool("t3_thread_read", {
          threadId,
          limit: 5,
          runLimit: 5,
        }),
        callTool("t3_pending_request", {
          action: "list",
          threadId,
        }).catch((): Record<string, unknown> => ({})),
      ]);

      const rawThread =
        threadPayload.thread && typeof threadPayload.thread === "object"
          ? (threadPayload.thread as Record<string, unknown>)
          : undefined;

      const thread: T3ThreadSummary | undefined = rawThread
        ? {
            ...(typeof rawThread.status === "string" ? { status: rawThread.status } : {}),
            ...(typeof rawThread.pendingRequestCount === "number"
              ? { pendingRequestCount: rawThread.pendingRequestCount }
              : {}),
            ...(typeof rawThread.activeRunId === "string" || rawThread.activeRunId === null
              ? { activeRunId: rawThread.activeRunId }
              : {}),
          }
        : undefined;

      const rawRuns = Array.isArray(threadPayload.recentRuns) ? threadPayload.recentRuns : [];
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

      return {
        ...(thread ? { thread } : {}),
        recentRuns,
        pendingRequestIds,
        pendingQuestions,
        ...(pendingRequestId ? { pendingRequestId } : {}),
      };
    });
  }

  async sendThreadMessage(input: { threadId: string; prompt: string }): Promise<void> {
    await this.withSession(async (callTool) => {
      await callTool("t3_thread_send", {
        threadId: input.threadId,
        prompt: input.prompt,
        mode: "auto",
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
