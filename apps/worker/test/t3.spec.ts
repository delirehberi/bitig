import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentRun,
  Project,
  ProjectT3Thread,
  ProjectT3ThreadMessagesResponse,
  ProjectT3ThreadsResponse,
  T3ConnectionStatus,
  T3ModelCapability,
  T3ProjectMapping,
  T3RemoteProject,
  T3RunsLiveResponse,
  T3TaskRunLiveResponse,
  Task,
} from "@bitig/core";
import { createApp } from "../src/index";
import { decryptT3Token, encryptT3Token } from "../src/t3/crypto";
import { TEST_AUTH_HEADER, TEST_T3_ENCRYPTION_KEY } from "./constants";

const BASE_URL = "https://bitig.test";
const T3_ORIGIN = "https://t3.example.test";
const T3_MCP_URL = `${T3_ORIGIN}/mcp`;

const STATEMENTS = [
  "DROP TABLE IF EXISTS `project_t3_threads`",
  "DROP TABLE IF EXISTS `agent_runs`",
  "DROP TABLE IF EXISTS `t3_project_mappings`",
  "DROP TABLE IF EXISTS `t3_oauth_states`",
  "DROP TABLE IF EXISTS `t3_connections`",
  "DROP TABLE IF EXISTS `webhooks`",
  "DROP TABLE IF EXISTS `attachments`",
  "DROP TABLE IF EXISTS `checkpoints`",
  "DROP TABLE IF EXISTS `comments`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  `CREATE TABLE \`projects\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`kind\` text DEFAULT 'hobby' NOT NULL,
    \`resources\` text,
    \`key\` text,
    \`archived\` integer,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`tasks\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`project_id\` text NOT NULL,
    \`title\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`status\` text DEFAULT 'todo' NOT NULL,
    \`is_public\` integer DEFAULT 0 NOT NULL,
    \`due_date\` text,
    \`priority\` text,
    \`labels\` text,
    \`order\` real,
    \`checklist\` text,
    \`needs_human\` text,
    \`pending_approval\` integer,
    \`depends_on\` text,
    \`number\` integer,
    \`started_at\` integer,
    \`completed_at\` integer,
    \`created_by\` text,
    \`started_by\` text,
    \`completed_by\` text,
    \`updated_by\` text,
    \`activity\` text,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `tasks_project_id_idx` ON `tasks` (`project_id`)",
  "CREATE INDEX `tasks_status_idx` ON `tasks` (`status`)",
  "CREATE INDEX `tasks_order_idx` ON `tasks` (`order`)",
  "CREATE UNIQUE INDEX `tasks_project_number_idx` ON `tasks` (`project_id`,`number`)",
  `CREATE TABLE \`comments\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL,
    \`body\` text NOT NULL,
    \`author_type\` text NOT NULL,
    \`author\` text,
    \`created_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `comments_task_id_idx` ON `comments` (`task_id`)",
  `CREATE TABLE \`attachments\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL,
    \`name\` text NOT NULL,
    \`mime_type\` text NOT NULL,
    \`size\` integer NOT NULL,
    \`created_at\` integer NOT NULL,
    \`created_by\` text,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `attachments_task_id_idx` ON `attachments` (`task_id`)",
  "CREATE TABLE `checkpoints` (`id` text PRIMARY KEY NOT NULL, `task_id` text NOT NULL, `step_index` integer NOT NULL, `status` text NOT NULL, `state_snapshot` text NOT NULL, `created_at` integer NOT NULL, `created_by` text, FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade)",
  "CREATE UNIQUE INDEX `checkpoints_task_step_idx` ON `checkpoints` (`task_id`,`step_index`)",
  `CREATE TABLE \`webhooks\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`project_id\` text NOT NULL,
    \`name\` text NOT NULL,
    \`provider\` text DEFAULT 'generic' NOT NULL,
    \`token\` text NOT NULL,
    \`enabled\` integer DEFAULT 1 NOT NULL,
    \`mapping\` text,
    \`default_priority\` text,
    \`default_labels\` text,
    \`trigger_count\` integer DEFAULT 0 NOT NULL,
    \`last_triggered_at\` integer,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `webhooks_project_id_idx` ON `webhooks` (`project_id`)",
  "CREATE UNIQUE INDEX `webhooks_token_idx` ON `webhooks` (`token`)",
  `CREATE TABLE \`t3_connections\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`mcp_url\` text NOT NULL,
    \`issuer\` text NOT NULL,
    \`client_id\` text NOT NULL,
    \`encrypted_access_token\` text NOT NULL,
    \`token_iv\` text NOT NULL,
    \`scope\` text NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`connected_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`t3_oauth_states\` (
    \`state\` text PRIMARY KEY NOT NULL,
    \`mcp_url\` text NOT NULL,
    \`issuer\` text NOT NULL,
    \`token_endpoint\` text NOT NULL,
    \`client_id\` text NOT NULL,
    \`code_verifier\` text NOT NULL,
    \`redirect_uri\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`t3_project_mappings\` (
    \`project_id\` text PRIMARY KEY NOT NULL,
    \`t3_project_id\` text NOT NULL,
    \`t3_project_title\` text NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  `CREATE TABLE \`agent_runs\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL,
    \`t3_project_id\` text NOT NULL,
    \`thread_id\` text NOT NULL,
    \`link\` text,
    \`state\` text NOT NULL,
    \`model\` text,
    \`provider_instance_id\` text,
    \`model_options\` text,
    \`workspace_strategy\` text,
    \`started_by\` text,
    \`started_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `agent_runs_task_id_idx` ON `agent_runs` (`task_id`)",
  "CREATE INDEX `agent_runs_thread_id_idx` ON `agent_runs` (`thread_id`)",
  `CREATE TABLE \`project_t3_threads\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`project_id\` text NOT NULL,
    \`t3_project_id\` text NOT NULL,
    \`thread_id\` text NOT NULL,
    \`title\` text NOT NULL,
    \`link\` text,
    \`state\` text NOT NULL,
    \`model\` text,
    \`provider_instance_id\` text,
    \`model_options\` text,
    \`workspace_strategy\` text NOT NULL,
    \`started_by\` text,
    \`started_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `project_t3_threads_thread_id_idx` ON `project_t3_threads` (`thread_id`)",
  "CREATE INDEX `project_t3_threads_project_id_idx` ON `project_t3_threads` (`project_id`)",
];

interface RecordedToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

interface MockT3ServerState {
  expiresInSeconds: number;
  failMcpConnection: boolean;
  threadStatus: string;
  pendingRequestCount: number;
  pendingRequestIds: string[];
  pendingQuestions: {
    id: string;
    header?: string;
    question: string;
    options?: { label: string; description?: string }[];
  }[];
  recentRunStatus: string;
  activeRunId: string | null;
  threadModelSelection: Record<string, unknown>;
  threadList: Record<string, unknown>[];
  /** Thread ID the next `t3_thread_launch` returns; defaults to `thread-abc-123`. */
  launchThreadId?: string;
  /** Raw `items` returned by `t3_thread_read` (#BIT-131). */
  threadItems?: unknown[];
  /** Override `hasMore` on `t3_thread_read` (#BIT-131). */
  threadHasMore?: boolean;
  toolCalls: RecordedToolCall[];
}

function createMockT3Fetch(state: MockT3ServerState): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      return Promise.resolve(
        Response.json({
          resource: T3_MCP_URL,
          authorization_servers: [T3_ORIGIN],
          scopes_supported: ["mcp:tools"],
        }),
      );
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Promise.resolve(
        Response.json({
          issuer: T3_ORIGIN,
          authorization_endpoint: `${T3_ORIGIN}/oauth/mcp/authorize`,
          token_endpoint: `${T3_ORIGIN}/oauth/mcp/token`,
          registration_endpoint: `${T3_ORIGIN}/oauth/mcp/register`,
          code_challenge_methods_supported: ["S256"],
        }),
      );
    }

    if (url.pathname === "/oauth/mcp/register" && req.method === "POST") {
      return Promise.resolve(
        Response.json(
          {
            client_id: "t3-client-test-1",
            client_name: "Bitig",
          },
          { status: 201 },
        ),
      );
    }

    if (url.pathname === "/oauth/mcp/token" && req.method === "POST") {
      return Promise.resolve(
        Response.json({
          access_token: "t3-secret-bearer-token-value",
          token_type: "Bearer",
          expires_in: state.expiresInSeconds,
          scope: "mcp:tools",
        }),
      );
    }

    if (url.pathname === "/mcp") {
      if (state.failMcpConnection) {
        return Promise.reject(new Error("Simulated T3 host unreachable"));
      }
      const authHeader = req.headers.get("authorization");
      if (authHeader !== "Bearer t3-secret-bearer-token-value") {
        return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
      }
      if (req.method === "GET") {
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      if (req.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (req.method === "POST") {
        return req.json().then((rawBody: unknown) => {
          const body = rawBody as {
            id?: string | number;
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };
          const headers = { "mcp-session-id": "mock-t3-session" };
          if (body.method === "initialize") {
            return Response.json(
              {
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  protocolVersion: "2025-06-18",
                  capabilities: { tools: {} },
                  serverInfo: { name: "t3-code-mock", version: "0.1.6" },
                },
              },
              { headers },
            );
          }
          if (body.method === "notifications/initialized") {
            return new Response(null, { status: 202, headers });
          }
          if (body.method === "tools/call") {
            const toolName = body.params?.name ?? "";
            const toolArgs = body.params?.arguments ?? {};
            state.toolCalls.push({ name: toolName, arguments: toolArgs });

            let payload: Record<string, unknown> = {};
            if (toolName === "t3_project_list") {
              payload = {
                projects: [
                  {
                    id: "t3-proj-bitig",
                    title: "bitig",
                    displayName: "Bitig Workspace",
                    workspaceRoot: "/home/delirehberi/www/bitig",
                  },
                ],
              };
            } else if (toolName === "orchestrator_capabilities") {
              payload = {
                providers: [
                  {
                    providerInstanceId: "prov-claude",
                    driverKind: "claude",
                    displayName: "Claude Code",
                    canRunChildTask: true,
                    models: [
                      {
                        id: "claude-opus-4-7",
                        label: "Claude Opus 4.7",
                        options: [
                          { id: "effort", values: ["low", "medium", "high"], default: "medium" },
                          { id: "fastMode", values: [false, true] },
                        ],
                      },
                    ],
                  },
                  {
                    providerInstanceId: "prov-codex",
                    driverKind: "codex",
                    displayName: "Codex",
                    canRunChildTask: true,
                    models: [
                      {
                        id: "gpt-6-sol",
                        options: [{ id: "reasoningEffort", values: ["low", "high"], default: "low" }],
                      },
                    ],
                  },
                  {
                    providerInstanceId: "prov-disabled",
                    driverKind: "cursor",
                    displayName: "Cursor",
                    canRunChildTask: false,
                    models: [{ id: "cursor-model", label: "Cursor Model" }],
                  },
                ],
              };
            } else if (toolName === "t3_thread_launch") {
              const launchedId = state.launchThreadId ?? "thread-abc-123";
              payload = {
                threadId: launchedId,
                link: `${T3_ORIGIN}/threads/${launchedId}`,
              };
            } else if (toolName === "t3_thread_list") {
              payload = {
                threads: state.threadList,
              };
            } else if (toolName === "t3_thread_read") {
              const rawItems = state.threadItems ?? [];
              const afterPos =
                typeof toolArgs.afterPosition === "number" ? toolArgs.afterPosition : undefined;
              const filteredItems =
                afterPos === undefined
                  ? rawItems
                  : rawItems.filter((item) => {
                      if (!item || typeof item !== "object") return true;
                      const pos = (item as Record<string, unknown>).position;
                      return typeof pos === "number" ? pos > afterPos : true;
                    });
              let lastPos: number | null = null;
              for (const item of filteredItems) {
                if (item && typeof item === "object") {
                  const pos = (item as Record<string, unknown>).position;
                  if (typeof pos === "number") {
                    lastPos = pos;
                  }
                }
              }
              payload = {
                thread: {
                  id: "thread-abc-123",
                  status: state.threadStatus,
                  pendingRequestCount: state.pendingRequestCount,
                  activeRunId: state.activeRunId,
                },
                recentRuns: [{ status: state.recentRunStatus }],
                items: filteredItems,
                nextPosition: lastPos,
                hasMore: state.threadHasMore ?? false,
              };
            } else if (toolName === "t3_pending_request") {
              if (toolArgs.action === "list") {
                payload = { requestIds: state.pendingRequestIds };
              } else if (toolArgs.action === "read") {
                payload = {
                  requestId: toolArgs.requestId,
                  questions: state.pendingQuestions,
                };
              } else if (toolArgs.action === "respond") {
                payload = { ok: true };
              }
            } else if (toolName === "t3_thread_send") {
              payload = { ok: true };
            } else if (toolName === "t3_thread_interrupt") {
              payload = { ok: true };
            } else if (toolName === "t3_thread_organize") {
              payload = { ok: true };
            } else if (toolName === "t3_thread_configure") {
              if (toolArgs.modelSelection && typeof toolArgs.modelSelection === "object") {
                state.threadModelSelection = toolArgs.modelSelection as Record<string, unknown>;
              }
              payload = {
                threadId: toolArgs.threadId,
                modelSelection: state.threadModelSelection,
                runtimeMode: "auto",
                interactionMode: "default",
              };
            }

            return Response.json(
              {
                jsonrpc: "2.0",
                id: body.id,
                result: {
                  structuredContent: payload,
                  content: [{ type: "text", text: JSON.stringify(payload) }],
                },
              },
              { headers },
            );
          }

          return Response.json({ jsonrpc: "2.0", id: body.id, result: {} }, { headers });
        });
      }
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };
}

describe("T3 Code integration (BIT-107, BIT-108, BIT-109)", () => {
  let mockState: MockT3ServerState;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
    mockState = {
      expiresInSeconds: 30 * 24 * 60 * 60,
      failMcpConnection: false,
      threadStatus: "running",
      pendingRequestCount: 0,
      pendingRequestIds: [],
      pendingQuestions: [],
      recentRunStatus: "running",
      activeRunId: null,
      threadModelSelection: { instanceId: "prov-claude", model: "claude-opus-4-7" },
      threadList: [],
      toolCalls: [],
    };
    app = createApp({ t3Fetch: createMockT3Fetch(mockState) });
  });

  function request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) {
      headers.set("Authorization", TEST_AUTH_HEADER);
    }
    return Promise.resolve(app.request(`${BASE_URL}${path}`, { ...init, headers }, env));
  }

  async function connectT3Host(): Promise<void> {
    const startRes = await request("/api/t3/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mcpUrl: T3_MCP_URL }),
    });
    expect(startRes.status).toBe(200);
    const { state } = await startRes.json<{ authorizationUrl: string; state: string }>();

    // Top-level OAuth redirect from T3 does NOT carry Bitig auth headers or session cookies
    const callbackRes = await app.request(
      `${BASE_URL}/api/t3/oauth/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}`,
      { method: "GET" },
      env,
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get("location")).toBe(`${BASE_URL}/settings?t3=connected`);
  }

  it("encrypts and decrypts T3 tokens with AES-256-GCM and a fresh IV", async () => {
    const first = await encryptT3Token("secret-token-123", TEST_T3_ENCRYPTION_KEY);
    const second = await encryptT3Token("secret-token-123", TEST_T3_ENCRYPTION_KEY);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(await decryptT3Token(first, TEST_T3_ENCRYPTION_KEY)).toBe("secret-token-123");
    expect(await decryptT3Token(second, TEST_T3_ENCRYPTION_KEY)).toBe("secret-token-123");
  });

  it("completes the OAuth PKCE flow, encrypts the token in D1, warns when <5 days left, and disconnects", async () => {
    mockState.expiresInSeconds = 3 * 24 * 60 * 60; // 3 days -> expiringSoon: true
    await connectT3Host();

    // Verify raw D1 row does not contain the plaintext token
    const rawRow = await env.DB.prepare(
      "SELECT encrypted_access_token, token_iv FROM t3_connections WHERE id = 'default'",
    ).first<{
      encrypted_access_token: string;
      token_iv: string;
    }>();
    expect(rawRow).toBeTruthy();
    expect(rawRow?.encrypted_access_token).not.toContain("t3-secret-bearer-token-value");
    expect(
      await decryptT3Token(
        {
          ciphertext: rawRow?.encrypted_access_token ?? "",
          iv: rawRow?.token_iv ?? "",
        },
        TEST_T3_ENCRYPTION_KEY,
      ),
    ).toBe("t3-secret-bearer-token-value");

    const statusRes = await request("/api/t3/connection");
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json<T3ConnectionStatus>();
    expect(status.connected).toBe(true);
    expect(status.mcpUrl).toBe(T3_MCP_URL);
    expect(status.expiringSoon).toBe(true);
    expect(status.expired).toBe(false);

    // Reusing the same OAuth state is rejected
    const replayRes = await app.request(
      `${BASE_URL}/api/t3/oauth/callback?code=auth-code-xyz&state=already-used`,
      { method: "GET" },
      env,
    );
    expect(replayRes.status).toBe(400);

    // Disconnect
    const delRes = await request("/api/t3/connection", { method: "DELETE" });
    expect(delRes.status).toBe(204);

    const afterDel = await (await request("/api/t3/connection")).json<T3ConnectionStatus>();
    expect(afterDel.connected).toBe(false);
  });

  it("lists remote T3 projects and manages read-only project mappings without calling project mutation tools", async () => {
    await connectT3Host();

    const projRes = await request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bitig", key: "BIT" }),
    });
    const project = await projRes.json<Project>();

    const remoteRes = await request("/api/t3/projects");
    expect(remoteRes.status).toBe(200);
    const { projects: remoteProjects } = await remoteRes.json<{ projects: T3RemoteProject[] }>();
    expect(remoteProjects).toEqual([
      {
        id: "t3-proj-bitig",
        title: "bitig",
        displayName: "Bitig Workspace",
        workspaceRoot: "/home/delirehberi/www/bitig",
      },
    ]);

    const capRes = await request("/api/t3/capabilities");
    expect(capRes.status).toBe(200);
    const { capabilities } = await capRes.json<{ capabilities: T3ModelCapability[] }>();
    expect(capabilities).toEqual([
      {
        providerInstanceId: "prov-claude",
        driverKind: "claude",
        displayName: "Claude Code",
        model: "claude-opus-4-7",
        label: "Claude Opus 4.7",
        options: [
          { id: "effort", values: ["low", "medium", "high"], default: "medium" },
          { id: "fastMode", values: [false, true] },
        ],
      },
      {
        providerInstanceId: "prov-codex",
        driverKind: "codex",
        displayName: "Codex",
        model: "gpt-6-sol",
        options: [{ id: "reasoningEffort", values: ["low", "high"], default: "low" }],
      },
    ]);

    // The model list is cached: a second request does not call orchestrator_capabilities again
    const capCalls = (): number => mockState.toolCalls.filter((call) => call.name === "orchestrator_capabilities").length;
    expect(capCalls()).toBe(1);
    const cachedRes = await request("/api/t3/capabilities");
    expect(await cachedRes.json<{ capabilities: T3ModelCapability[] }>()).toEqual({ capabilities });
    expect(capCalls()).toBe(1);

    const mapRes = await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        t3ProjectId: "t3-proj-bitig",
        t3ProjectTitle: "Bitig Workspace",
      }),
    });
    expect(mapRes.status).toBe(200);

    const listMapRes = await request("/api/t3/mappings");
    const { mappings } = await listMapRes.json<{ mappings: T3ProjectMapping[] }>();
    expect(mappings).toHaveLength(1);
    expect(mappings[0]?.t3ProjectId).toBe("t3-proj-bitig");

    // Verify no forbidden project mutation tool was called
    const calledNames = mockState.toolCalls.map((c) => c.name);
    expect(calledNames).not.toContain("t3_project_create");
    expect(calledNames).not.toContain("t3_project_update");
    expect(calledNames).not.toContain("t3_project_delete");
    expect(calledNames).not.toContain("t3_project_clone");
  });

  it("enforces pendingApproval, dependency, and project mapping gates before launching a T3 thread", async () => {
    await connectT3Host();

    const projRes = await request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bitig", key: "BIT" }),
    });
    const project = await projRes.json<Project>();

    const depRes = await request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, title: "Prerequisite task" }),
    });
    const depTask = await depRes.json<Task>();

    const unapprovedRes = await request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        title: "Needs approval first",
        pendingApproval: true,
      }),
    });
    const unapprovedTask = await unapprovedRes.json<Task>();

    const blockedRes = await request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        title: "Blocked task",
        dependsOn: [depTask.id],
      }),
    });
    const blockedTask = await blockedRes.json<Task>();

    // 1. Refused when pendingApproval is true
    const res1 = await request(`/api/tasks/${unapprovedTask.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res1.status).toBe(400);

    // 2. Refused when blocked by unfinished dependency
    const res2 = await request(`/api/tasks/${blockedTask.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res2.status).toBe(400);

    // 3. Refused when project is not mapped
    const res3 = await request(`/api/tasks/${depTask.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res3.status).toBe(400);

    // Map the project and launch depTask
    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        t3ProjectId: "t3-proj-bitig",
        t3ProjectTitle: "Bitig Workspace",
      }),
    });

    const launchRes = await request(`/api/tasks/${depTask.id}/t3-run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bitig-Actor": "emre",
      },
      body: JSON.stringify({
        workspaceStrategy: "worktree",
        providerInstanceId: "prov-claude",
        model: "claude-opus-4-7",
      }),
    });
    expect(launchRes.status).toBe(201);
    const launched = await launchRes.json<{ run: AgentRun; task: Task; code?: string }>();
    expect(launched.code).toBe("BIT-1");
    expect(launched.run.threadId).toBe("thread-abc-123");
    expect(launched.run.state).toBe("working");
    expect(launched.run.startedBy).toBe("emre");
    expect(launched.task.status).toBe("in_progress");
    expect(launched.task.startedBy).toBe("emre");

    const launchCall = mockState.toolCalls.find((c) => c.name === "t3_thread_launch");
    expect(launchCall?.arguments).toMatchObject({
      projectId: "t3-proj-bitig",
      title: "BIT-1 Prerequisite task",
      clientRequestId: "BIT-1",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      modelSelection: { instanceId: "prov-claude", model: "claude-opus-4-7" },
    });
  });

  it("checks live T3 thread status without auto-transitioning task status, and supports comment follow-ups, respond, and stop", async () => {
    await connectT3Host();

    const projRes = await request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Bitig", key: "BIT" }),
    });
    const project = await projRes.json<Project>();

    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        t3ProjectId: "t3-proj-bitig",
        t3ProjectTitle: "Bitig Workspace",
      }),
    });

    const taskRes = await request("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id, title: "Live sync task" }),
    });
    const task = await taskRes.json<Task>();

    await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Simulate pending user-input question in T3
    mockState.threadStatus = "waiting";
    mockState.pendingRequestCount = 1;
    mockState.pendingRequestIds = ["req-42"];
    mockState.pendingQuestions = [
      {
        id: "q-scope",
        header: "Scope",
        question: "Should we include migration?",
        options: [{ label: "Yes" }, { label: "No" }],
      },
    ];

    const liveWaitingRes = await request(`/api/tasks/${task.id}/t3-run`);
    expect(liveWaitingRes.status).toBe(200);
    const liveWaiting = await liveWaitingRes.json<T3TaskRunLiveResponse>();
    expect(liveWaiting.run?.state).toBe("waiting_for_approval");
    expect(liveWaiting.pendingRequestId).toBe("req-42");
    expect(liveWaiting.pendingQuestions).toHaveLength(1);
    expect(liveWaiting.pendingQuestions[0]?.question).toBe("Should we include migration?");

    // Answer the pending question from Bitig
    const respondRes = await request(`/api/tasks/${task.id}/t3-run/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requestId: "req-42",
        answers: { "q-scope": "Yes" },
      }),
    });
    expect(respondRes.status).toBe(200);
    const afterRespond = await respondRes.json<T3TaskRunLiveResponse>();
    expect(afterRespond.run?.state).toBe("working");

    // A person's comment is forwarded to the T3 thread as a follow-up
    const sendCallsBefore = mockState.toolCalls.filter((c) => c.name === "t3_thread_send").length;
    const commentRes = await request(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Please also update docs/security.md" }),
    });
    expect(commentRes.status).toBe(201);
    const sendCalls = mockState.toolCalls.filter((c) => c.name === "t3_thread_send");
    expect(sendCalls).toHaveLength(sendCallsBefore + 1);
    expect(sendCalls.at(-1)?.arguments).toMatchObject({
      threadId: "thread-abc-123",
      message: expect.stringContaining("Please also update docs/security.md") as unknown,
    });

    // The old follow-up endpoint is gone
    const msgRes = await request(`/api/tasks/${task.id}/t3-run/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(msgRes.status).toBe(404);

    // Simulate thread finished in T3: live check updates agent_runs.state to "finished"
    // but NEVER auto-transitions the Bitig task to "done"
    mockState.threadStatus = "idle";
    mockState.pendingRequestCount = 0;
    mockState.pendingRequestIds = [];
    mockState.recentRunStatus = "completed";

    const liveFinishedRes = await request(`/api/tasks/${task.id}/t3-run`);
    const liveFinished = await liveFinishedRes.json<T3TaskRunLiveResponse>();
    expect(liveFinished.run?.state).toBe("finished");

    const taskAfterFinished = await (await request(`/api/tasks/${task.id}`)).json<Task>();
    expect(taskAfterFinished.status).toBe("in_progress");

    // Stop the thread
    const stopRes = await request(`/api/tasks/${task.id}/t3-run/stop`, {
      method: "POST",
    });
    expect(stopRes.status).toBe(200);
    const afterStop = await stopRes.json<T3TaskRunLiveResponse>();
    expect(afterStop.run?.state).toBe("stopped");
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_interrupt")).toBe(true);

    // Simulate T3 host offline
    mockState.failMcpConnection = true;
    const offlineRes = await request(`/api/tasks/${task.id}/t3-run`);
    const offline = await offlineRes.json<T3TaskRunLiveResponse>();
    expect(offline.run?.state).toBe("offline");
  });

  it("forwards only people's comments on reachable runs to T3, and keeps the comment when T3 fails", async () => {
    await connectT3Host();
    const project = await (
      await request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bitig", key: "BIT" }),
      })
    ).json<Project>();
    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t3ProjectId: "t3-proj-bitig", t3ProjectTitle: "Bitig Workspace" }),
    });

    async function createTask(title: string): Promise<Task> {
      const res = await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, title }),
      });
      return res.json<Task>();
    }
    async function postComment(taskId: string, payload: Record<string, unknown>): Promise<Response> {
      return request(`/api/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const sendCount = (): number => mockState.toolCalls.filter((c) => c.name === "t3_thread_send").length;

    // A task without a T3 run: the comment is stored, nothing is sent
    const noRunTask = await createTask("No run");
    expect((await postComment(noRunTask.id, { body: "Any update?" })).status).toBe(201);
    expect(sendCount()).toBe(0);

    const task = await createTask("Has run");
    await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Agent comments never wake the agent
    expect((await postComment(task.id, { body: "Progress note", authorType: "agent", author: "claude" })).status).toBe(201);
    expect(sendCount()).toBe(0);

    // A person's comment on a finished run is sent with the task code and author, and the run resumes
    mockState.threadStatus = "idle";
    mockState.recentRunStatus = "completed";
    const finished = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(finished.run?.state).toBe("finished");
    expect((await postComment(task.id, { body: "Looks good, now add tests.", author: "emre" })).status).toBe(201);
    expect(sendCount()).toBe(1);
    const sent = mockState.toolCalls.filter((c) => c.name === "t3_thread_send").at(-1);
    expect(sent?.arguments).toMatchObject({
      threadId: "thread-abc-123",
      message: `New comment on BIT-${String(task.number)} from emre:\n\nLooks good, now add tests.`,
    });
    const storedRun = await env.DB.prepare("SELECT state FROM agent_runs WHERE task_id = ?")
      .bind(task.id)
      .first<{ state: string }>();
    expect(storedRun?.state).toBe("working");

    // T3 failure: the comment is still created and listed
    mockState.failMcpConnection = true;
    const failedRes = await postComment(task.id, { body: "Are you there?" });
    expect(failedRes.status).toBe(201);
    const comments = await (await request(`/api/tasks/${task.id}/comments`)).json<{ body: string }[]>();
    expect(comments.map((c) => c.body)).toContain("Are you there?");

    // An offline run is skipped without contacting T3
    const offline = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(offline.run?.state).toBe("offline");
    mockState.failMcpConnection = false;
    const callsBefore = mockState.toolCalls.length;
    expect((await postComment(task.id, { body: "Ping while offline" })).status).toBe(201);
    expect(mockState.toolCalls).toHaveLength(callsBefore);
  });

  it("marks the T3 thread as settled when archiving a task, and still archives when T3 is unreachable", async () => {
    await connectT3Host();
    const project = await (
      await request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bitig", key: "BIT" }),
      })
    ).json<Project>();
    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t3ProjectId: "t3-proj-bitig", t3ProjectTitle: "Bitig Workspace" }),
    });

    async function createTask(title: string): Promise<Task> {
      const res = await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, title }),
      });
      return res.json<Task>();
    }
    async function patchTask(taskId: string, payload: Record<string, unknown>): Promise<Response> {
      return request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const organizeCalls = () => mockState.toolCalls.filter((c) => c.name === "t3_thread_organize");

    // A task without a T3 run: archiving succeeds, no T3 organize call is made
    const noRunTask = await createTask("No T3 run");
    expect((await patchTask(noRunTask.id, { status: "archived" })).status).toBe(200);
    expect(organizeCalls()).toHaveLength(0);

    // A task with a T3 run: moving to done does not settle, moving to archived settles the T3 thread
    const task = await createTask("Has T3 run");
    await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect((await patchTask(task.id, { status: "done" })).status).toBe(200);
    expect(organizeCalls()).toHaveLength(0);

    const archiveRes = await patchTask(task.id, { status: "archived" });
    expect(archiveRes.status).toBe(200);
    const archivedTask = await archiveRes.json<Task>();
    expect(archivedTask.status).toBe("archived");
    expect(organizeCalls()).toHaveLength(1);
    expect(organizeCalls().at(-1)?.arguments).toEqual({
      action: "settle",
      threadId: "thread-abc-123",
    });
    const storedRun = await env.DB.prepare("SELECT state FROM agent_runs WHERE task_id = ?")
      .bind(task.id)
      .first<{ state: string }>();
    expect(storedRun?.state).toBe("finished");

    // Editing an already-archived task (even with status: "archived" in payload) does not re-settle
    expect((await patchTask(task.id, { title: "Renamed while archived", status: "archived" })).status).toBe(200);
    expect(organizeCalls()).toHaveLength(1);

    // T3 failure: archiving still succeeds in Bitig
    const failingTask = await createTask("T3 fails on archive");
    await request(`/api/tasks/${failingTask.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    mockState.failMcpConnection = true;
    const failedArchiveRes = await patchTask(failingTask.id, { status: "archived" });
    expect(failedArchiveRes.status).toBe(200);
    expect((await failedArchiveRes.json<Task>()).status).toBe("archived");
  });

  it("replies to a waiting thread and switches its model first, only while the thread is not mid-turn (BIT-119)", async () => {
    await connectT3Host();
    const project = await (
      await request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bitig", key: "BIT" }),
      })
    ).json<Project>();
    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t3ProjectId: "t3-proj-bitig", t3ProjectTitle: "Bitig Workspace" }),
    });
    const task = await (
      await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, title: "Switch models" }),
      })
    ).json<Task>();

    function reply(taskId: string, payload: Record<string, unknown>): Promise<Response> {
      return request(`/api/tasks/${taskId}/t3-run/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    const codexSelection = {
      providerInstanceId: "prov-codex",
      model: "gpt-6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const listComments = async (): Promise<{ body: string; authorType: string; author?: string }[]> =>
      (await request(`/api/tasks/${task.id}/comments`)).json();

    // No run yet: the reply is refused and nothing is saved
    const noRunRes = await reply(task.id, { body: "Hello" });
    expect(noRunRes.status).toBe(400);
    expect(await listComments()).toHaveLength(0);

    await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    // Mid-turn: the switch is refused with 409, T3 is not reconfigured, no comment is saved
    mockState.threadStatus = "running";
    mockState.recentRunStatus = "running";
    mockState.activeRunId = "run-1";
    const busyRes = await reply(task.id, { body: "Use Codex", modelSelection: codexSelection });
    expect(busyRes.status).toBe(409);
    expect(await busyRes.json<{ error: string; state: string }>()).toMatchObject({ error: "thread_busy", state: "working" });
    expect(mockState.toolCalls.some((call) => call.name === "t3_thread_configure" && call.arguments.modelSelection)).toBe(false);
    expect(mockState.toolCalls.some((call) => call.name === "t3_thread_send")).toBe(false);
    expect(await listComments()).toHaveLength(0);

    // Waiting on a person (usage limit or question): configure first, then send with a resume notice
    mockState.threadStatus = "waiting";
    mockState.pendingRequestCount = 1;
    mockState.pendingRequestIds = ["req-limit"];
    const switchRes = await reply(task.id, { body: "Out of budget, continue on Codex.", author: "emre", modelSelection: codexSelection });
    expect(switchRes.status).toBe(201);
    const switched = await switchRes.json<{ comment: { body: string }; switchComment?: { body: string; author?: string }; run: AgentRun }>();

    const configureIndex = mockState.toolCalls.findIndex((call) => call.name === "t3_thread_configure" && call.arguments.modelSelection);
    const sendIndex = mockState.toolCalls.findIndex((call) => call.name === "t3_thread_send");
    expect(configureIndex).toBeGreaterThanOrEqual(0);
    expect(sendIndex).toBeGreaterThan(configureIndex);
    expect(mockState.toolCalls[configureIndex]?.arguments).toEqual({
      threadId: "thread-abc-123",
      modelSelection: { instanceId: "prov-codex", model: "gpt-6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
    });
    const sentMessage = String(mockState.toolCalls[sendIndex]?.arguments.message);
    expect(mockState.toolCalls[sendIndex]?.arguments.mode).toBe("auto");
    expect(sentMessage).toMatch(/^The thread switched to gpt-6-sol \(prov-codex, reasoningEffort: high\)\./);
    expect(sentMessage).toContain(`resume_from_checkpoint for BIT-${String(task.number)}`);
    expect(sentMessage).toContain(`New comment on BIT-${String(task.number)} from emre:\n\nOut of budget, continue on Codex.`);

    expect(switched.switchComment?.body).toBe(
      "Model switched from claude-opus-4-7 (prov-claude) to gpt-6-sol (prov-codex, reasoningEffort: high).",
    );
    expect(switched.switchComment?.author).toBe("bitig");
    expect(switched.run).toMatchObject({
      state: "working",
      model: "gpt-6-sol",
      providerInstanceId: "prov-codex",
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
    });
    const comments = await listComments();
    expect(comments.map((c) => [c.authorType, c.body])).toEqual([
      ["agent", "Model switched from claude-opus-4-7 (prov-claude) to gpt-6-sol (prov-codex, reasoningEffort: high)."],
      ["human", "Out of budget, continue on Codex."],
    ]);
    const stored = await env.DB.prepare(
      "SELECT model, provider_instance_id, model_options FROM agent_runs WHERE task_id = ?",
    )
      .bind(task.id)
      .first<{ model: string; provider_instance_id: string; model_options: string }>();
    expect(stored).toEqual({
      model: "gpt-6-sol",
      provider_instance_id: "prov-codex",
      model_options: JSON.stringify([{ id: "reasoningEffort", value: "high" }]),
    });
    const liveRun = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(liveRun.run?.model).toBe("gpt-6-sol");

    // The switch shows in the task's activity through the comments
    const taskAfter = await (await request(`/api/tasks/${task.id}`)).json<Task>();
    expect(taskAfter.updatedBy).toBe("you");

    // Same model again: no switch, the reply is only sent
    mockState.threadStatus = "idle";
    mockState.pendingRequestCount = 0;
    mockState.pendingRequestIds = [];
    mockState.recentRunStatus = "completed";
    mockState.activeRunId = null;
    const configureCalls = (): number =>
      mockState.toolCalls.filter((call) => call.name === "t3_thread_configure" && call.arguments.modelSelection).length;
    const sameRes = await reply(task.id, { body: "One more thing", modelSelection: codexSelection });
    expect(sameRes.status).toBe(201);
    const same = await sameRes.json<{ switchComment?: unknown }>();
    expect(same.switchComment).toBeUndefined();
    expect(configureCalls()).toBe(1);
    expect(String(mockState.toolCalls.filter((call) => call.name === "t3_thread_send").at(-1)?.arguments.message)).toMatch(
      /^New comment on BIT-/,
    );

    // Finished turn: switching again is allowed
    const backRes = await reply(task.id, {
      body: "Back to Claude",
      modelSelection: { providerInstanceId: "prov-claude", model: "claude-opus-4-7" },
    });
    expect(backRes.status).toBe(201);
    expect(configureCalls()).toBe(2);
    const back = await backRes.json<{ run: AgentRun }>();
    expect(back.run.model).toBe("claude-opus-4-7");
    expect(back.run.modelOptions).toBeUndefined();

    // T3 unreachable: a 502 and nothing is saved
    mockState.failMcpConnection = true;
    const commentCount = (await listComments()).length;
    const downRes = await reply(task.id, { body: "Anyone?", modelSelection: codexSelection });
    expect(downRes.status).toBe(502);
    expect(await listComments()).toHaveLength(commentCount);

    // Invalid input is rejected
    mockState.failMcpConnection = false;
    expect((await reply(task.id, { body: "  " })).status).toBe(400);
    expect((await reply(task.id, { body: "x", modelSelection: { model: "gpt-6-sol" } })).status).toBe(400);
  });

  it("attaches CF-Access-Client-Id and CF-Access-Client-Secret headers when configured and surfaces a clear error when Cloudflare Access redirects to login", async () => {
    let requireServiceToken = true;
    const baseMockFetch = createMockT3Fetch(mockState);
    const gatedFetch: typeof fetch = (input, init) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (requireServiceToken) {
        const id = req.headers.get("CF-Access-Client-Id");
        const secret = req.headers.get("CF-Access-Client-Secret");
        if (id !== "cf-test-id.access" || secret !== "cf-test-secret") {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: {
                Location: "https://workouse.cloudflareaccess.com/cdn-cgi/access/login/t3.example.test",
              },
            }),
          );
        }
      }
      return baseMockFetch(input, init);
    };

    // Without Service Token credentials, Cloudflare Access 302 login redirect returns a clear error
    const blockedApp = createApp({ t3Fetch: gatedFetch });
    const blockedRes = await blockedApp.request(
      `${BASE_URL}/api/t3/oauth/start`,
      {
        method: "POST",
        headers: {
          Authorization: TEST_AUTH_HEADER,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mcpUrl: T3_MCP_URL }),
      },
      env,
    );
    expect(blockedRes.status).toBe(502);
    const blockedBody = await blockedRes.json<{ error: string; message: string }>();
    expect(blockedBody.error).toBe("cloudflare_access_blocked");
    expect(blockedBody.message).toContain("Cloudflare Access blocked the request");

    // With T3_CF_ACCESS_CLIENT_ID and T3_CF_ACCESS_CLIENT_SECRET configured, requests succeed
    const authedEnv: Env = {
      ...env,
      T3_CF_ACCESS_CLIENT_ID: "cf-test-id.access",
      T3_CF_ACCESS_CLIENT_SECRET: "cf-test-secret",
    };
    const startRes = await blockedApp.request(
      `${BASE_URL}/api/t3/oauth/start`,
      {
        method: "POST",
        headers: {
          Authorization: TEST_AUTH_HEADER,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ mcpUrl: T3_MCP_URL }),
      },
      authedEnv,
    );
    expect(startRes.status).toBe(200);
    const { state } = await startRes.json<{ authorizationUrl: string; state: string }>();

    const callbackRes = await blockedApp.request(
      `${BASE_URL}/api/t3/oauth/callback?code=auth-code-xyz&state=${encodeURIComponent(state)}`,
      { method: "GET" },
      authedEnv,
    );
    expect(callbackRes.status).toBe(302);

    const projectsRes = await blockedApp.request(
      `${BASE_URL}/api/t3/projects`,
      {
        headers: { Authorization: TEST_AUTH_HEADER },
      },
      authedEnv,
    );
    expect(projectsRes.status).toBe(200);
    const { projects } = await projectsRes.json<{ projects: T3RemoteProject[] }>();
    expect(projects).toHaveLength(1);
    requireServiceToken = false;
  });

  it("lists and reconciles live T3 runs and active project sessions via GET /api/t3/runs (BIT-126)", async () => {
    await connectT3Host();
    const project = await (
      await request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bitig", key: "BIT" }),
      })
    ).json<Project>();
    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t3ProjectId: "t3-proj-bitig", t3ProjectTitle: "Bitig Workspace" }),
    });

    const task = await (
      await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, title: "Active session view" }),
      })
    ).json<Task>();

    await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerInstanceId: "prov-claude", model: "claude-opus-4-7" }),
    });

    // t3_thread_list returns the Bitig task thread as waiting, plus a standalone running thread on the same mapped T3 project
    mockState.threadList = [
      {
        threadId: "thread-abc-123",
        projectId: "t3-proj-bitig",
        title: "BIT-1 Active session view",
        link: `<${T3_ORIGIN}/threads/thread-abc-123>`,
        status: "waiting",
        model: "claude-opus-4-7",
        providerInstanceId: "prov-claude",
        settled: false,
        updatedAt: "2026-11-02T21:40:00Z",
      },
      {
        threadId: "thread-standalone-99",
        projectId: "t3-proj-bitig",
        title: "Ad-hoc refactor in T3",
        link: `${T3_ORIGIN}/threads/thread-standalone-99`,
        status: "running",
        model: "gpt-6-sol",
        providerInstanceId: "prov-codex",
        settled: false,
        updatedAt: "2026-11-02T21:45:00Z",
      },
      {
        threadId: "thread-settled-0",
        projectId: "t3-proj-bitig",
        title: "Finished thread",
        status: "completed",
        settled: true,
        updatedAt: "2026-11-02T20:00:00Z",
      },
    ];

    const runsRes = await request("/api/t3/runs");
    expect(runsRes.status).toBe(200);
    const body = await runsRes.json<T3RunsLiveResponse>();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      taskId: task.id,
      threadId: "thread-abc-123",
      state: "waiting_for_approval",
    });

    expect(body.activeSessions).toHaveLength(2);
    expect(body.activeSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: project.id,
          t3ProjectId: "t3-proj-bitig",
          threadId: "thread-abc-123",
          taskId: task.id,
          state: "waiting_for_approval",
          model: "claude-opus-4-7",
        }),
        expect.objectContaining({
          projectId: project.id,
          t3ProjectId: "t3-proj-bitig",
          threadId: "thread-standalone-99",
          title: "Ad-hoc refactor in T3",
          state: "working",
          model: "gpt-6-sol",
        }),
      ]),
    );
  });
  it("starts, lists, and messages project-level T3 threads without a task (BIT-127)", async () => {
    const createProject = async (name: string, key: string): Promise<Project> =>
      (
        await request("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, key }),
        })
      ).json<Project>();
    const mapProject = (projectId: string): Promise<Response> =>
      request(`/api/t3/mappings/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ t3ProjectId: "t3-proj-bitig", t3ProjectTitle: "Bitig Workspace" }),
      });
    const startThread = (projectId: string, payload: Record<string, unknown>): Promise<Response> =>
      request(`/api/t3/projects/${projectId}/threads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    const sendMessage = (projectId: string, threadId: string, payload: Record<string, unknown>): Promise<Response> =>
      request(`/api/t3/projects/${projectId}/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

    const project = await createProject("Bitig", "BIT");
    const other = await createProject("Other", "OTH");

    // Not connected yet: refused before T3 is called
    await mapProject(project.id);
    expect((await startThread(project.id, { prompt: "Check node" })).status).toBe(400);
    await connectT3Host();

    // Unknown project, invalid input, and an unmapped project are refused
    expect((await startThread("01a14ecf-281e-7436-8c52-a524c5fabc99", { prompt: "x" })).status).toBe(404);
    expect((await startThread(project.id, { prompt: "   " })).status).toBe(400);
    const unmappedRes = await startThread(other.id, { prompt: "Check node" });
    expect(unmappedRes.status).toBe(400);
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_launch")).toBe(false);

    // Happy path: root workspace by default, model and options passed to T3
    mockState.launchThreadId = "thread-proj-1";
    const startRes = await startThread(project.id, {
      prompt: "Check the node version\nand pnpm too",
      modelSelection: {
        providerInstanceId: "prov-claude",
        model: "claude-opus-4-7",
        options: [{ id: "effort", value: "high" }],
      },
    });
    expect(startRes.status).toBe(201);
    const thread = await startRes.json<ProjectT3Thread>();
    expect(thread).toMatchObject({
      projectId: project.id,
      t3ProjectId: "t3-proj-bitig",
      threadId: "thread-proj-1",
      title: "Check the node version",
      state: "working",
      workspaceStrategy: "root",
      model: "claude-opus-4-7",
      providerInstanceId: "prov-claude",
      modelOptions: [{ id: "effort", value: "high" }],
    });
    const launchCall = mockState.toolCalls.find((c) => c.name === "t3_thread_launch");
    expect(launchCall?.arguments).toMatchObject({
      projectId: "t3-proj-bitig",
      title: "Check the node version",
      clientRequestId: thread.id,
      modelSelection: { instanceId: "prov-claude", model: "claude-opus-4-7", options: [{ id: "effort", value: "high" }] },
    });
    expect(launchCall?.arguments.workspaceStrategy).toBeUndefined();
    expect(String(launchCall?.arguments.message)).toContain("There is no Bitig task");
    expect(String(launchCall?.arguments.message)).toContain("Check the node version\nand pnpm too");

    // Worktree is still selectable
    mockState.launchThreadId = "thread-proj-2";
    const worktreeRes = await startThread(project.id, { prompt: "Try a branch", workspaceStrategy: "worktree" });
    expect(worktreeRes.status).toBe(201);
    expect((await worktreeRes.json<ProjectT3Thread>()).workspaceStrategy).toBe("worktree");

    // Listing reconciles state with t3_thread_list, newest first
    mockState.threadList = [
      { threadId: "thread-proj-1", projectId: "t3-proj-bitig", status: "waiting", settled: false },
      { threadId: "thread-proj-2", projectId: "t3-proj-bitig", status: "completed", settled: true },
    ];
    const listRes = await request(`/api/t3/projects/${project.id}/threads`);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json<ProjectT3ThreadsResponse>();
    expect(listed.threads.map((t) => [t.threadId, t.state])).toEqual([
      ["thread-proj-2", "finished"],
      ["thread-proj-1", "waiting_for_approval"],
    ]);
    expect((await (await request(`/api/t3/projects/${other.id}/threads`)).json<ProjectT3ThreadsResponse>()).threads).toEqual([]);

    // Project threads show up as active sessions with their stored title
    const runs = await (await request("/api/t3/runs")).json<T3RunsLiveResponse>();
    expect(runs.activeSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ threadId: "thread-proj-1", projectId: project.id, title: "Check the node version" }),
      ]),
    );

    // Messages only reach threads recorded for that project
    expect((await sendMessage(project.id, "thread-unknown", { body: "hi" })).status).toBe(404);
    expect((await sendMessage(other.id, "thread-proj-1", { body: "hi" })).status).toBe(404);
    expect((await sendMessage(project.id, "thread-proj-1", { body: "" })).status).toBe(400);
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_send")).toBe(false);

    // A plain follow-up goes to the thread as-is
    const followRes = await sendMessage(project.id, "thread-proj-1", { body: "  Now check wrangler  " });
    expect(followRes.status).toBe(201);
    expect((await followRes.json<ProjectT3Thread>()).state).toBe("working");
    const sendCall = mockState.toolCalls.filter((c) => c.name === "t3_thread_send").at(-1);
    expect(sendCall?.arguments).toMatchObject({ threadId: "thread-proj-1", message: "Now check wrangler" });

    // A model switch is refused mid-turn and nothing is sent
    const codexSelection = { providerInstanceId: "prov-codex", model: "gpt-6-sol" };
    mockState.threadStatus = "running";
    mockState.activeRunId = "run-1";
    const sendsBefore = mockState.toolCalls.filter((c) => c.name === "t3_thread_send").length;
    const busyRes = await sendMessage(project.id, "thread-proj-1", { body: "switch", modelSelection: codexSelection });
    expect(busyRes.status).toBe(409);
    expect(await busyRes.json()).toMatchObject({ error: "thread_busy", state: "working" });
    expect(mockState.toolCalls.filter((c) => c.name === "t3_thread_send")).toHaveLength(sendsBefore);

    // Once the turn ends, the model switches and the follow-up carries the notice
    mockState.threadStatus = "completed";
    mockState.activeRunId = null;
    mockState.recentRunStatus = "completed";
    const switchRes = await sendMessage(project.id, "thread-proj-1", { body: "switch", modelSelection: codexSelection });
    expect(switchRes.status).toBe(201);
    expect(await switchRes.json<ProjectT3Thread>()).toMatchObject({
      model: "gpt-6-sol",
      providerInstanceId: "prov-codex",
      state: "working",
    });
    const configureCall = mockState.toolCalls.filter((c) => c.name === "t3_thread_configure").at(-1);
    expect(configureCall?.arguments).toMatchObject({
      threadId: "thread-proj-1",
      modelSelection: { instanceId: "prov-codex", model: "gpt-6-sol" },
    });
    const switchSend = mockState.toolCalls.filter((c) => c.name === "t3_thread_send").at(-1);
    expect(String(switchSend?.arguments.message)).toMatch(/^The thread switched to gpt-6-sol \(prov-codex\)\./);
    expect(String(switchSend?.arguments.message)).not.toContain("resume_from_checkpoint");

    // Archived projects cannot start new threads
    await request(`/api/projects/${project.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived: true }),
    });
    expect((await startThread(project.id, { prompt: "Check node" })).status).toBe(400);

    // When T3 is unreachable, active threads are listed as offline
    mockState.failMcpConnection = true;
    const offline = await (await request(`/api/t3/projects/${project.id}/threads`)).json<ProjectT3ThreadsResponse>();
    expect(offline.threads.find((t) => t.threadId === "thread-proj-1")?.state).toBe("offline");
    expect(offline.threads.find((t) => t.threadId === "thread-proj-2")?.state).toBe("finished");
  });

  it("reads project-level T3 thread messages with paging and project scoping (BIT-131)", async () => {
    await connectT3Host();
    const createProject = async (name: string, key: string): Promise<Project> =>
      (
        await request("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, key }),
        })
      ).json<Project>();

    const project = await createProject("Bitig", "BIT");
    const other = await createProject("Other", "OTH");
    await request(`/api/t3/mappings/${project.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t3ProjectId: "t3-proj-bitig", t3ProjectTitle: "Bitig Workspace" }),
    });

    mockState.launchThreadId = "thread-msg-1";
    await request(`/api/t3/projects/${project.id}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Check node" }),
    });

    // Unknown project, unknown thread, or another project's thread -> 404
    expect((await request("/api/t3/projects/01a14ecf-281e-7436-8c52-a524c5fabc99/threads/thread-msg-1/messages")).status).toBe(404);
    expect((await request(`/api/t3/projects/${project.id}/threads/thread-unknown/messages`)).status).toBe(404);
    expect((await request(`/api/t3/projects/${other.id}/threads/thread-msg-1/messages`)).status).toBe(404);

    // Invalid after parameter -> 400
    expect((await request(`/api/t3/projects/${project.id}/threads/thread-msg-1/messages?after=-1`)).status).toBe(400);
    expect((await request(`/api/t3/projects/${project.id}/threads/thread-msg-1/messages?after=abc`)).status).toBe(400);

    // Happy path: filters out non-message and malformed items, keeps user and assistant messages, reconciles state
    mockState.threadStatus = "completed";
    mockState.activeRunId = null;
    mockState.recentRunStatus = "completed";
    mockState.threadItems = [
      {
        position: 0,
        type: "user_message",
        text: "Check node",
        textTruncated: false,
        status: "completed",
        updatedAt: "2026-11-03T10:00:00.000Z",
      },
      {
        position: 2,
        type: "dynamic_tool",
        text: "ignored tool call",
      },
      {
        position: -5,
        type: "assistant_message",
        text: "invalid position",
      },
      null,
      {
        position: 5,
        type: "assistant_message",
        text: "Node v22.11.0 is installed.",
        textTruncated: true,
        status: "completed",
        updatedAt: "2026-11-03T10:00:05.000Z",
      },
    ];

    const firstRes = await request(`/api/t3/projects/${project.id}/threads/thread-msg-1/messages`);
    expect(firstRes.status).toBe(200);
    const firstBody = await firstRes.json<ProjectT3ThreadMessagesResponse>();
    expect(firstBody.thread.state).toBe("finished");
    expect(firstBody.messages).toEqual([
      {
        position: 0,
        role: "user",
        text: "Check node",
        truncated: false,
        status: "completed",
        updatedAt: "2026-11-03T10:00:00.000Z",
      },
      {
        position: 5,
        role: "assistant",
        text: "Node v22.11.0 is installed.",
        truncated: true,
        status: "completed",
        updatedAt: "2026-11-03T10:00:05.000Z",
      },
    ]);
    expect(firstBody.nextPosition).toBe(5);
    expect(firstBody.hasMore).toBe(false);

    // Paging with ?after=0 returns only messages with position > 0
    const afterRes = await request(`/api/t3/projects/${project.id}/threads/thread-msg-1/messages?after=0`);
    expect(afterRes.status).toBe(200);
    const afterBody = await afterRes.json<ProjectT3ThreadMessagesResponse>();
    expect(afterBody.messages.map((m) => m.position)).toEqual([5]);
    const readCall = mockState.toolCalls.filter((c) => c.name === "t3_thread_read").at(-1);
    expect(readCall?.arguments).toMatchObject({
      threadId: "thread-msg-1",
      view: "messages",
      afterPosition: 0,
      limit: 100,
      maxCharsPerItem: 20_000,
    });
  });
});

