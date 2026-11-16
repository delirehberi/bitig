import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { DEFAULT_ORGANISATION_ID } from "@bitig/core";
import { D1WorkQueueStore, T3D1Store } from "@bitig/storage-d1";
import { encryptT3Token } from "../src/t3/crypto";
import { TEST_AUTH_HEADER, TEST_MCP_TOKEN, TEST_MCP_URL_TOKEN, TEST_T3_ENCRYPTION_KEY } from "./constants";

const BASE_URL = "https://bitig.test";

const DB_SETUP_STATEMENTS = [
  "DROP TABLE IF EXISTS `work_queue_items`",
  "DROP TABLE IF EXISTS `work_queues`",
  "DROP TABLE IF EXISTS `feedback_entries`",
  "DROP TABLE IF EXISTS `feedback_forms`",
  "DROP TABLE IF EXISTS `agent_run_children`",
  "DROP TABLE IF EXISTS `project_run_settings`",
  "DROP TABLE IF EXISTS `task_run_profiles`",
  "DROP TABLE IF EXISTS `org_ai_router_settings`",
  "DROP TABLE IF EXISTS `run_level_models`",
  "DROP TABLE IF EXISTS `run_levels`",
  "DROP TABLE IF EXISTS `t3_run_requests`",
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
  `CREATE TABLE IF NOT EXISTS \`organisations\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`slug\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`deleted_at\` integer
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS `organisations_slug_unique` ON `organisations` (`slug`)",
  "INSERT OR IGNORE INTO `organisations` (`id`, `name`, `slug`, `created_at`, `updated_at`) VALUES ('01a10000-0000-7000-8000-000000000001', 'Default Organisation', 'default', 1791723553130, 1791723553130)",
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
    \`parent_id\` text,
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
    \`label\` text,
    \`kind\` text DEFAULT 'user' NOT NULL,
    \`projects_root\` text DEFAULT '~/www' NOT NULL,
    \`mcp_url\` text NOT NULL,
    \`issuer\` text NOT NULL,
    \`client_id\` text NOT NULL,
    \`encrypted_access_token\` text NOT NULL,
    \`token_iv\` text NOT NULL,
    \`scope\` text NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`connected_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`max_parallel_runs\` integer
  )`,
  "CREATE INDEX `t3_connections_org_id_idx` ON `t3_connections` (`org_id`)",
  "CREATE UNIQUE INDEX `t3_connections_org_mcp_url_unique` ON `t3_connections` (`org_id`, `mcp_url`)",
  `CREATE TABLE \`t3_oauth_states\` (
    \`state\` text PRIMARY KEY NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
    \`host_id\` text,
    \`label\` text,
    \`kind\` text DEFAULT 'user' NOT NULL,
    \`projects_root\` text DEFAULT '~/www' NOT NULL,
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
    \`host_id\` text,
    \`t3_project_id\` text NOT NULL,
    \`t3_project_title\` text NOT NULL,
    \`workspace_root\` text,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `t3_project_mappings_host_id_idx` ON `t3_project_mappings` (`host_id`)",
  `CREATE TABLE \`agent_runs\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL,
    \`host_id\` text,
    \`t3_project_id\` text NOT NULL,
    \`thread_id\` text NOT NULL,
    \`link\` text,
    \`state\` text NOT NULL,
    \`model\` text,
    \`provider_instance_id\` text,
    \`model_options\` text,
    \`model_source\` text,
    \`level_key\` text,
    \`model_skip_reason\` text,
    \`branch\` text,
    \`head_sha\` text,
    \`diff_stat\` text,
    \`pull_request_urls\` text,
    \`workspace_strategy\` text,
    \`parent_task_id\` text,
    \`waiting_for_task_id\` text,
    \`hierarchy_mode\` text,
    \`started_by\` text,
    \`started_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `agent_runs_task_id_idx` ON `agent_runs` (`task_id`)",
  "CREATE INDEX `agent_runs_host_id_idx` ON `agent_runs` (`host_id`)",
  "CREATE INDEX `agent_runs_thread_id_idx` ON `agent_runs` (`thread_id`)",
  "CREATE INDEX `agent_runs_waiting_for_task_id_idx` ON `agent_runs` (`waiting_for_task_id`)",
  `CREATE TABLE \`t3_run_requests\` (
    \`sequence\` integer PRIMARY KEY AUTOINCREMENT,
    \`id\` text NOT NULL UNIQUE,
    \`org_id\` text NOT NULL,
    \`task_id\` text NOT NULL REFERENCES \`tasks\` (\`id\`) ON DELETE CASCADE,
    \`host_id\` text,
    \`kind\` text NOT NULL,
    \`payload\` text NOT NULL,
    \`state\` text NOT NULL DEFAULT 'queued',
    \`claim_token\` text,
    \`lease_until\` integer,
    \`attempted\` integer NOT NULL DEFAULT 0,
    \`created_at\` integer NOT NULL
  )`,
  "CREATE INDEX `t3_run_requests_pending_idx` ON `t3_run_requests` (`org_id`, `task_id`, `state`, `sequence`)",
  `CREATE TABLE \`project_t3_threads\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`project_id\` text NOT NULL,
    \`host_id\` text,
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
  "CREATE UNIQUE INDEX `project_t3_threads_host_thread_idx` ON `project_t3_threads` (`host_id`, `thread_id`)",
  "CREATE INDEX `project_t3_threads_project_id_idx` ON `project_t3_threads` (`project_id`)",
  "CREATE INDEX `project_t3_threads_host_id_idx` ON `project_t3_threads` (`host_id`)",
  `CREATE TABLE \`run_levels\` (
    \`org_id\` text NOT NULL REFERENCES \`organisations\` (\`id\`) ON DELETE CASCADE,
    \`key\` text NOT NULL,
    \`label\` text NOT NULL,
    \`description\` text NOT NULL,
    \`sort_order\` integer NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  "CREATE UNIQUE INDEX `run_levels_org_key_unique` ON `run_levels` (`org_id`, `key`)",
  "CREATE INDEX `run_levels_org_sort_idx` ON `run_levels` (`org_id`, `sort_order`)",
  `CREATE TABLE \`run_level_models\` (
    \`org_id\` text NOT NULL REFERENCES \`organisations\` (\`id\`) ON DELETE CASCADE,
    \`level_key\` text NOT NULL,
    \`host_id\` text,
    \`provider_instance_id\` text NOT NULL,
    \`model\` text NOT NULL,
    \`options\` text,
    \`updated_at\` integer NOT NULL
  )`,
  "CREATE UNIQUE INDEX `run_level_models_org_level_host_unique` ON `run_level_models` (`org_id`, `level_key`, `host_id`)",
  "CREATE UNIQUE INDEX `run_level_models_org_level_default_unique` ON `run_level_models` (`org_id`, `level_key`) WHERE `host_id` IS NULL",
  `CREATE TABLE \`org_ai_router_settings\` (
    \`org_id\` text PRIMARY KEY NOT NULL REFERENCES \`organisations\` (\`id\`) ON DELETE CASCADE,
    \`base_url\` text NOT NULL,
    \`model\` text NOT NULL,
    \`api_style\` text DEFAULT 'cloudflare-run' NOT NULL,
    \`encrypted_api_token\` text,
    \`token_iv\` text,
    \`token_last4\` text,
    \`enabled\` integer DEFAULT 0 NOT NULL,
    \`updated_by\` text,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`task_run_profiles\` (
    \`task_id\` text PRIMARY KEY NOT NULL REFERENCES \`tasks\` (\`id\`) ON DELETE CASCADE,
    \`level_key\` text,
    \`provider_instance_id\` text,
    \`model\` text,
    \`options\` text,
    \`touches\` text,
    \`parallel_safe\` integer,
    \`source\` text NOT NULL,
    \`reason\` text,
    \`confidence\` real,
    \`updated_by\` text,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`project_run_settings\` (
    \`project_id\` text PRIMARY KEY NOT NULL REFERENCES \`projects\` (\`id\`) ON DELETE CASCADE,
    \`default_run_level\` text,
    \`serial_paths\` text,
    \`max_parallel_children\` integer DEFAULT 3 NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`agent_run_children\` (
    \`parent_task_id\` text NOT NULL REFERENCES \`tasks\` (\`id\`) ON DELETE CASCADE,
    \`child_task_id\` text NOT NULL REFERENCES \`tasks\` (\`id\`) ON DELETE CASCADE,
    \`state\` text NOT NULL,
    \`branch\` text,
    \`head_sha\` text,
    \`merged_at\` integer,
    \`merged_sha\` text,
    \`started_at\` integer NOT NULL,
    \`finished_at\` integer
  )`,
  "CREATE UNIQUE INDEX `agent_run_children_parent_child_unique` ON `agent_run_children` (`parent_task_id`, `child_task_id`)",
  "CREATE INDEX `agent_run_children_parent_task_id_idx` ON `agent_run_children` (`parent_task_id`)",
  "CREATE INDEX `agent_run_children_child_task_id_idx` ON `agent_run_children` (`child_task_id`)",
  `CREATE TABLE \`feedback_forms\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
    \`project_id\` text NOT NULL,
    \`public_id\` text NOT NULL,
    \`name\` text NOT NULL,
    \`title\` text NOT NULL,
    \`intro\` text DEFAULT '' NOT NULL,
    \`enabled\` integer DEFAULT 1 NOT NULL,
    \`fields\` text NOT NULL,
    \`allowed_origins\` text NOT NULL,
    \`turnstile\` integer DEFAULT 1 NOT NULL,
    \`default_labels\` text,
    \`default_priority\` text,
    \`thank_you_text\` text DEFAULT 'Thank you for your feedback.' NOT NULL,
    \`accent_color\` text,
    \`banned_words\` text,
    \`submission_count\` integer DEFAULT 0 NOT NULL,
    \`last_submitted_at\` integer,
    \`created_by\` text,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `feedback_forms_public_id_unique` ON `feedback_forms` (`public_id`)",
  "CREATE INDEX `feedback_forms_org_id_idx` ON `feedback_forms` (`org_id`)",
  "CREATE INDEX `feedback_forms_project_id_idx` ON `feedback_forms` (`project_id`)",
  `CREATE TABLE \`feedback_entries\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text,
    \`form_id\` text NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
    \`project_id\` text NOT NULL,
    \`outcome\` text DEFAULT 'pending' NOT NULL,
    \`category\` text,
    \`submitter_email\` text,
    \`submitter_name\` text,
    \`page_url\` text,
    \`ip_hash\` text,
    \`body_hash\` text,
    \`user_agent\` text,
    \`spam_score\` integer DEFAULT 0 NOT NULL,
    \`reviewed_by\` text,
    \`reviewed_at\` integer,
    \`created_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`form_id\`) REFERENCES \`feedback_forms\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `feedback_entries_form_outcome_idx` ON `feedback_entries` (`form_id`, `outcome`)",
  "CREATE INDEX `feedback_entries_task_id_idx` ON `feedback_entries` (`task_id`)",
  "CREATE INDEX `feedback_entries_duplicate_idx` ON `feedback_entries` (`form_id`, `ip_hash`, `body_hash`, `created_at`)",
  `CREATE TABLE \`work_queues\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
    \`created_by\` text NOT NULL,
    \`prompt\` text NOT NULL,
    \`state\` text DEFAULT 'planning' NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  "CREATE INDEX `work_queues_org_state_idx` ON `work_queues` (`org_id`, `state`)",
  `CREATE TABLE \`work_queue_items\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`queue_id\` text NOT NULL,
    \`task_id\` text NOT NULL,
    \`position\` integer NOT NULL,
    \`lane\` text NOT NULL,
    \`state\` text DEFAULT 'waiting' NOT NULL,
    \`waiting_reason\` text,
    \`resolved_selection\` text,
    \`umbrella_task_id\` text,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`queue_id\`) REFERENCES \`work_queues\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `work_queue_items_queue_position_idx` ON `work_queue_items` (`queue_id`, `position`)",
  "CREATE INDEX `work_queue_items_task_id_idx` ON `work_queue_items` (`task_id`)",
  "CREATE UNIQUE INDEX `work_queue_items_one_active_per_task_idx` ON `work_queue_items` (`task_id`) WHERE `state` IN ('waiting', 'ready', 'running', 'merged')",
];

class WebStreamableTransport implements Transport {
  private readonly inner: StreamableHTTPClientTransport;

  constructor(url: URL, options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1]) {
    this.inner = new StreamableHTTPClientTransport(url, options);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: Parameters<Transport["send"]>[0], options?: Parameters<Transport["send"]>[1]): Promise<void> {
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

/** Connects with the header token by default, or with `?token=` and no header when `urlToken` is given. */
function createMcpClient(
  token: string = TEST_MCP_TOKEN,
  urlToken?: string,
): {
  client: Client;
  transport: Transport;
} {
  const url = new URL(`${BASE_URL}/mcp`);
  if (urlToken !== undefined) url.searchParams.set("token", urlToken);
  const transport = new WebStreamableTransport(url, {
    requestInit: urlToken === undefined ? { headers: { Authorization: `Bearer ${token}` } } : {},
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return exports.default.fetch(request);
    },
  });

  const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  return { client, transport };
}

describe("Remote MCP Authentication", () => {
  it("rejects unauthenticated requests to /mcp with 401", async () => {
    const res = await exports.default.fetch(new Request(`${BASE_URL}/mcp`, { method: "POST" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with invalid Bearer token", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests using Basic Auth credentials on /mcp", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: `Basic ${btoa("admin:secret123")}` },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with empty Bearer header", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer " },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("Remote MCP URL token", () => {
  const postMcp = (query: string, headers?: Record<string, string>) =>
    exports.default.fetch(new Request(`${BASE_URL}/mcp${query}`, { method: "POST", ...(headers ? { headers } : {}) }));

  it("connects with ?token= and no Authorization header", async () => {
    const { client, transport } = createMcpClient(TEST_MCP_TOKEN, TEST_MCP_URL_TOKEN);
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("rejects a wrong URL token", async () => {
    const res = await postMcp("?token=wrong-token");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
  });

  it("does not accept the header token in the URL", async () => {
    const res = await postMcp(`?token=${TEST_MCP_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("ignores the URL token when an Authorization header is sent", async () => {
    const res = await postMcp(`?token=${TEST_MCP_URL_TOKEN}`, { Authorization: "Bearer wrong-token" });
    expect(res.status).toBe(401);
  });
});

describe("Remote MCP Protocol & Tool Execution", () => {
  let activeClient: Client | undefined;

  beforeEach(async () => {
    for (const statement of DB_SETUP_STATEMENTS) {
      await env.DB.prepare(statement).run();
    }
  });

  afterEach(async () => {
    if (activeClient) {
      try {
        await activeClient.close();
      } catch {
        // ignore error on close
      }
      activeClient = undefined;
    }
  });

  it("lists all registered Bitig tools", async () => {
    const { client, transport } = createMcpClient();
    activeClient = client;
    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();

    expect(toolNames).toEqual([
      "add_attachment",
      "add_comment",
      "add_task",
      "backfill_ticket_codes",
      "complete_task",
      "create_project",
      "create_webhook",
      "delete_attachment",
      "delete_comment",
      "delete_project",
      "delete_task",
      "delete_webhook",
      "get_attachment",
      "get_task",
      "list_attachments",
      "list_comments",
      "list_legacy_hierarchy_inventory",
      "list_projects",
      "list_run_levels",
      "list_tasks",
      "list_webhooks",
      "list_work_queues",
      "next_task",
      "plan_work_queue",
      "queue_tasks",
      "report_child_merge",
      "report_t3_git_metadata",
      "resume_from_checkpoint",
      "save_checkpoint",
      "start_ready_children",
      "start_t3_thread",
      "suggest_run_profile",
      "update_project",
      "update_task",
      "update_webhook",
    ]);
  });

  it("executes the full project and task lifecycle over Streamable HTTP", async () => {
    const { client, transport } = createMcpClient();
    activeClient = client;
    await client.connect(transport);

    // 1. Create a project
    const createProjectRes = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Remote Project",
        description: "Testing remote MCP",
        kind: "open_source",
      },
    });
    expect(createProjectRes.isError).toBeFalsy();

    const createdProjectText = (createProjectRes.content as { text: string }[])[0]?.text ?? "{}";
    const project = JSON.parse(createdProjectText) as {
      id: string;
      name: string;
      kind: string;
      bitig_file_content: string;
    };
    expect(project.name).toBe("Remote Project");
    expect(project.kind).toBe("open_source");
    expect(project.bitig_file_content).toContain(project.id);

    // 1b. Update the project
    const updateProjectRes = await client.callTool({
      name: "update_project",
      arguments: {
        id: project.id,
        name: "Remote Project Renamed",
        description: "Updated over remote MCP",
        kind: "paid",
      },
    });
    expect(updateProjectRes.isError).toBeFalsy();
    const updatedProject = JSON.parse((updateProjectRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      name: string;
      description: string;
      kind: string;
    };
    expect(updatedProject).toMatchObject({
      id: project.id,
      name: "Remote Project Renamed",
      description: "Updated over remote MCP",
      kind: "paid",
    });

    // 2. List projects
    const listProjectsRes = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(listProjectsRes.isError).toBeFalsy();
    const projectsList = JSON.parse((listProjectsRes.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
      name: string;
    }[];
    expect(projectsList.find((p) => p.id === project.id)?.name).toBe("Remote Project Renamed");

    // 3. Add a task
    const addTaskRes = await client.callTool({
      name: "add_task",
      arguments: {
        projectId: project.id,
        title: "Remote Task 1",
        description: "Remote task description",
        priority: "high",
        dueDate: "2026-11-01",
      },
    });
    expect(addTaskRes.isError).toBeFalsy();
    const task = JSON.parse((addTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      title: string;
      status: string;
      priority: string;
      createdBy?: string;
      updatedBy?: string;
      activity?: { action: string; actor: string; toStatus?: string }[];
    };
    expect(task.title).toBe("Remote Task 1");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("high");
    expect(task.createdBy).toBe("mcp-test-client");
    expect(task.updatedBy).toBe("mcp-test-client");
    expect(task.activity).toEqual([
      expect.objectContaining({ action: "created", actor: "mcp-test-client", toStatus: "todo" }),
    ]);

    // 4. Get task
    const getTaskRes = await client.callTool({
      name: "get_task",
      arguments: { id: task.id },
    });
    expect(getTaskRes.isError).toBeFalsy();
    const retrievedTask = JSON.parse((getTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      title: string;
    };
    expect(retrievedTask.id).toBe(task.id);

    // 5. List tasks filtered by projectId
    const listTasksRes = await client.callTool({
      name: "list_tasks",
      arguments: { projectId: project.id },
    });
    expect(listTasksRes.isError).toBeFalsy();
    const tasksList = JSON.parse((listTasksRes.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
    }[];
    expect(tasksList.some((t) => t.id === task.id)).toBe(true);

    // 6. Agents cannot complete or start_t3_thread on a task a person has not approved; a person approves it over REST
    expect((task as { pendingApproval?: true }).pendingApproval).toBe(true);
    const refusedStartT3Res = await client.callTool({
      name: "start_t3_thread",
      arguments: { taskId: task.id },
    });
    expect(refusedStartT3Res.isError).toBe(true);
    expect((refusedStartT3Res.content as { text: string }[])[0]?.text).toContain("awaiting human approval");
    const refusedCompleteRes = await client.callTool({
      name: "complete_task",
      arguments: { id: task.id },
    });
    expect(refusedCompleteRes.isError).toBe(true);
    expect((refusedCompleteRes.content as { text: string }[])[0]?.text).toContain("awaiting human approval");
    const approveRes = await exports.default.fetch(
      new Request(`${BASE_URL}/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ pendingApproval: null }),
      }),
    );
    expect(approveRes.status).toBe(200);
    expect(await approveRes.json()).not.toHaveProperty("pendingApproval");

    const nextTaskRes = await client.callTool({
      name: "next_task",
      arguments: { projectId: project.id },
    });
    expect(nextTaskRes.isError).toBeFalsy();
    const nextTask: unknown = JSON.parse((nextTaskRes.content as { text: string }[])[0]?.text ?? "{}");
    expect(nextTask).toMatchObject({
      primary: { id: task.id, gates: { pendingApproval: false, blocked: false, needsHuman: false } },
      counts: { actionableTodo: 1 },
      context: { checkpoint: null },
    });

    // 7. Complete task
    const completeTaskRes = await client.callTool({
      name: "complete_task",
      arguments: { id: task.id },
    });
    expect(completeTaskRes.isError).toBeFalsy();
    const completedTask = JSON.parse((completeTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      status: string;
      completedBy?: string;
      updatedBy?: string;
      activity?: { action: string; actor: string; fromStatus?: string; toStatus?: string }[];
    };
    expect(completedTask.status).toBe("done");
    expect(completedTask.completedBy).toBe("mcp-test-client");
    expect(completedTask.updatedBy).toBe("mcp-test-client");
    expect(completedTask.activity).toHaveLength(2);
    expect(completedTask.activity?.[1]).toMatchObject({
      action: "completed",
      actor: "mcp-test-client",
      fromStatus: "todo",
      toStatus: "done",
    });

    // 8. Update task
    const updateTaskRes = await client.callTool({
      name: "update_task",
      arguments: {
        id: task.id,
        title: "Updated Remote Task Title",
        needsHuman: "Confirm the deploy window",
      },
    });
    expect(updateTaskRes.isError).toBeFalsy();
    const updatedTask = JSON.parse((updateTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      title: string;
      needsHuman?: string;
    };
    expect(updatedTask.title).toBe("Updated Remote Task Title");
    expect(updatedTask.needsHuman).toBe("Confirm the deploy window");

    // 8b. Archive prerequisite and verify resume_from_checkpoint on a dependent task treats archived as satisfied (blocked: false)
    const addDependentRes = await client.callTool({
      name: "add_task",
      arguments: {
        projectId: project.id,
        title: "Dependent Remote Task",
        dependsOn: [task.id],
        needsHuman: "Verify prerequisite gate",
      },
    });
    expect(addDependentRes.isError).toBeFalsy();
    const dependentTask = JSON.parse((addDependentRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
    };

    const resumeDoneDepRes = await client.callTool({
      name: "resume_from_checkpoint",
      arguments: { taskId: dependentTask.id },
    });
    expect(resumeDoneDepRes.isError).toBeFalsy();
    expect(JSON.parse((resumeDoneDepRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
      gates: {
        pendingApproval: true,
        needsHuman: "Verify prerequisite gate",
        dependencies: [{ id: task.id, status: "done", blocked: false }],
      },
    });

    const archivePrereqRes = await client.callTool({
      name: "update_task",
      arguments: { id: task.id, status: "archived" },
    });
    expect(archivePrereqRes.isError).toBeFalsy();

    const resumeArchivedDepRes = await client.callTool({
      name: "resume_from_checkpoint",
      arguments: { taskId: dependentTask.id },
    });
    expect(resumeArchivedDepRes.isError).toBeFalsy();
    expect(JSON.parse((resumeArchivedDepRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
      gates: {
        pendingApproval: true,
        needsHuman: "Verify prerequisite gate",
        dependencies: [{ id: task.id, status: "archived", blocked: false }],
      },
    });

    await client.callTool({
      name: "delete_task",
      arguments: { id: dependentTask.id },
    });

    // 9. Delete task
    const deleteTaskRes = await client.callTool({
      name: "delete_task",
      arguments: { id: task.id },
    });
    expect(deleteTaskRes.isError).toBeFalsy();

    // Verify task is deleted
    const getDeletedTaskRes = await client.callTool({
      name: "get_task",
      arguments: { id: task.id },
    });
    expect(getDeletedTaskRes.isError).toBe(true);

    // 10. Delete project
    const deleteProjectRes = await client.callTool({
      name: "delete_project",
      arguments: { id: project.id },
    });
    expect(deleteProjectRes.isError).toBeFalsy();
  });

  it("handles multiple stateless requests without session state", async () => {
    // Client 1 creates a project
    const client1Setup = createMcpClient();
    await client1Setup.client.connect(client1Setup.transport);

    const createRes = await client1Setup.client.callTool({
      name: "create_project",
      arguments: { name: "Stateless Project" },
    });
    expect(createRes.isError).toBeFalsy();
    const proj = JSON.parse((createRes.content as { text: string }[])[0]?.text ?? "{}") as { id: string };
    await client1Setup.client.close();

    // Client 2 lists projects in a new connection and finds the project
    const client2Setup = createMcpClient();
    activeClient = client2Setup.client;
    await client2Setup.client.connect(client2Setup.transport);

    const listRes = await client2Setup.client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(listRes.isError).toBeFalsy();
    const list = JSON.parse((listRes.content as { text: string }[])[0]?.text ?? "[]") as { id: string }[];
    expect(list.some((p) => p.id === proj.id)).toBe(true);
  });

  it("plans a work queue with no writes, queues approved tasks while leaving pending tasks out, and lists open and closed queues (#BIT-204)", async () => {
    const { client, transport } = createMcpClient();
    activeClient = client;
    await client.connect(transport);

    const store = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const queueStore = new D1WorkQueueStore(env.DB, DEFAULT_ORGANISATION_ID);

    // Enable AI router settings to verify plan_work_queue does not route or write profiles
    const encrypted = await encryptT3Token("router-secret", TEST_T3_ENCRYPTION_KEY);
    await store.saveAiRouterSettings({
      baseUrl: "https://router.invalid.test/ai/run",
      model: "@cf/test/router",
      apiStyle: "cloudflare-run",
      encryptedApiToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenLast4: "cret",
      enabled: true,
    });

    // Create project BIT over REST and bind it to a T3 project mapping
    const projRes = await exports.default.fetch(
      new Request(`${BASE_URL}/api/projects`, {
        method: "POST",
        headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bitig Queue Project", key: "BIT" }),
      }),
    );
    expect(projRes.status).toBe(201);
    const proj = await projRes.json<{ id: string }>();
    await store.upsertProjectMapping({
      projectId: proj.id,
      hostId: null,
      t3ProjectId: "t3-bit",
      t3ProjectTitle: "Bitig",
    });

    // BIT-1 and BIT-2 created over REST (approved), BIT-3 created over MCP (pendingApproval: true)
    const t1Res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/tasks`, {
        method: "POST",
        headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: proj.id, title: "Approved Task 1" }),
      }),
    );
    expect(t1Res.status).toBe(201);
    const t1 = await t1Res.json<{ id: string }>();

    const t2Res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/tasks`, {
        method: "POST",
        headers: { Authorization: TEST_AUTH_HEADER, "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: proj.id, title: "Approved Task 2", dependsOn: [t1.id] }),
      }),
    );
    expect(t2Res.status).toBe(201);

    const addPendingRes = await client.callTool({
      name: "add_task",
      arguments: { projectId: proj.id, title: "Pending Agent Task 3" },
    });
    expect(addPendingRes.isError).toBeFalsy();
    const t3 = JSON.parse((addPendingRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      code: string;
      pendingApproval?: boolean;
    };
    expect(t3.code).toBe("BIT-3");
    expect(t3.pendingApproval).toBe(true);

    // 1. plan_work_queue returns the plan with no writes (no router profiles saved, no queues created)
    const planRes = await client.callTool({
      name: "plan_work_queue",
      arguments: { prompt: "Start BIT-1 to BIT-3" },
    });
    expect(planRes.isError).toBeFalsy();
    const plan = JSON.parse((planRes.content as { text: string }[])[0]?.text ?? "{}") as {
      rows: { code: string; classification: string; queueable: boolean }[];
      routing: { enabled: boolean; attempted: number; failed: number };
    };
    expect(plan.routing).toEqual({ enabled: false, attempted: 0, failed: 0 });
    expect(plan.rows).toEqual([
      expect.objectContaining({ code: "BIT-1", classification: "ready", queueable: true }),
      expect.objectContaining({ code: "BIT-2", classification: "after_queued_task", queueable: true }),
      expect.objectContaining({ code: "BIT-3", classification: "needs_approval", queueable: false }),
    ]);
    expect(await store.listTaskRunProfiles()).toEqual([]);
    expect(await queueStore.listQueues({ openOnly: false })).toEqual([]);

    // 2. Calling queue_tasks with ONLY a pending-approval task returns nothing_to_queue and does not approve it
    const nothingRes = await client.callTool({
      name: "queue_tasks",
      arguments: {
        prompt: "Try queueing BIT-3 only",
        items: ["BIT-3"],
        approvals: ["BIT-3"],
      },
    });
    expect(nothingRes.isError).toBeFalsy();
    const nothingBody = JSON.parse((nothingRes.content as { text: string }[])[0]?.text ?? "{}") as {
      queued: boolean;
      reason: string;
      plan: { rows: { code: string; classification: string; queueable: boolean }[] };
    };
    expect(nothingBody.queued).toBe(false);
    expect(nothingBody.reason).toBe("nothing_to_queue");
    expect(nothingBody.plan.rows).toEqual([
      expect.objectContaining({ code: "BIT-3", classification: "needs_approval", queueable: false }),
    ]);

    // Verify BIT-3 is still pendingApproval in storage
    const checkT3Res = await client.callTool({ name: "get_task", arguments: { id: "BIT-3" } });
    expect(JSON.parse((checkT3Res.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
      id: t3.id,
      pendingApproval: true,
    });

    // 3. queue_tasks with BIT-1, BIT-2, BIT-3 queues BIT-1 and BIT-2 under a lane umbrella, leaving BIT-3 out
    const queueRes = await client.callTool({
      name: "queue_tasks",
      arguments: {
        prompt: "Start BIT-1 to BIT-3",
        items: ["BIT-1", "BIT-2", "BIT-3"],
        approvals: ["BIT-3"],
      },
    });
    expect(queueRes.isError).toBeFalsy();
    const queued = JSON.parse((queueRes.content as { text: string }[])[0]?.text ?? "{}") as {
      queued: boolean;
      approved: string[];
      queue: { id: string; state: string; entries: { taskCode: string; state: string }[] };
      umbrellas: { title: string; children: string[] }[];
    };
    expect(queued.queued).toBe(true);
    expect(queued.approved).toEqual([]);
    expect(queued.queue.state).toBe("active");
    expect(queued.queue.entries.map((e) => e.taskCode)).toEqual(["BIT-1", "BIT-2"]);
    expect(queued.umbrellas).toEqual([
      expect.objectContaining({ title: "Queue: BIT-1..BIT-2", children: ["BIT-1", "BIT-2"] }),
    ]);

    // BIT-3 still has pendingApproval: true and no parentId
    const checkT3AfterQueue = await client.callTool({ name: "get_task", arguments: { id: "BIT-3" } });
    const t3After = JSON.parse((checkT3AfterQueue.content as { text: string }[])[0]?.text ?? "{}") as {
      pendingApproval?: boolean;
      parentId?: string;
    };
    expect(t3After.pendingApproval).toBe(true);
    expect(t3After.parentId).toBeUndefined();

    // 4. list_work_queues returns active queue; after cancelling, open-only omits it and includeClosed includes it
    const listOpenRes = await client.callTool({
      name: "list_work_queues",
      arguments: {},
    });
    expect(listOpenRes.isError).toBeFalsy();
    const openQueues = JSON.parse((listOpenRes.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
      state: string;
      entries: { taskCode: string }[];
    }[];
    expect(openQueues).toHaveLength(1);
    expect(openQueues[0]?.id).toBe(queued.queue.id);
    expect(openQueues[0]?.entries.map((e) => e.taskCode)).toEqual(["BIT-1", "BIT-2"]);

    // Cancel the queue over REST
    const cancelRes = await exports.default.fetch(
      new Request(`${BASE_URL}/api/work-queues/${queued.queue.id}/cancel`, {
        method: "POST",
        headers: { Authorization: TEST_AUTH_HEADER },
      }),
    );
    expect(cancelRes.status).toBe(200);

    const listOpenAfterCancel = await client.callTool({
      name: "list_work_queues",
      arguments: {},
    });
    expect(JSON.parse((listOpenAfterCancel.content as { text: string }[])[0]?.text ?? "[]")).toEqual([]);

    const listClosedRes = await client.callTool({
      name: "list_work_queues",
      arguments: { includeClosed: true },
    });
    const allQueues = JSON.parse((listClosedRes.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
      state: string;
    }[];
    expect(allQueues).toEqual([expect.objectContaining({ id: queued.queue.id, state: "cancelled" })]);
  });
});
