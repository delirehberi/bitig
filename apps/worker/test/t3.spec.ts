import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  AgentRun,
  Project,
  T3ConnectionStatus,
  T3ModelCapability,
  T3ProjectMapping,
  T3RemoteProject,
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
    \`workspace_strategy\` text,
    \`started_by\` text,
    \`started_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `agent_runs_task_id_idx` ON `agent_runs` (`task_id`)",
  "CREATE INDEX `agent_runs_thread_id_idx` ON `agent_runs` (`thread_id`)",
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
                targets: [
                  {
                    providerInstanceId: "prov-claude",
                    driverKind: "claude",
                    displayName: "Claude Code",
                    models: [{ model: "claude-opus-4-7", label: "Claude Opus 4.7" }],
                  },
                ],
              };
            } else if (toolName === "t3_thread_launch") {
              payload = {
                threadId: "thread-abc-123",
                link: `${T3_ORIGIN}/threads/thread-abc-123`,
              };
            } else if (toolName === "t3_thread_read") {
              payload = {
                thread: {
                  id: "thread-abc-123",
                  status: state.threadStatus,
                  pendingRequestCount: state.pendingRequestCount,
                },
                recentRuns: [{ status: state.recentRunStatus }],
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
      },
    ]);

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
      modelSelection: { providerInstanceId: "prov-claude", model: "claude-opus-4-7" },
    });
  });

  it("checks live T3 thread status without auto-transitioning task status, and supports message, respond, and stop", async () => {
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

    // Send a follow-up message
    const msgRes = await request(`/api/tasks/${task.id}/t3-run/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Please also update docs/security.md" }),
    });
    expect(msgRes.status).toBe(200);
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_send")).toBe(true);

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
});
