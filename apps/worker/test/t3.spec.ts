import { env } from "cloudflare:workers";
import { Hono } from "hono";
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
import { createApp, type AppEnv } from "../src/index";
import { mcpRouter } from "../src/routes/mcp";
import { parseConfig } from "../src/config";
import { D1AccessTokenStore, D1OrganisationStore, D1Storage, D1UserStore, T3D1Store } from "@bitig/storage-d1";
import { sha256Hex } from "../src/auth-crypto";
import { reportTaskT3GitMetadata } from "../src/t3/service";
import { DEFAULT_ORGANISATION_ID, defaultIdGenerator, InMemoryStorage, type OrganisationRole } from "@bitig/core";
import { decryptT3Token, encryptT3Token } from "../src/t3/crypto";
import { parseThreadGitMetadata, parseWorktreeCurrentBranch, resolveT3OAuthScope } from "../src/t3/client";
import { TEST_AUTH_HEADER, TEST_MCP_AUTH_HEADER, TEST_T3_ENCRYPTION_KEY } from "./constants";

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
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
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
    \`author_id\` text,
    \`author_avatar_url\` text,
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
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
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
  "CREATE UNIQUE INDEX `t3_connections_org_id_unique` ON `t3_connections` (`org_id`)",
  `CREATE TABLE \`t3_oauth_states\` (
    \`state\` text PRIMARY KEY NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
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
    \`branch\` text,
    \`head_sha\` text,
    \`diff_stat\` text,
    \`pull_request_urls\` text,
    \`workspace_strategy\` text,
    \`parent_task_id\` text,
    \`waiting_for_task_id\` text,
    \`started_by\` text,
    \`started_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `agent_runs_task_id_idx` ON `agent_runs` (`task_id`)",
  "CREATE INDEX `agent_runs_thread_id_idx` ON `agent_runs` (`thread_id`)",
  "CREATE INDEX `agent_runs_waiting_for_task_id_idx` ON `agent_runs` (`waiting_for_task_id`)",
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
  gitMetadata?: Record<string, unknown>;
  worktreeRefs?: Record<string, unknown>[];
  toolErrors?: Record<string, string>;
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
  /**
   * Registered T3 projects for host folder tests (#BIT-148). When set, `t3_project_list` pages
   * through them (`limit`/`cursor`), `t3_project_create` appends and `t3_project_delete` removes.
   */
  remoteProjects?: { id: string; title: string; workspaceRoot: string }[];
  /** `scopes_supported` in the protected-resource metadata; defaults to `["mcp:tools"]`. */
  resourceScopes?: unknown;
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
          scopes_supported: state.resourceScopes ?? ["mcp:tools"],
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
            const toolError = state.toolErrors?.[toolName];
            if (toolError) {
              return Response.json({
                jsonrpc: "2.0", id: body.id,
                result: { isError: true, content: [{ type: "text", text: toolError }] },
              }, { headers });
            }

            let payload: Record<string, unknown> = {};
            const remoteProjects = state.remoteProjects;
            if (toolName === "t3_project_list" && remoteProjects) {
              const limit = typeof toolArgs.limit === "number" ? toolArgs.limit : 50;
              const cursor = typeof toolArgs.cursor === "number" ? toolArgs.cursor : 0;
              const next = cursor + limit;
              payload = {
                projects: remoteProjects.slice(cursor, next),
                nextCursor: next < remoteProjects.length ? next : null,
              };
            } else if (toolName === "t3_project_create" && remoteProjects) {
              const created = {
                id: `t3-proj-${String(remoteProjects.length + 1)}`,
                title: String(toolArgs.title),
                workspaceRoot: String(toolArgs.workspaceRoot),
              };
              remoteProjects.push(created);
              payload = { project: created };
            } else if (toolName === "t3_project_delete" && remoteProjects) {
              const index = remoteProjects.findIndex((project) => project.id === toolArgs.projectId);
              if (index >= 0) remoteProjects.splice(index, 1);
              payload = { ok: true };
            } else if (toolName === "t3_project_list") {
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
              const viewFiltered =
                toolArgs.view === "messages"
                  ? rawItems.filter((item) => {
                      if (!item || typeof item !== "object") return true;
                      const itemType = (item as Record<string, unknown>).type;
                      return itemType !== "error" && itemType !== "system_notice";
                    })
                  : rawItems;
              const afterPos =
                typeof toolArgs.afterPosition === "number" ? toolArgs.afterPosition : undefined;
              const filteredItems =
                afterPos === undefined
                  ? viewFiltered
                  : viewFiltered.filter((item) => {
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
                  ...state.gitMetadata,
                  id: "thread-abc-123",
                  status: state.threadStatus,
                  pendingRequestCount: state.pendingRequestCount,
                  activeRunId: state.activeRunId,
                  itemCount: rawItems.length,
                },
                recentRuns: [{ status: state.recentRunStatus }],
                items: filteredItems,
                nextPosition: lastPos,
                hasMore: state.threadHasMore ?? false,
              };
            } else if (toolName === "t3_worktree_list") {
              payload = {
                refs: state.worktreeRefs ?? [],
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

  it("refuses Git metadata reports from a viewer before writing the run store", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Viewer" });
    const task = await storage.saveTask({ projectId: project.id, title: "Viewer run" });
    const viewerApp = new Hono<AppEnv>();
    viewerApp.use("*", async (c, next) => {
      c.set("storage", storage);
      c.set("orgRole", "viewer");
      c.set("config", parseConfig(env));
      await next();
    });
    viewerApp.route("/mcp", mcpRouter);
    const response = await viewerApp.request(`${BASE_URL}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_t3_git_metadata", arguments: { taskId: task.id, runId: defaultIdGenerator(), threadId: "thread-1", metadata: { branch: "forbidden" } } } }),
    }, env);
    expect(await response.text()).toContain("editor role required");
    expect(await new T3D1Store(env.DB).getAgentRunByTaskId(task.id)).toBeUndefined();
  });

  it("parses documented host metadata and current worktree branch without treating invalid or missing values as empty", () => {
    const url = "https://github.com/example/repo/pull/1";
    expect(parseThreadGitMetadata(null)).toEqual({});
    expect(parseThreadGitMetadata({})).toEqual({});
    expect(parseThreadGitMetadata({ branch: null, pullRequests: [] })).toEqual({ branch: null, pullRequestUrls: [] });
    expect(parseThreadGitMetadata({ branch: "feature", pullRequests: [{ url }, { url }] })).toEqual({ branch: "feature", pullRequestUrls: [url] });
    expect(parseThreadGitMetadata({ linkedPullRequest: { url } })).toEqual({ pullRequestUrls: [url] });
    expect(parseThreadGitMetadata({ branch: 2, pullRequests: [{ url: "javascript:alert(1)" }] })).toEqual({});
    expect(parseThreadGitMetadata({ pullRequests: [null] })).toEqual({});
    expect(parseThreadGitMetadata({ pullRequests: null, linkedPullRequest: null })).toEqual({});
    expect(parseWorktreeCurrentBranch(null)).toBeUndefined();
    expect(parseWorktreeCurrentBranch({ refs: [{ name: "origin/master", current: true, isRemote: true }, { name: "master", current: true, isRemote: false }] })).toBe("master");
    expect(parseWorktreeCurrentBranch({ refs: [{ name: "feature", current: false, isRemote: false }] })).toBeUndefined();
  });

  it("reports metadata through authenticated MCP (with or without runId) and refreshes branch/PRs including root-checkout worktree fallback", async () => {
    await connectT3Host();
    const project = await (await request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Git metadata", key: "GIT" }) })).json<Project>();
    const task = await (await request("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, title: "Git metadata" }) })).json<Task>();
    const store = new T3D1Store(env.DB);
    const run = await store.saveAgentRun({ id: defaultIdGenerator(), taskId: task.id, t3ProjectId: "t3-project", threadId: "thread-abc-123", state: "working", startedAt: Date.now(), updatedAt: Date.now() });
    const metadata = { branch: "feature/bit-162", headSha: "a".repeat(40), diffStat: { filesChanged: 2, insertions: 5, deletions: 1 }, pullRequestUrls: ["https://github.com/example/repo/pull/1"] };
    async function report(overrides: Record<string, unknown> = {}) {
      const response = await app.request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: TEST_MCP_AUTH_HEADER, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "report_t3_git_metadata", arguments: { taskId: task.id, runId: run.id, threadId: run.threadId, metadata, ...overrides } } }),
      }, env);
      expect(response.status).toBe(200);
      const raw = await response.text();
      const line = raw.split("\n").find((item) => item.startsWith("data: "));
      return JSON.parse(line ? line.slice(6) : raw) as { result?: { isError?: boolean }; error?: unknown };
    }
    expect((await report()).result?.isError).not.toBe(true);
    expect(await store.getAgentRunByTaskId(task.id)).toMatchObject(metadata);
    // A follow-up 0/0/0 diffStat report on a later turn preserves the non-zero diffStat from earlier in the run
    expect((await report({ metadata: { diffStat: { filesChanged: 0, insertions: 0, deletions: 0 } } })).result?.isError).not.toBe(true);
    expect(await store.getAgentRunByTaskId(task.id)).toMatchObject(metadata);
    // Reporting without runId still matches taskId + threadId (supports pre-existing threads)
    expect((await report({ runId: undefined, metadata: { branch: "feature/no-run-id" } })).result?.isError).not.toBe(true);
    expect((await store.getAgentRunByTaskId(task.id))?.branch).toBe("feature/no-run-id");
    await expect(reportTaskT3GitMetadata({ store, storage: new D1Storage({ db: env.DB, orgId: defaultIdGenerator() }), encryptionKey: TEST_T3_ENCRYPTION_KEY }, { taskId: task.id, runId: run.id, threadId: run.threadId, metadata: { branch: "foreign" } })).rejects.toThrow();
    expect((await store.getAgentRunByTaskId(task.id))?.branch).toBe("feature/no-run-id");
    expect((await report({ threadId: "stale" })).result?.isError).toBe(true);
    expect((await report({ runId: defaultIdGenerator() })).result?.isError).toBe(true);
    expect((await report({ taskId: defaultIdGenerator() })).result?.isError).toBe(true);
    const invalid = await report({ metadata: { pullRequestUrls: ["javascript:alert(1)"] } });
    expect(Boolean(invalid.error) || invalid.result?.isError).toBe(true);
    mockState.gitMetadata = { branch: "renamed", pullRequests: [{ url: "https://github.com/example/repo/pull/2" }] };
    const live = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(live.run).toMatchObject({ ...metadata, branch: "renamed", pullRequestUrls: ["https://github.com/example/repo/pull/2"], state: "working" });
    expect(await store.getAgentRunByTaskId(task.id)).toEqual(live.run);
    // When t3_thread_read returns branch: null (e.g. root checkout), t3_worktree_list resolves the checked-out branch
    mockState.gitMetadata = { branch: null, pullRequests: [] };
    mockState.worktreeRefs = [{ name: "master", current: true, isRemote: false }];
    const rootBranchLive = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(rootBranchLive.run?.branch).toBe("master");
    expect(rootBranchLive.run?.pullRequestUrls).toEqual([]);
    mockState.worktreeRefs = [];
    mockState.gitMetadata = {};
    const missing = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(missing.run).toEqual(rootBranchLive.run);
    mockState.gitMetadata = { branch: null, pullRequests: [] };
    const cleared = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(cleared.run?.branch).toBeUndefined();
    expect(cleared.run?.pullRequestUrls).toEqual([]);
    mockState.failMcpConnection = true;
    const offline = await (await request(`/api/tasks/${task.id}/t3-run`)).json<T3TaskRunLiveResponse>();
    expect(offline.run).toMatchObject({ state: "offline", headSha: metadata.headSha, diffStat: metadata.diffStat });
  });

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

  it("starts a fresh checkpoint-seeded T3 thread and settles the prior thread when freshSession is true (BIT-165)", async () => {
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
        body: JSON.stringify({
          projectId: project.id,
          title: "Long-running migration",
          description: "Migrate worker endpoints",
        }),
      })
    ).json<Task>();

    function reply(taskId: string, payload: Record<string, unknown>): Promise<Response> {
      return request(`/api/tasks/${taskId}/t3-run/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Bitig-Actor": "emre" },
        body: JSON.stringify(payload),
      });
    }

    mockState.launchThreadId = "thread-initial-1";
    const initialLaunchRes = await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceStrategy: "worktree",
        providerInstanceId: "prov-claude",
        model: "claude-opus-4-7",
      }),
    });
    expect(initialLaunchRes.status).toBe(201);
    const initialLaunched = await initialLaunchRes.json<{ run: AgentRun }>();

    // Save a checkpoint and Git metadata from the prior session
    const storage = new D1Storage({ db: env.DB, orgId: DEFAULT_ORGANISATION_ID });
    await storage.saveCheckpoint({
      taskId: task.id,
      stepIndex: 1,
      status: "COMPLETED",
      stateSnapshot: {
        summary: "Completed schema and storage changes.",
        modifiedArtifacts: ["packages/core/src/domain/t3.ts"],
        decisionsMade: ["Used exactOptional boolean flag"],
        nextStepInstructions: "Wire worker reply endpoint and UI toggle.",
      },
    });
    const store = new T3D1Store(env.DB);
    const fullSha = "1234567890abcdef1234567890abcdef12345678";
    await store.updateAgentRunGitMetadata(
      task.id,
      initialLaunched.run.id,
      "thread-initial-1",
      {
        branch: "feat/bit-165",
        headSha: fullSha,
        diffStat: { filesChanged: 2, insertions: 48, deletions: 4 },
      },
      Date.now(),
    );

    // Mid-turn: freshSession is refused with 409 before saving comments or settling the thread
    mockState.threadStatus = "running";
    mockState.recentRunStatus = "running";
    mockState.activeRunId = "run-busy";
    const busyRes = await reply(task.id, {
      body: "Start fresh while busy",
      freshSession: true,
    });
    expect(busyRes.status).toBe(409);
    expect(await busyRes.json<{ error: string; state: string }>()).toMatchObject({
      error: "thread_busy",
      state: "working",
    });
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_organize")).toBe(false);
    expect(mockState.toolCalls.filter((c) => c.name === "t3_thread_launch")).toHaveLength(1);

    // Finished turn: freshSession settles the old thread and launches a new checkpoint-seeded thread
    mockState.threadStatus = "idle";
    mockState.recentRunStatus = "completed";
    mockState.activeRunId = null;
    mockState.launchThreadId = "thread-fresh-2";

    const codexSelection = {
      providerInstanceId: "prov-codex",
      model: "gpt-6-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    const freshRes = await reply(task.id, {
      body: "Now add the UI checkbox and run tests.",
      author: "emre",
      freshSession: true,
      modelSelection: codexSelection,
    });
    expect(freshRes.status).toBe(201);
    const freshBody = await freshRes.json<{
      comment: { body: string };
      switchComment?: { body: string };
      run: AgentRun;
    }>();

    // 1. Old thread was settled via t3_thread_organize action: "settle", and t3_thread_send was NOT called
    const settleCalls = mockState.toolCalls.filter((c) => c.name === "t3_thread_organize");
    expect(settleCalls).toHaveLength(1);
    expect(settleCalls[0]?.arguments).toEqual({
      action: "settle",
      threadId: "thread-initial-1",
    });
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_send")).toBe(false);

    // 2. New thread was launched with checkpoint, prior Git state, and follow-up comment in its prompt
    const launchCalls = mockState.toolCalls.filter((c) => c.name === "t3_thread_launch");
    expect(launchCalls).toHaveLength(2);
    const freshLaunchArgs = launchCalls[1]?.arguments;
    expect(freshLaunchArgs).toMatchObject({
      projectId: "t3-proj-bitig",
      title: `BIT-${String(task.number)} Long-running migration`,
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      modelSelection: {
        instanceId: "prov-codex",
        model: "gpt-6-sol",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    const freshPrompt = String(freshLaunchArgs?.message);
    expect(freshPrompt).toContain("## Latest Checkpoint (from prior session)");
    expect(freshPrompt).toContain("Completed schema and storage changes.");
    expect(freshPrompt).toContain("packages/core/src/domain/t3.ts");
    expect(freshPrompt).toContain("- **Prior Git State:** branch `feat/bit-165` · commit `1234567` · 2 files changed (+48 / -4)");
    expect(freshPrompt).toContain("## Follow-Up Instruction (Fresh T3 Session)");
    expect(freshPrompt).toContain("Follow this instruction from **emre**:\n\nNow add the UI checkbox and run tests.");
    expect(freshPrompt).toContain(`runId "${freshBody.run.id}"`);

    // 3. agent_runs points to the new threadId and model selection, with fresh Git metadata reset
    expect(freshBody.run).toMatchObject({
      taskId: task.id,
      threadId: "thread-fresh-2",
      state: "working",
      model: "gpt-6-sol",
      providerInstanceId: "prov-codex",
      modelOptions: [{ id: "reasoningEffort", value: "high" }],
      workspaceStrategy: "worktree",
      startedBy: "emre",
    });
    expect(freshBody.run.id).not.toBe(initialLaunched.run.id);
    expect(freshBody.run.branch).toBeUndefined();
    expect(freshBody.switchComment?.body).toBe(
      "Model switched from claude-opus-4-7 (prov-claude) to gpt-6-sol (prov-codex, reasoningEffort: high).",
    );
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
  async function setupProjectSettlement(): Promise<{ project: Project; store: T3D1Store }> {
    const response = await request("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Settlement", key: "SET" }),
    });
    const project = await response.json<Project>();
    const store = new T3D1Store(env.DB);
    const now = Date.now();
    await store.saveProjectThread({
      id: defaultIdGenerator(), projectId: project.id, t3ProjectId: "t3-proj-bitig",
      threadId: "settle-thread", title: "Settle me", state: "finished",
      workspaceStrategy: "root", startedAt: now, updatedAt: now,
    });
    await connectT3Host();
    return { project, store };
  }

  it.each(["running", "waiting", "idle"])("settles a %s project thread using live state (BIT-142)", async (status) => {
    const { project, store } = await setupProjectSettlement();
    mockState.threadStatus = status;
    mockState.recentRunStatus = status === "idle" ? "completed" : "running";
    mockState.pendingRequestCount = status === "waiting" ? 1 : 0;
    const response = await request(`/api/t3/projects/${project.id}/threads/settle-thread/settle`, { method: "POST" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    const actions = mockState.toolCalls.filter((call) =>
      call.name === "t3_thread_interrupt" || call.name === "t3_thread_organize");
    expect(actions).toEqual([
      ...(status === "idle" ? [] : [{ name: "t3_thread_interrupt", arguments: { threadId: "settle-thread", stop: true } }]),
      { name: "t3_thread_organize", arguments: { action: "settle", threadId: "settle-thread" } },
    ]);
    expect(await store.getProjectThread(project.id, "settle-thread")).toBeUndefined();
    const listed = await request(`/api/t3/projects/${project.id}/threads`);
    expect(await listed.json()).toEqual({ threads: [] });
  });

  it("rejects missing and other-project threads before contacting T3 (BIT-142)", async () => {
    const { project, store } = await setupProjectSettlement();
    const otherResponse = await request("/api/projects", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Other", key: "OTH" }),
    });
    const other = await otherResponse.json<Project>();
    mockState.toolCalls = [];
    for (const [projectId, threadId] of [
      [project.id, "missing"], [other.id, "settle-thread"], [defaultIdGenerator(), "settle-thread"],
    ] as const) {
      const response = await request(`/api/t3/projects/${projectId}/threads/${threadId}/settle`, { method: "POST" });
      expect(response.status).toBe(404);
    }
    expect(mockState.toolCalls).toEqual([]);
    expect(await store.getProjectThread(project.id, "settle-thread")).toBeDefined();
  });

  it.each(["Thread is not running", "No active run"])("settles after a benign interruption race: %s", async (message) => {
    const { project } = await setupProjectSettlement();
    mockState.toolErrors = { t3_thread_interrupt: message };
    expect((await request(`/api/t3/projects/${project.id}/threads/settle-thread/settle`, { method: "POST" })).status).toBe(204);
    expect(mockState.toolCalls.some((call) => call.name === "t3_thread_organize")).toBe(true);
  });

  it.each(["t3_thread_read", "t3_thread_interrupt", "t3_thread_organize"])("preserves the project thread when %s fails", async (toolName) => {
    const { project, store } = await setupProjectSettlement();
    mockState.toolErrors = { [toolName]: "Permission denied" };
    const response = await request(`/api/t3/projects/${project.id}/threads/settle-thread/settle`, { method: "POST" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "tool_error", message: "Permission denied" });
    expect(await store.getProjectThread(project.id, "settle-thread")).toBeDefined();
    if (toolName !== "t3_thread_organize") {
      expect(mockState.toolCalls.some((call) => call.name === "t3_thread_organize")).toBe(false);
    }
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

  it("surfaces stopReason from T3 activity error and system_notice items when a task run or project thread fails (#BIT-132)", async () => {
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
      body: JSON.stringify({
        t3ProjectId: "t3-proj-bitig",
        t3ProjectTitle: "Bitig Workspace",
      }),
    });

    const task = await (
      await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, title: "Implement BIT-132" }),
      })
    ).json<Task>();
    mockState.launchThreadId = "thread-fail-task";
    const startTaskRes = await request(`/api/tasks/${task.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceStrategy: "worktree" }),
    });
    expect(startTaskRes.status).toBe(201);

    mockState.launchThreadId = "thread-fail-proj";
    const startProjRes = await request(`/api/t3/projects/${project.id}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Run check" }),
    });
    expect(startProjRes.status).toBe(201);

    // Simulate Claude 5-hour usage limit failure on the latest turn
    mockState.threadStatus = "failed";
    mockState.activeRunId = null;
    mockState.recentRunStatus = "failed";
    mockState.threadItems = [
      {
        position: 0,
        type: "user_message",
        text: "Run check",
      },
      {
        position: 1,
        type: "system_notice",
        title: "Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h 29m.",
      },
      {
        position: 2,
        type: "error",
        title: "Usage limit reached",
        text: "Claude API rate limit reached. Try again later.",
      },
    ];
    mockState.threadList = [
      {
        threadId: "thread-fail-proj",
        projectId: "t3-proj-bitig",
        status: "failed",
        pendingRequestCount: 0,
        activeRunId: null,
        settled: false,
      },
    ];

    const expectedReason =
      "Usage limit reached: Claude API rate limit reached. Try again later. \u2014 Claude usage limit reached. This turn is paused until the 5-hour limit resets in 2h 29m.";

    const taskLiveRes = await request(`/api/tasks/${task.id}/t3-run`);
    expect(taskLiveRes.status).toBe(200);
    const taskLiveBody = await taskLiveRes.json<T3TaskRunLiveResponse>();
    expect(taskLiveBody.run?.state).toBe("failed");
    expect(taskLiveBody.stopReason).toBe(expectedReason);

    const listProjRes = await request(`/api/t3/projects/${project.id}/threads`);
    expect(listProjRes.status).toBe(200);
    const listProjBody = await listProjRes.json<ProjectT3ThreadsResponse>();
    expect(listProjBody.threads[0]?.state).toBe("failed");
    expect(listProjBody.threads[0]?.stopReason).toBe(expectedReason);

    const msgProjRes = await request(`/api/t3/projects/${project.id}/threads/thread-fail-proj/messages`);
    expect(msgProjRes.status).toBe(200);
    const msgProjBody = await msgProjRes.json<ProjectT3ThreadMessagesResponse>();
    expect(msgProjBody.thread.state).toBe("failed");
    expect(msgProjBody.thread.stopReason).toBe(expectedReason);
    expect(msgProjBody.stopReason).toBe(expectedReason);
  });

  it("refuses a root-checkout launch while another task's root session is active in the same T3 project (#BIT-134)", async () => {
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
    function launch(taskId: string, workspaceStrategy: "root" | "worktree"): Promise<Response> {
      return request(`/api/tasks/${taskId}/t3-run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceStrategy }),
      });
    }
    async function storedRunState(taskId: string): Promise<string | null> {
      return env.DB.prepare("SELECT state FROM agent_runs WHERE task_id = ?").bind(taskId).first<string>("state");
    }
    const launchCount = (): number => mockState.toolCalls.filter((c) => c.name === "t3_thread_launch").length;

    const rootTask = await createTask("Edits the root checkout");
    const secondRootTask = await createTask("Also wants the root checkout");
    const isolatedTask = await createTask("Runs in its own worktree");

    // 1. The first root launch has nothing to collide with, so T3 is not even asked for its threads.
    mockState.launchThreadId = "thread-root-1";
    expect((await launch(rootTask.id, "root")).status).toBe(201);
    expect(mockState.toolCalls.some((c) => c.name === "t3_thread_list")).toBe(false);

    // 2. A second root launch is refused while T3 reports the first thread as running.
    mockState.threadList = [
      { threadId: "thread-root-1", projectId: "t3-proj-bitig", status: "running", activeRunId: "run-1" },
    ];
    const launchesBefore = launchCount();
    const busyRes = await launch(secondRootTask.id, "root");
    expect(busyRes.status).toBe(409);
    const busyBody = await busyRes.json<{
      error: string;
      message: string;
      session: { threadId: string; state: string; taskId?: string; taskCode?: string; title?: string; link?: string };
    }>();
    expect(busyBody.error).toBe("workspace_busy");
    expect(busyBody.message).toContain("BIT-1");
    expect(busyBody.session).toEqual({
      threadId: "thread-root-1",
      state: "working",
      taskId: rootTask.id,
      taskCode: "BIT-1",
      title: "Edits the root checkout",
      link: `${T3_ORIGIN}/threads/thread-root-1`,
    });
    expect(launchCount()).toBe(launchesBefore);
    expect(mockState.toolCalls.findLast((c) => c.name === "t3_thread_list")?.arguments).toMatchObject({
      allProjects: false,
      projectId: "t3-proj-bitig",
    });
    const refusedTask = await (await request(`/api/tasks/${secondRootTask.id}`)).json<Task>();
    expect(refusedTask.status).toBe("todo");
    expect(await storedRunState(secondRootTask.id)).toBeNull();

    // 3. An isolated worktree launch is never blocked by a root session.
    mockState.launchThreadId = "thread-worktree-1";
    expect((await launch(isolatedTask.id, "worktree")).status).toBe(201);

    // 4. Once T3 reports the root thread as completed, the stale "working" run no longer blocks,
    //    is saved as finished, and an active worktree session does not count as a root conflict.
    mockState.threadList = [
      { threadId: "thread-root-1", projectId: "t3-proj-bitig", status: "completed", activeRunId: null, settled: true },
      { threadId: "thread-worktree-1", projectId: "t3-proj-bitig", status: "running", activeRunId: "run-2" },
    ];
    expect(await storedRunState(rootTask.id)).toBe("working");
    mockState.launchThreadId = "thread-root-2";
    const freedRes = await launch(secondRootTask.id, "root");
    expect(freedRes.status).toBe(201);
    expect((await freedRes.json<{ run: AgentRun }>()).run.workspaceStrategy).toBe("root");
    expect(await storedRunState(rootTask.id)).toBe("finished");
  });

  it("orchestrates child T3 sessions from an umbrella task with waiting_subagent state and completion/failure handback (#BIT-141)", async () => {
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

    async function callMcpTool(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{ isError?: boolean; text: string }> {
      const res = await app.request(
        `${BASE_URL}/mcp`,
        {
          method: "POST",
          headers: {
            Authorization: TEST_MCP_AUTH_HEADER,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        },
        env,
      );
      expect(res.status).toBe(200);
      const raw = await res.text();
      const dataLine = raw
        .split("\n")
        .find((line) => line.startsWith("data: "));
      const payload = JSON.parse(dataLine ? dataLine.slice(6) : raw) as {
        result?: { isError?: boolean; content?: { text?: string }[] };
      };
      return {
        ...(payload.result?.isError ? { isError: true } : {}),
        text: payload.result?.content?.[0]?.text ?? "",
      };
    }

    const umbrella = await (
      await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: project.id, title: "Umbrella roadmap" }),
      })
    ).json<Task>();
    const childOne = await (
      await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          title: "Child step one",
          dependsOn: [umbrella.id],
          checklist: [{ text: "Write handler", done: true }],
        }),
      })
    ).json<Task>();
    const childTwo = await (
      await request("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          title: "Child step two",
          dependsOn: [umbrella.id, childOne.id],
        }),
      })
    ).json<Task>();

    // 1. Start the umbrella task in T3 (BIT-1).
    mockState.launchThreadId = "thread-umbrella";
    const startUmbrellaRes = await request(`/api/tasks/${umbrella.id}/t3-run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceStrategy: "worktree" }),
    });
    expect(startUmbrellaRes.status).toBe(201);

    // 2. Starting BIT-2 via MCP start_t3_thread({ taskId: "BIT-2", parentTaskId: "BIT-1" }) launches BIT-2
    //    and transitions BIT-1's run to waiting_subagent.
    mockState.launchThreadId = "thread-child-1";
    const startChildOne = await callMcpTool("start_t3_thread", {
      taskId: "BIT-2",
      parentTaskId: "BIT-1",
    });
    expect(startChildOne.isError).toBeUndefined();
    const launchedChildOne = JSON.parse(startChildOne.text) as { run: AgentRun; task: Task & { code: string } };
    expect(launchedChildOne.task.code).toBe("BIT-2");
    expect(launchedChildOne.task.status).toBe("in_progress");
    expect(launchedChildOne.run.threadId).toBe("thread-child-1");
    expect(launchedChildOne.run.parentTaskId).toBe(umbrella.id);

    // Starting another child while BIT-1 already waits on BIT-2 is refused.
    const concurrentAttempt = await callMcpTool("start_t3_thread", {
      taskId: "BIT-3",
      parentTaskId: "BIT-1",
    });
    expect(concurrentAttempt.isError).toBe(true);

    // 3. Even when BIT-1's T3 thread is idle ("completed"), live status reconciliation keeps BIT-1
    //    in waiting_subagent while BIT-2 is in_progress with an active run.
    mockState.threadStatus = "completed";
    mockState.recentRunStatus = "completed";
    mockState.activeRunId = null;
    mockState.threadList = [
      {
        threadId: "thread-umbrella",
        projectId: "t3-proj-bitig",
        status: "completed",
        pendingRequestCount: 0,
        activeRunId: null,
        settled: false,
      },
      {
        threadId: "thread-child-1",
        projectId: "t3-proj-bitig",
        status: "running",
        pendingRequestCount: 0,
        activeRunId: "run-child-1",
        settled: false,
      },
    ];

    const umbrellaLiveDuringWait = await (
      await request(`/api/tasks/${umbrella.id}/t3-run`)
    ).json<T3TaskRunLiveResponse>();
    expect(umbrellaLiveDuringWait.run?.state).toBe("waiting_subagent");
    expect(umbrellaLiveDuringWait.run?.waitingForTaskId).toBe(childOne.id);

    const liveRunsDuringWait = await (await request("/api/t3/runs")).json<T3RunsLiveResponse>();
    const reconciledUmbrella = liveRunsDuringWait.runs.find((r) => r.taskId === umbrella.id);
    expect(reconciledUmbrella?.state).toBe("waiting_subagent");
    expect(reconciledUmbrella?.waitingForTaskId).toBe(childOne.id);
    const umbrellaSession = liveRunsDuringWait.activeSessions?.find((s) => s.taskId === umbrella.id);
    expect(umbrellaSession?.state).toBe("waiting_subagent");
    expect(umbrellaSession?.waitingForTaskId).toBe(childOne.id);

    // 4. Child agent saves a checkpoint, posts a final comment, and completes BIT-2 via MCP complete_task.
    await callMcpTool("save_checkpoint", {
      taskId: "BIT-2",
      stepIndex: 0,
      status: "COMPLETED",
      stateSnapshot: {
        summary: "Implemented child step one handler and tests.",
        modifiedArtifacts: ["src/step-one.ts"],
        decisionsMade: ["Used atomic D1 update"],
        nextStepInstructions: "Done.",
      },
    });
    await callMcpTool("add_comment", {
      taskId: "BIT-2",
      author: "claude-child",
      body: "Child step one verified and ready.",
    });

    const completedOne = await callMcpTool("complete_task", { id: "BIT-2" });
    expect(completedOne.isError).toBeUndefined();

    // Handback sent continuation prompt to BIT-1's thread, posted summary comment on BIT-1,
    // and moved BIT-1's run back to working with waitingForTaskId cleared.
    const sendCallOne = mockState.toolCalls.findLast((c) => c.name === "t3_thread_send");
    expect(sendCallOne?.arguments).toMatchObject({
      threadId: "thread-umbrella",
      mode: "auto",
    });
    expect(String(sendCallOne?.arguments.message)).toContain(
      "Child task BIT-2 that you started from BIT-1 is done.",
    );
    expect(String(sendCallOne?.arguments.message)).toContain("Implemented child step one handler and tests.");
    expect(String(sendCallOne?.arguments.message)).toContain("Child step one verified and ready.");

    const umbrellaCommentsAfterOne = await (
      await request(`/api/tasks/${umbrella.id}/comments`)
    ).json<{ body: string; author?: string }[]>();
    expect(umbrellaCommentsAfterOne.some((c) => c.body.includes("Started child task #BIT-2"))).toBe(true);
    expect(
      umbrellaCommentsAfterOne.some(
        (c) =>
          c.body.includes("Child task #BIT-2") &&
          c.body.includes("Implemented child step one handler and tests.") &&
          c.body.includes("Child step one verified and ready."),
      ),
    ).toBe(true);

    const umbrellaRowAfterOne = await env.DB.prepare(
      "SELECT state, waiting_for_task_id FROM agent_runs WHERE task_id = ?",
    )
      .bind(umbrella.id)
      .first<{ state: string; waiting_for_task_id: string | null }>();
    expect(umbrellaRowAfterOne).toEqual({ state: "working", waiting_for_task_id: null });

    // 5. Umbrella session now delegates BIT-3 (unblocked since BIT-2 is done).
    mockState.launchThreadId = "thread-child-2";
    const startChildTwo = await callMcpTool("start_t3_thread", {
      taskId: "BIT-3",
      parentTaskId: "BIT-1",
    });
    expect(startChildTwo.isError).toBeUndefined();

    // Simulate childTwo's T3 thread failing before BIT-3 is completed: live reconciliation notifies BIT-1.
    mockState.threadList = [
      {
        threadId: "thread-umbrella",
        projectId: "t3-proj-bitig",
        status: "completed",
        pendingRequestCount: 0,
        activeRunId: null,
        settled: false,
      },
      {
        threadId: "thread-child-2",
        projectId: "t3-proj-bitig",
        status: "failed",
        pendingRequestCount: 0,
        activeRunId: null,
        settled: false,
      },
    ];
    const runsAfterChildFailure = await (await request("/api/t3/runs")).json<T3RunsLiveResponse>();
    const childTwoRun = runsAfterChildFailure.runs.find((r) => r.taskId === childTwo.id);
    const umbrellaAfterChildFailure = runsAfterChildFailure.runs.find((r) => r.taskId === umbrella.id);
    expect(childTwoRun?.state).toBe("failed");
    expect(umbrellaAfterChildFailure?.state).toBe("working");
    expect(umbrellaAfterChildFailure?.waitingForTaskId).toBeUndefined();

    const sendCallFailure = mockState.toolCalls.findLast((c) => c.name === "t3_thread_send");
    expect(sendCallFailure?.arguments).toMatchObject({ threadId: "thread-umbrella" });
    expect(String(sendCallFailure?.arguments.message)).toContain(
      "The T3 session of child task #BIT-3 failed before the task was done.",
    );
  });
  describe("host folder registration (BIT-148)", () => {
    const FOLDER = "/var/www/acme";
    const PROJECT_TOOLS = new Set(["t3_project_list", "t3_project_create", "t3_project_delete"]);

    async function createProject(name: string, key: string): Promise<Project> {
      const res = await request("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, key }),
      });
      expect(res.status).toBe(201);
      return res.json<Project>();
    }

    function registerFolder(projectId: string, body: unknown, headers?: Record<string, string>): Promise<Response> {
      return request(`/api/t3/projects/${projectId}/host-folder`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    }

    function unregisterFolder(projectId: string, query = "", headers?: Record<string, string>): Promise<Response> {
      return request(`/api/t3/projects/${projectId}/host-folder${query}`, { method: "DELETE", headers: { ...headers } });
    }

    function checkFolder(body: unknown, headers?: Record<string, string>): Promise<Response> {
      return request("/api/t3/host-folders/check", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
      });
    }

    function projectToolCalls(): RecordedToolCall[] {
      return mockState.toolCalls.filter((call) => PROJECT_TOOLS.has(call.name));
    }

    /** A personal access token for a member of the default organisation with the given role. */
    async function memberAuthHeader(role: OrganisationRole): Promise<string> {
      const user = await new D1UserStore(env.DB).create({
        email: `${role}-${defaultIdGenerator()}@bitig.test`,
        username: `${role}${String(Date.now())}`,
        displayName: `Org ${role}`,
      });
      await new D1OrganisationStore(env.DB).addMember(DEFAULT_ORGANISATION_ID, user.id, role);
      const rawToken = `btg_${defaultIdGenerator().replaceAll("-", "")}`;
      await new D1AccessTokenStore(env.DB).create({
        userId: user.id,
        orgId: DEFAULT_ORGANISATION_ID,
        name: `${role} token`,
        tokenHash: await sha256Hex(rawToken),
        prefix: rawToken.slice(0, 8),
      });
      return `Bearer ${rawToken}`;
    }

    beforeEach(() => {
      mockState.remoteProjects = [];
    });

    it("registers an existing folder with an explicit workspaceRoot and links it", async () => {
      await connectT3Host();
      const project = await createProject("Acme", "ACM");

      const res = await registerFolder(project.id, { workspaceRoot: `${FOLDER}/` });
      expect(res.status).toBe(201);
      const body = await res.json<{ mapping: T3ProjectMapping; created: boolean }>();
      expect(body.created).toBe(true);
      expect(body.mapping).toMatchObject({ projectId: project.id, t3ProjectId: "t3-proj-1", t3ProjectTitle: "Acme" });

      const create = projectToolCalls().find((call) => call.name === "t3_project_create");
      // The trailing slash is normalised; createWorkspaceRootIfMissing is never sent.
      expect(create?.arguments).toEqual({ title: "Acme", workspaceRoot: FOLDER });
      expect(await new T3D1Store(env.DB).getProjectMapping(project.id)).toMatchObject({ t3ProjectId: "t3-proj-1" });
    });

    it("makes retries idempotent without registering the folder twice", async () => {
      await connectT3Host();
      const project = await createProject("Retry", "RTY");

      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);
      const retry = await registerFolder(project.id, { workspaceRoot: FOLDER });
      expect(retry.status).toBe(200);
      expect((await retry.json<{ created: boolean }>()).created).toBe(false);

      expect(projectToolCalls().filter((call) => call.name === "t3_project_create")).toHaveLength(1);
      expect(mockState.remoteProjects).toHaveLength(1);
      const mappings = await new T3D1Store(env.DB).listProjectMappings();
      expect(mappings.filter((mapping) => mapping.t3ProjectId === "t3-proj-1")).toHaveLength(1);
    });

    it("links a folder T3 already registered but no Bitig project uses, e.g. after a failed save", async () => {
      await connectT3Host();
      const project = await createProject("Recovered", "REC");
      mockState.remoteProjects = [{ id: "t3-existing", title: "acme", workspaceRoot: FOLDER }];

      const res = await registerFolder(project.id, { workspaceRoot: FOLDER });
      expect(res.status).toBe(200);
      const body = await res.json<{ mapping: T3ProjectMapping; created: boolean }>();
      expect(body).toMatchObject({ created: false, mapping: { t3ProjectId: "t3-existing" } });
      expect(projectToolCalls().some((call) => call.name === "t3_project_create")).toBe(false);
    });

    it("finds an existing registration beyond the first page of T3 projects", async () => {
      await connectT3Host();
      const project = await createProject("Paged", "PGD");
      mockState.remoteProjects = Array.from({ length: 150 }, (_, index) => ({
        id: `t3-${String(index)}`,
        title: `p${String(index)}`,
        workspaceRoot: `/var/www/p${String(index)}`,
      }));

      const res = await registerFolder(project.id, { workspaceRoot: "/var/www/p140" });
      expect(res.status).toBe(200);
      expect((await res.json<{ mapping: T3ProjectMapping }>()).mapping.t3ProjectId).toBe("t3-140");
      expect(projectToolCalls().filter((call) => call.name === "t3_project_list")).toHaveLength(2);
    });

    it("rejects a folder already linked to another Bitig project", async () => {
      await connectT3Host();
      const first = await createProject("First", "FST");
      const second = await createProject("Second", "SCD");
      expect((await registerFolder(first.id, { workspaceRoot: FOLDER })).status).toBe(201);

      const res = await registerFolder(second.id, { workspaceRoot: FOLDER });
      expect(res.status).toBe(409);
      const body = await res.json<{ error: string; message: string }>();
      expect(body.error).toBe("folder_mapped_to_other_project");
      expect(body.message).toContain('"First"');
      expect(await new T3D1Store(env.DB).getProjectMapping(second.id)).toBeUndefined();
    });

    it("rejects registering a second folder for an already linked project", async () => {
      await connectT3Host();
      const project = await createProject("Linked", "LNK");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);

      const res = await registerFolder(project.id, { workspaceRoot: "/var/www/other" });
      expect(res.status).toBe(409);
      expect((await res.json<{ error: string }>()).error).toBe("project_already_mapped");
      expect(projectToolCalls().filter((call) => call.name === "t3_project_create")).toHaveLength(1);
    });

    it("reports a missing folder with an actionable error and saves no mapping", async () => {
      await connectT3Host();
      const project = await createProject("Missing", "MSG");
      mockState.toolErrors = {
        t3_project_create: JSON.stringify({
          _tag: "OrchestratorMcpFailure",
          code: "invalid_request",
          message: "Workspace root /var/www/acme does not exist.",
        }),
      };

      const res = await registerFolder(project.id, { workspaceRoot: FOLDER });
      expect(res.status).toBe(422);
      const body = await res.json<{ error: string; message: string }>();
      expect(body.error).toBe("t3_rejected");
      expect(body.message).toContain("does not exist");
      expect(body.message).toContain("Check that the folder exists on the host");
      expect(await new T3D1Store(env.DB).getProjectMapping(project.id)).toBeUndefined();
    });

    it("tells the owner to reconnect with full access when T3 denies project changes", async () => {
      await connectT3Host();
      const project = await createProject("Denied", "DND");
      mockState.toolErrors = {
        t3_project_create: JSON.stringify({
          _tag: "OrchestratorMcpFailure",
          code: "capability_denied",
          message: "Changing projects or environment settings needs a live full-access/default calling thread or a full-access client.",
        }),
      };

      const res = await registerFolder(project.id, { workspaceRoot: FOLDER });
      expect(res.status).toBe(502);
      const body = await res.json<{ error: string; message: string }>();
      expect(body.error).toBe("t3_access_denied");
      expect(body.message).toContain("Reconnect the T3 host with full access");
    });

    it("reports an offline host and saves no mapping", async () => {
      await connectT3Host();
      const project = await createProject("Offline", "OFL");
      mockState.failMcpConnection = true;

      const res = await registerFolder(project.id, { workspaceRoot: FOLDER });
      expect(res.status).toBe(503);
      const body = await res.json<{ error: string; message: string }>();
      expect(body.error).toBe("host_offline");
      expect(body.message).toContain("Check that T3 is running");
      expect(await new T3D1Store(env.DB).getProjectMapping(project.id)).toBeUndefined();
    });

    it("asks the owner to connect a host first when none is connected", async () => {
      const project = await createProject("No host", "NHS");
      const res = await registerFolder(project.id, { workspaceRoot: FOLDER });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("No T3 Code host is connected");
    });

    it.each([
      "www/acme",
      "../acme",
      "--upload-pack=touch /tmp/x",
      "/var/www/-rf",
      "/var/www/../etc",
      "/var/www/acme\nrm",
      "~",
      "/",
      "",
    ])("rejects the invalid path %j before calling T3", async (workspaceRoot) => {
      await connectT3Host();
      const project = await createProject("Invalid", "INV");

      const res = await registerFolder(project.id, { workspaceRoot });
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe("validation_error");
      expect((await checkFolder({ workspaceRoot })).status).toBe(400);
      expect(projectToolCalls()).toHaveLength(0);
    });

    it("rejects createWorkspaceRootIfMissing and other unknown fields", async () => {
      await connectT3Host();
      const project = await createProject("Strict", "STR");
      const res = await registerFolder(project.id, { workspaceRoot: FOLDER, createWorkspaceRootIfMissing: true });
      expect(res.status).toBe(400);
      expect(projectToolCalls()).toHaveLength(0);
    });

    it("returns 404 for an unknown Bitig project", async () => {
      await connectT3Host();
      const res = await registerFolder(defaultIdGenerator(), { workspaceRoot: FOLDER });
      expect(res.status).toBe(404);
      expect(projectToolCalls()).toHaveLength(0);
    });

    it.each<OrganisationRole>(["editor", "viewer"])("refuses %s callers on every host folder route", async (role) => {
      await connectT3Host();
      const project = await createProject("Owner only", "OWN");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);
      const callsBefore = projectToolCalls().length;
      const Authorization = await memberAuthHeader(role);

      expect((await registerFolder(project.id, { workspaceRoot: "/var/www/b" }, { Authorization })).status).toBe(403);
      expect((await unregisterFolder(project.id, "", { Authorization })).status).toBe(403);
      expect((await checkFolder({ workspaceRoot: FOLDER }, { Authorization })).status).toBe(403);
      expect(projectToolCalls()).toHaveLength(callsBefore);
      expect(await new T3D1Store(env.DB).getProjectMapping(project.id)).toBeDefined();
    });

    it("refuses unauthenticated callers", async () => {
      const res = await app.request(
        `${BASE_URL}/api/t3/host-folders/check`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceRoot: FOLDER }) },
        env,
      );
      expect(res.status).toBe(401);
      expect(projectToolCalls()).toHaveLength(0);
    });

    it("unregisters only through t3_project_delete and removes the link", async () => {
      await connectT3Host();
      const project = await createProject("Detach", "DTC");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);
      mockState.toolCalls = [];

      const res = await unregisterFolder(project.id);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ unregistered: true });
      // Bitig never touches host files: the only change it asks of T3 is deleting the project
      // record, which T3 documents as leaving the folder on disk.
      expect(mockState.toolCalls.map((call) => call.name)).toEqual(["t3_project_list", "t3_project_delete"]);
      expect(mockState.toolCalls[1]?.arguments).toEqual({ projectId: "t3-proj-1" });
      expect(mockState.remoteProjects).toHaveLength(0);
      expect(await new T3D1Store(env.DB).getProjectMapping(project.id)).toBeUndefined();

      const again = await unregisterFolder(project.id);
      expect(await again.json()).toEqual({ unregistered: false });
    });

    it("passes force only when asked and validates the flag", async () => {
      await connectT3Host();
      const project = await createProject("Force", "FRC");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);

      expect((await unregisterFolder(project.id, "?force=yes")).status).toBe(400);
      expect((await unregisterFolder(project.id, "?force=true")).status).toBe(200);
      const remove = mockState.toolCalls.find((call) => call.name === "t3_project_delete");
      expect(remove?.arguments).toEqual({ projectId: "t3-proj-1", force: true });
    });

    it("only removes the link when the T3 project is already gone", async () => {
      await connectT3Host();
      const project = await createProject("Gone", "GNE");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);
      mockState.remoteProjects = [];

      expect((await unregisterFolder(project.id)).status).toBe(200);
      expect(projectToolCalls().some((call) => call.name === "t3_project_delete")).toBe(false);
      expect(await new T3D1Store(env.DB).getProjectMapping(project.id)).toBeUndefined();
    });

    it("refuses to unregister while a session is active", async () => {
      await connectT3Host();
      const project = await createProject("Busy", "BSY");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);
      const task = await (
        await request("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: project.id, title: "Running" }),
        })
      ).json<Task>();
      const store = new T3D1Store(env.DB);
      await store.saveAgentRun({
        id: defaultIdGenerator(),
        taskId: task.id,
        t3ProjectId: "t3-proj-1",
        threadId: "thread-busy",
        state: "working",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });

      const res = await unregisterFolder(project.id);
      expect(res.status).toBe(409);
      expect((await res.json<{ error: string }>()).error).toBe("project_busy");
      expect(projectToolCalls().some((call) => call.name === "t3_project_delete")).toBe(false);
      expect(await store.getProjectMapping(project.id)).toBeDefined();
    });

    it("refuses to unregister a T3 project another Bitig project also uses", async () => {
      await connectT3Host();
      const first = await createProject("Shared A", "SHA");
      const second = await createProject("Shared B", "SHB");
      expect((await registerFolder(first.id, { workspaceRoot: FOLDER })).status).toBe(201);
      // A link made before #BIT-148 through the plain mapping route.
      await new T3D1Store(env.DB).upsertProjectMapping({ projectId: second.id, t3ProjectId: "t3-proj-1", t3ProjectTitle: "Acme" });

      const res = await unregisterFolder(first.id);
      expect(res.status).toBe(409);
      expect((await res.json<{ error: string }>()).error).toBe("t3_project_shared");
      expect(projectToolCalls().some((call) => call.name === "t3_project_delete")).toBe(false);
    });

    it("checks whether a folder is registered and which project uses it", async () => {
      await connectT3Host();
      const project = await createProject("Checked", "CHK");
      expect((await registerFolder(project.id, { workspaceRoot: FOLDER })).status).toBe(201);

      const registered = await checkFolder({ workspaceRoot: FOLDER });
      expect(registered.status).toBe(200);
      expect(await registered.json()).toEqual({
        workspaceRoot: FOLDER,
        t3Project: { id: "t3-proj-1", title: "Checked" },
        mappedProjectId: project.id,
      });

      const unregistered = await checkFolder({ workspaceRoot: "~/www/new" });
      expect(await unregistered.json()).toEqual({ workspaceRoot: "~/www/new" });
    });
  });
  describe("OAuth scope request (BIT-148)", () => {
    it("requests every scope the host advertises, preferring the protected resource's list", () => {
      expect(
        resolveT3OAuthScope({ scopes_supported: ["orchestration:read", "orchestration:operate"] }, {}),
      ).toBe("orchestration:read orchestration:operate");
      expect(resolveT3OAuthScope({ scopes_supported: ["a"] }, { scopes_supported: ["b"] })).toBe("a");
      expect(resolveT3OAuthScope({}, { scopes_supported: ["b", "b", "c"] })).toBe("b c");
    });

    it("falls back to mcp:tools and drops invalid scope tokens", () => {
      expect(resolveT3OAuthScope(null, null)).toBe("mcp:tools");
      expect(resolveT3OAuthScope({ scopes_supported: "orchestration:read" }, {})).toBe("mcp:tools");
      expect(resolveT3OAuthScope({ scopes_supported: [] }, { scopes_supported: [] })).toBe("mcp:tools");
      expect(
        resolveT3OAuthScope({ scopes_supported: ["ok", "has space", 'quo"te', "back\\slash", 7, "x".repeat(201)] }, {}),
      ).toBe("ok");
    });

    it("puts the advertised scopes in the authorization URL", async () => {
      mockState.resourceScopes = ["orchestration:read", "orchestration:operate"];
      const startRes = await request("/api/t3/oauth/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mcpUrl: T3_MCP_URL }),
      });
      expect(startRes.status).toBe(200);
      const { authorizationUrl } = await startRes.json<{ authorizationUrl: string }>();
      expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("orchestration:read orchestration:operate");
    });
  });
});
