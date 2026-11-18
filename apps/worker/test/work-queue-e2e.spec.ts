import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORGANISATION_ID, type Project, type Task } from "@bitig/core";
import { D1WorkQueueStore, T3D1Store } from "@bitig/storage-d1";
import { createApp } from "../src/index";
import { encryptT3Token } from "../src/t3/crypto";
import { TEST_AUTH_HEADER, TEST_T3_ENCRYPTION_KEY } from "./constants";

const BASE_URL = "https://bitig.test";
const HOST_ID = "e2e-t3-host";
const HOST_ORIGIN = "https://t3-host.example.test";
const HOST_MCP_URL = `${HOST_ORIGIN}/mcp`;
const T3_ACCESS_TOKEN = "e2e-t3-access-token";
const ONE_HOUR_MS = 60 * 60 * 1000;

const CHEAP_SELECTION = { providerInstanceId: "prov-a", model: "model-cheap" };
const STANDARD_SELECTION = { providerInstanceId: "prov-a", model: "model-standard" };
const STRONG_SELECTION = { providerInstanceId: "prov-a", model: "model-strong" };

/** Full worker integration schema including migration 0030 (`work_queues`, `work_queue_items`, `max_parallel_runs`). */
const STATEMENTS = [
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
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL REFERENCES \`organisations\` (\`id\`) ON DELETE CASCADE,
    \`project_id\` text NOT NULL REFERENCES \`projects\` (\`id\`) ON DELETE CASCADE,
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
    \`updated_at\` integer NOT NULL
  )`,
  "CREATE UNIQUE INDEX `feedback_forms_public_id_unique` ON `feedback_forms` (`public_id`)",
  "CREATE INDEX `feedback_forms_org_id_idx` ON `feedback_forms` (`org_id`)",
  "CREATE INDEX `feedback_forms_project_id_idx` ON `feedback_forms` (`project_id`)",
  `CREATE TABLE \`feedback_entries\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text REFERENCES \`tasks\` (\`id\`) ON DELETE SET NULL,
    \`form_id\` text NOT NULL REFERENCES \`feedback_forms\` (\`id\`) ON DELETE CASCADE,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL REFERENCES \`organisations\` (\`id\`) ON DELETE CASCADE,
    \`project_id\` text NOT NULL REFERENCES \`projects\` (\`id\`) ON DELETE CASCADE,
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
    \`created_at\` integer NOT NULL
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

interface StubT3Thread {
  threadId: string;
  projectId: string;
  link: string;
  status: "running" | "completed" | "failed";
  activeRunId: string | null;
  pendingRequestCount: number;
  recentRunStatus: "running" | "completed" | "failed";
  launchArgs: Record<string, unknown>;
  messages: string[];
}

interface StubT3Host {
  threads: Map<string, StubT3Thread>;
  launches: StubT3Thread[];
  sends: { threadId: string; message: string }[];
  interrupts: string[];
  failThread: (threadId: string) => void;
  finishThread: (threadId: string) => void;
  fetchFn: typeof fetch;
}

function createStubT3Host(): StubT3Host {
  const threads = new Map<string, StubT3Thread>();
  const launches: StubT3Thread[] = [];
  const sends: { threadId: string; message: string }[] = [];
  const interrupts: string[] = [];
  let sequence = 0;

  const failThread = (threadId: string): void => {
    const thread = threads.get(threadId);
    if (!thread) throw new Error(`Unknown stub thread ${threadId}`);
    thread.status = "failed";
    thread.activeRunId = null;
    thread.recentRunStatus = "failed";
  };

  const finishThread = (threadId: string): void => {
    const thread = threads.get(threadId);
    if (!thread) throw new Error(`Unknown stub thread ${threadId}`);
    thread.status = "completed";
    thread.activeRunId = null;
    thread.recentRunStatus = "completed";
  };

  const fetchFn: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (!request.url.startsWith(HOST_ORIGIN)) {
      return new Response("Not Found", { status: 404 });
    }
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "POST") return new Response(null, { status: 405 });

    const body = await request.json<{
      id?: number | string;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    }>();
    const headers = { "mcp-session-id": "e2e-t3-session" };
    if (body.method === "notifications/initialized") {
      return new Response(null, { status: 202, headers });
    }
    if (body.method === "initialize") {
      return Response.json(
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "stub-t3-host", version: "1.0.0" },
          },
        },
        { headers },
      );
    }

    const name = body.params?.name ?? "";
    const args = body.params?.arguments ?? {};
    let payload: unknown = { ok: true };

    if (name === "orchestrator_capabilities") {
      payload = {
        providers: [
          {
            providerInstanceId: "prov-a",
            driverKind: "codex",
            displayName: "Stub Provider",
            canRunChildTask: true,
            models: [
              { id: "model-cheap", label: "Cheap Model" },
              { id: "model-standard", label: "Standard Model" },
              { id: "model-strong", label: "Strong Model" },
            ],
          },
        ],
      };
    } else if (name === "t3_thread_launch") {
      sequence += 1;
      const threadId = `t3-thread-${String(sequence)}`;
      const projectId = typeof args.projectId === "string" ? args.projectId : "unknown-project";
      const created: StubT3Thread = {
        threadId,
        projectId,
        link: `${HOST_ORIGIN}/threads/${threadId}`,
        status: "running",
        activeRunId: `active-run-${String(sequence)}`,
        pendingRequestCount: 0,
        recentRunStatus: "running",
        launchArgs: args,
        messages: [],
      };
      threads.set(threadId, created);
      launches.push(created);
      payload = { threadId, link: created.link };
    } else if (name === "t3_thread_list") {
      payload = {
        threads: [...threads.values()].map((thread) => ({
          threadId: thread.threadId,
          projectId: thread.projectId,
          link: thread.link,
          status: thread.status,
          activeRunId: thread.activeRunId,
          pendingRequestCount: thread.pendingRequestCount,
        })),
      };
    } else if (name === "t3_thread_read") {
      const requestedId = typeof args.threadId === "string" ? args.threadId : "";
      const thread = threads.get(requestedId);
      payload = {
        thread: {
          id: requestedId,
          status: thread?.status ?? "completed",
          pendingRequestCount: thread?.pendingRequestCount ?? 0,
          activeRunId: thread?.activeRunId ?? null,
          itemCount: thread?.messages.length ?? 0,
        },
        recentRuns: [{ status: thread?.recentRunStatus ?? "completed" }],
        items: [],
        nextPosition: null,
        hasMore: false,
      };
    } else if (name === "t3_thread_send") {
      const threadId = typeof args.threadId === "string" ? args.threadId : "";
      const message = typeof args.message === "string" ? args.message : "";
      sends.push({ threadId, message });
      const thread = threads.get(threadId);
      if (thread) {
        thread.messages.push(message);
        thread.status = "running";
        thread.activeRunId = `resumed-run-${String(sends.length)}`;
        thread.recentRunStatus = "running";
      }
      payload = { ok: true };
    } else if (name === "t3_thread_interrupt") {
      const threadId = typeof args.threadId === "string" ? args.threadId : "";
      interrupts.push(threadId);
      const thread = threads.get(threadId);
      if (thread) {
        thread.status = "completed";
        thread.activeRunId = null;
      }
      payload = { ok: true };
    }

    return Response.json(
      {
        jsonrpc: "2.0",
        id: body.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      },
      { headers },
    );
  };

  return { threads, launches, sends, interrupts, failThread, finishThread, fetchFn };
}

interface PlanResponse {
  parse: { items: { code: string }[]; fallback: string };
  rows: {
    code: string;
    classification: string;
    queueable: boolean;
    related?: string[];
    run?: { level: string | null; model: string | null; source: string };
  }[];
  lanes: {
    projectKey: string;
    needsQueueUmbrella: boolean;
    codes: string[];
    waves: { number: number; codes: string[]; skipped: { code: string; reason: string }[] }[];
  }[];
}

interface QueueEntryResponse {
  id: string;
  taskId: string;
  taskCode?: string;
  position: number;
  lane: string;
  state: string;
  waitingReason: string | null;
  umbrellaTaskId: string | null;
  resolvedSelection: { providerInstanceId: string; model: string } | null;
}

interface QueueResponse {
  id: string;
  state: string;
  prompt: string;
  entries: QueueEntryResponse[];
}

interface ConfirmResponse {
  queue: QueueResponse;
  umbrellas: { projectId: string; taskId: string; code?: string; title: string; children: string[] }[];
  approved: string[];
  plan: PlanResponse;
}

interface StartReadyChildrenResult {
  started: { taskId: string; code: string; threadId: string }[];
  skipped: { taskId: string; code?: string; reason: string; blockingTaskCode?: string; detail?: string }[];
}

describe("Work queue end-to-end: prompt to lane pull requests (#BIT-207)", () => {
  let host: StubT3Host;
  let app: ReturnType<typeof createApp>;
  let store: T3D1Store;
  let queueStore: D1WorkQueueStore;

  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
    host = createStubT3Host();
    app = createApp({ t3Fetch: host.fetchFn });
    store = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    queueStore = new D1WorkQueueStore(env.DB, DEFAULT_ORGANISATION_ID);

    const now = Date.now();
    const encrypted = await encryptT3Token(T3_ACCESS_TOKEN, TEST_T3_ENCRYPTION_KEY);
    await store.saveConnection({
      id: HOST_ID,
      orgId: DEFAULT_ORGANISATION_ID,
      mcpUrl: HOST_MCP_URL,
      issuer: HOST_ORIGIN,
      clientId: "bitig-e2e-client",
      encryptedAccessToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      scope: "mcp:tools",
      expiresAt: now + ONE_HOUR_MS,
      now,
    });
    await store.setRunLevelModel({ levelKey: "cheap", hostId: null, selection: CHEAP_SELECTION });
    await store.setRunLevelModel({ levelKey: "standard", hostId: null, selection: STANDARD_SELECTION });
    await store.setRunLevelModel({ levelKey: "strong", hostId: null, selection: STRONG_SELECTION });
  });

  function request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", TEST_AUTH_HEADER);
    return Promise.resolve(app.request(`${BASE_URL}${path}`, { ...init, headers }, env));
  }

  function postJson(path: string, body?: unknown): Promise<Response> {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function callMcp(name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> {
    const response = await app.request(
      `${BASE_URL}/mcp`,
      {
        method: "POST",
        headers: {
          Authorization: TEST_AUTH_HEADER,
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
    expect(response.status).toBe(200);
    const raw = await response.text();
    const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
    const rpc = JSON.parse(dataLine ? dataLine.slice(6) : raw) as {
      result?: { isError?: boolean; content?: { text?: string }[] };
    };
    const result: { isError?: boolean; text: string } = {
      text: rpc.result?.content?.[0]?.text ?? raw,
    };
    if (rpc.result?.isError !== undefined) {
      result.isError = rpc.result.isError;
    }
    return result;
  }

  async function createMappedProject(name: string, key: string): Promise<Project> {
    const response = await postJson("/api/projects", { name, key });
    expect(response.status).toBe(201);
    const project = await response.json<Project>();
    await store.upsertProjectMapping({
      projectId: project.id,
      hostId: HOST_ID,
      t3ProjectId: `t3-${key.toLowerCase()}`,
      t3ProjectTitle: name,
    });
    return project;
  }

  async function createTask(projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
    const response = await postJson("/api/tasks", { projectId, title, ...extra });
    expect(response.status).toBe(201);
    return await response.json<Task>();
  }

  async function getTask(id: string): Promise<Task> {
    const response = await request(`/api/tasks/${id}`);
    expect(response.status).toBe(200);
    return await response.json<Task>();
  }

  async function getQueues(includeClosed = false): Promise<QueueResponse[]> {
    const suffix = includeClosed ? "?all=true" : "";
    const response = await request(`/api/work-queues${suffix}`);
    expect(response.status).toBe(200);
    return await response.json<QueueResponse[]>();
  }

  it("drives a two-project prompt through preview approval, a 3-task umbrella lane with merge-gated dependency wait, an isolated failure in the single-task lane, and lane PRs", async () => {
    const bitProject = await createMappedProject("Bitig", "BIT");
    const worProject = await createMappedProject("Workouse", "WOR");

    // BIT lane (3 tasks -> queue umbrella + one PR):
    // - BIT-1 and BIT-2 have disjoint touches -> Wave 1 in parallel
    // - BIT-3 depends on BIT-1 and starts pending approval -> approved from the preview, waits in Wave 2 until BIT-1 is merged
    const bit1 = await createTask(bitProject.id, "Core parser rules", { order: 1 });
    const bit2 = await createTask(bitProject.id, "MCP queue tools", { order: 2 });
    const bit3 = await createTask(bitProject.id, "Dashboard queue panel", {
      order: 3,
      dependsOn: [bit1.id],
    });
    await request(`/api/tasks/${bit3.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pendingApproval: true }),
    });

    await store.saveTaskRunProfile({
      taskId: bit1.id,
      level: "standard",
      touches: ["packages/core/src/**"],
      parallelSafe: true,
      source: "agent",
    });
    await store.saveTaskRunProfile({
      taskId: bit2.id,
      level: "cheap",
      touches: ["packages/mcp-tools/src/**"],
      parallelSafe: true,
      source: "agent",
    });
    await store.saveTaskRunProfile({
      taskId: bit3.id,
      level: "standard",
      touches: ["apps/web/src/**"],
      parallelSafe: true,
      source: "agent",
    });

    // WOR lane (1 task -> single-task lane, no umbrella, opens its own PR):
    const wor1 = await createTask(worProject.id, "Fix billing webhook signature", { order: 1 });
    await store.saveTaskRunProfile({
      taskId: wor1.id,
      level: "standard",
      touches: ["src/billing/**"],
      parallelSafe: true,
      source: "agent",
    });

    // 1. Plan the free-text dashboard prompt spanning BIT and WOR.
    const prompt = "Start bit-1 to bit-3 and #wor-01";
    const planRes = await postJson("/api/work-queue/plan", { prompt });
    expect(planRes.status).toBe(200);
    const plan = await planRes.json<PlanResponse>();
    expect(plan.parse.items.map((item) => item.code)).toEqual(["BIT-1", "BIT-2", "BIT-3", "WOR-1"]);
    expect(plan.rows.map((row) => ({ code: row.code, classification: row.classification, queueable: row.queueable }))).toEqual([
      { code: "BIT-1", classification: "ready", queueable: true },
      { code: "BIT-2", classification: "ready", queueable: true },
      { code: "BIT-3", classification: "needs_approval", queueable: false },
      { code: "WOR-1", classification: "ready", queueable: true },
    ]);
    expect(plan.lanes).toEqual([
      expect.objectContaining({
        projectKey: "BIT",
        needsQueueUmbrella: true,
        codes: ["BIT-1", "BIT-2", "BIT-3"],
        waves: [
          expect.objectContaining({
            number: 1,
            codes: ["BIT-1", "BIT-2"],
            skipped: [expect.objectContaining({ code: "BIT-3", reason: "dependency" })],
          }),
          expect.objectContaining({
            number: 2,
            codes: ["BIT-3"],
          }),
        ],
      }),
      expect.objectContaining({
        projectKey: "WOR",
        needsQueueUmbrella: false,
        codes: ["WOR-1"],
        waves: [expect.objectContaining({ number: 1, codes: ["WOR-1"] })],
      }),
    ]);

    // 2. Confirm the queue, approving BIT-3 inline from the preview.
    //    The post-response dispatch hook immediately launches the BIT queue umbrella (BIT-4) and WOR-1 side by side.
    const confirmRes = await postJson("/api/work-queue", {
      prompt,
      items: ["BIT-1", "BIT-2", "BIT-3", "WOR-1"],
      approvals: ["BIT-3"],
      overrides: [],
    });
    expect(confirmRes.status).toBe(201);
    const confirmed = await confirmRes.json<ConfirmResponse>();
    expect(confirmed.approved).toEqual(["BIT-3"]);
    expect(confirmed.umbrellas).toHaveLength(1);
    const bitUmbrella = confirmed.umbrellas[0];
    if (!bitUmbrella) throw new Error("Expected BIT queue umbrella");
    expect(bitUmbrella).toMatchObject({
      projectId: bitProject.id,
      code: "BIT-4",
      title: "Queue: BIT-1..BIT-3",
      children: ["BIT-1", "BIT-2", "BIT-3"],
    });

    // Verify explicit `parentId` on BIT-1..3 and no umbrella on single-task WOR-1.
    expect((await getTask(bit3.id)).pendingApproval).toBeUndefined();
    expect((await getTask(bit1.id)).parentId).toBe(bitUmbrella.taskId);
    expect((await getTask(bit2.id)).parentId).toBe(bitUmbrella.taskId);
    expect((await getTask(bit3.id)).parentId).toBe(bitUmbrella.taskId);
    expect((await getTask(wor1.id)).parentId).toBeUndefined();

    // Dispatcher launched exactly 2 T3 threads: BIT-4 (the queue umbrella) and WOR-1 (the single-task lane).
    expect(host.launches).toHaveLength(2);
    const umbrellaLaunch = host.launches.find((launch) => launch.projectId === "t3-bit");
    const worFirstLaunch = host.launches.find((launch) => launch.projectId === "t3-wor");
    if (!umbrellaLaunch || !worFirstLaunch) throw new Error("Expected launches in both T3 projects");
    expect(umbrellaLaunch.launchArgs.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "HEAD",
      branch: "bitig/BIT-4",
    });
    expect(worFirstLaunch.launchArgs.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "HEAD",
      branch: "bitig/WOR-1",
    });
    expect(worFirstLaunch.launchArgs.modelSelection).toMatchObject({
      instanceId: STANDARD_SELECTION.providerInstanceId,
      model: STANDARD_SELECTION.model,
    });

    // 3. Fail WOR-1 on the stubbed T3 host and reconcile live runs (`GET /api/t3/runs`).
    //    WOR-1 becomes `failed`, while the BIT umbrella lane continues uninterrupted and the queue stays `active`.
    host.failThread(worFirstLaunch.threadId);
    const liveAfterWorFailure = await request("/api/t3/runs");
    expect(liveAfterWorFailure.status).toBe(200);

    const [queueAfterWorFailure] = await getQueues();
    if (!queueAfterWorFailure) throw new Error("Expected active queue");
    expect(queueAfterWorFailure.state).toBe("active");
    const worFailedEntry = queueAfterWorFailure.entries.find((entry) => entry.taskCode === "WOR-1");
    if (!worFailedEntry) throw new Error("Expected WOR-1 entry");
    expect(worFailedEntry.state).toBe("failed");
    expect((await store.getAgentRunByTaskId(bitUmbrella.taskId))?.state).toBe("working");

    // 4. Advance the BIT umbrella lane: report clean umbrella metadata, then start Wave 1 (`start_ready_children`).
    const umbrellaRun = await store.getAgentRunByTaskId(bitUmbrella.taskId);
    if (!umbrellaRun) throw new Error("Expected BIT-4 umbrella run");
    const reportUmbrellaInit = await callMcp("report_t3_git_metadata", {
      taskId: "BIT-4",
      runId: umbrellaRun.id,
      threadId: umbrellaLaunch.threadId,
      metadata: {
        branch: "bitig/BIT-4",
        headSha: "1".repeat(40),
        worktreePath: "/tmp/worktrees/bit-4",
        dirty: false,
      },
    });
    expect(reportUmbrellaInit.isError).toBeUndefined();

    const wave1Res = await callMcp("start_ready_children", { parentTaskId: "BIT-4" });
    expect(wave1Res.isError, wave1Res.text).toBeUndefined();
    const wave1 = JSON.parse(wave1Res.text) as StartReadyChildrenResult;
    expect(wave1.started.map((child) => child.code)).toEqual(["BIT-1", "BIT-2"]);
    expect(wave1.skipped).toEqual([
      expect.objectContaining({
        code: "BIT-3",
        reason: "blocked",
        blockingTaskCode: "BIT-1",
      }),
    ]);

    // Verify child worktrees branched from `bitig/BIT-4` (`startFromOrigin: false`).
    const bit1Launch = host.launches.find((launch) => launch.threadId === wave1.started[0]?.threadId);
    const bit2Launch = host.launches.find((launch) => launch.threadId === wave1.started[1]?.threadId);
    if (!bit1Launch || !bit2Launch) throw new Error("Expected BIT-1 and BIT-2 child launches");
    expect(bit1Launch.launchArgs.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "bitig/BIT-4",
      branch: "bitig/BIT-1",
      startFromOrigin: false,
    });
    expect(bit2Launch.launchArgs.workspaceStrategy).toEqual({
      type: "worktree",
      baseRef: "bitig/BIT-4",
      branch: "bitig/BIT-2",
      startFromOrigin: false,
    });

    // 5. Complete BIT-1 and BIT-2 on their child branches (without opening child PRs).
    const bit1Run = await store.getAgentRunByTaskId(bit1.id);
    const bit2Run = await store.getAgentRunByTaskId(bit2.id);
    if (!bit1Run || !bit2Run) throw new Error("Expected BIT-1 and BIT-2 runs");

    await callMcp("report_t3_git_metadata", {
      taskId: "BIT-1",
      runId: bit1Run.id,
      threadId: bit1Launch.threadId,
      metadata: {
        branch: "bitig/BIT-1",
        headSha: "2".repeat(40),
        worktreePath: "/tmp/worktrees/bit-1",
        dirty: false,
        changedPaths: ["packages/core/src/work-queue.ts"],
        diffStat: { filesChanged: 1, insertions: 40, deletions: 0 },
      },
    });
    const sendsBeforeWave1Done = host.sends.length;
    expect((await callMcp("complete_task", { id: "BIT-1" })).isError).toBeUndefined();
    host.finishThread(bit1Launch.threadId);
    // BIT-2 is still running, so BIT-4 has not been resumed yet.
    expect(host.sends).toHaveLength(sendsBeforeWave1Done);

    await callMcp("report_t3_git_metadata", {
      taskId: "BIT-2",
      runId: bit2Run.id,
      threadId: bit2Launch.threadId,
      metadata: {
        branch: "bitig/BIT-2",
        headSha: "3".repeat(40),
        worktreePath: "/tmp/worktrees/bit-2",
        dirty: false,
        changedPaths: ["packages/mcp-tools/src/register.ts"],
        diffStat: { filesChanged: 1, insertions: 25, deletions: 2 },
      },
    });
    expect((await callMcp("complete_task", { id: "BIT-2" })).isError).toBeUndefined();
    host.finishThread(bit2Launch.threadId);
    expect((await request("/api/t3/runs")).status).toBe(200);

    // Consolidated batch resume sent once to BIT-4's thread when both Wave 1 children ended.
    expect(host.sends).toHaveLength(sendsBeforeWave1Done + 1);
    expect(host.sends.at(-1)?.threadId).toBe(umbrellaLaunch.threadId);

    // Dependency merge gate: BIT-1 is `done`, but NOT yet merged via `report_child_merge`,
    // so BIT-1's queue item stays `running` ("Waiting for umbrella merge") and BIT-3 is STILL blocked!
    const [queueBeforeMerge] = await getQueues();
    expect(queueBeforeMerge?.entries.find((e) => e.taskCode === "BIT-1")).toMatchObject({
      state: "running",
      waitingReason: "Waiting for umbrella merge",
    });
    const prematureWave2Res = await callMcp("start_ready_children", { parentTaskId: "BIT-4" });
    expect(prematureWave2Res.isError).toBeUndefined();
    const prematureWave2 = JSON.parse(prematureWave2Res.text) as StartReadyChildrenResult;
    expect(prematureWave2.started).toEqual([]);
    expect(prematureWave2.skipped).toEqual([
      expect.objectContaining({
        taskId: bit3.id,
        reason: "blocked",
        detail: expect.stringContaining("merged") as string,
      }),
    ]);

    // 6. Umbrella merges BIT-1 and BIT-2 in task order (`report_child_merge`) and updates clean integration headSha.
    expect(
      (
        await callMcp("report_child_merge", {
          parentTaskId: "BIT-4",
          childTaskId: "BIT-1",
          mergedSha: "4".repeat(40),
        })
      ).isError,
    ).toBeUndefined();
    expect(
      (
        await callMcp("report_child_merge", {
          parentTaskId: "BIT-4",
          childTaskId: "BIT-2",
          mergedSha: "5".repeat(40),
        })
      ).isError,
    ).toBeUndefined();
    await callMcp("report_t3_git_metadata", {
      taskId: "BIT-4",
      runId: umbrellaRun.id,
      threadId: umbrellaLaunch.threadId,
      metadata: {
        branch: "bitig/BIT-4",
        headSha: "5".repeat(40),
        worktreePath: "/tmp/worktrees/bit-4",
        dirty: false,
      },
    });
    expect((await request("/api/t3/runs")).status).toBe(200);

    const [queueAfterWave1Merge] = await getQueues();
    expect(
      queueAfterWave1Merge?.entries
        .filter((e) => e.taskCode === "BIT-1" || e.taskCode === "BIT-2")
        .map((e) => e.state),
    ).toEqual(["merged", "merged"]);

    // 7. Now BIT-3 unblocks and launches in Wave 2 on `bitig/BIT-3` branched from updated `bitig/BIT-4`.
    const wave2Res = await callMcp("start_ready_children", { parentTaskId: "BIT-4" });
    expect(wave2Res.isError, wave2Res.text).toBeUndefined();
    const wave2 = JSON.parse(wave2Res.text) as StartReadyChildrenResult;
    expect(wave2.started.map((child) => child.code)).toEqual(["BIT-3"]);

    const bit3Launch = host.launches.find((launch) => launch.threadId === wave2.started[0]?.threadId);
    const bit3Run = await store.getAgentRunByTaskId(bit3.id);
    if (!bit3Launch || !bit3Run) throw new Error("Expected BIT-3 child launch and run");

    await callMcp("report_t3_git_metadata", {
      taskId: "BIT-3",
      runId: bit3Run.id,
      threadId: bit3Launch.threadId,
      metadata: {
        branch: "bitig/BIT-3",
        headSha: "6".repeat(40),
        worktreePath: "/tmp/worktrees/bit-3",
        dirty: false,
        changedPaths: ["apps/web/src/components/dashboard/WorkQueuePanel.tsx"],
        diffStat: { filesChanged: 1, insertions: 55, deletions: 3 },
      },
    });
    expect((await callMcp("complete_task", { id: "BIT-3" })).isError).toBeUndefined();
    host.finishThread(bit3Launch.threadId);
    expect((await request("/api/t3/runs")).status).toBe(200);

    expect(
      (
        await callMcp("report_child_merge", {
          parentTaskId: "BIT-4",
          childTaskId: "BIT-3",
          mergedSha: "7".repeat(40),
        })
      ).isError,
    ).toBeUndefined();

    // 8. BIT-4 opens ONE pull request for the entire BIT lane and completes BIT-4.
    const bitLanePrUrl = "https://github.com/acme/bitig/pull/42";
    expect(
      (
        await callMcp("report_t3_git_metadata", {
          taskId: "BIT-4",
          runId: umbrellaRun.id,
          threadId: umbrellaLaunch.threadId,
          metadata: {
            branch: "bitig/BIT-4",
            headSha: "7".repeat(40),
            worktreePath: "/tmp/worktrees/bit-4",
            dirty: false,
            pullRequestUrls: [bitLanePrUrl],
          },
        })
      ).isError,
    ).toBeUndefined();
    expect((await callMcp("complete_task", { id: "BIT-4" })).isError).toBeUndefined();
    host.finishThread(umbrellaLaunch.threadId);
    expect((await request("/api/t3/runs")).status).toBe(200);

    // All 3 BIT queue items are now `done`, BIT-4 holds the single lane PR, and BIT-1..3 retain `parentId = BIT-4`.
    // Meanwhile the queue stays `active` because WOR-1 failed earlier.
    const [queueAfterBitLanePr] = await getQueues();
    if (!queueAfterBitLanePr) throw new Error("Expected queue to remain open while WOR-1 is failed");
    expect(queueAfterBitLanePr.state).toBe("active");
    expect(
      queueAfterBitLanePr.entries.map((entry) => ({ code: entry.taskCode, state: entry.state })),
    ).toEqual([
      { code: "BIT-1", state: "done" },
      { code: "BIT-2", state: "done" },
      { code: "BIT-3", state: "done" },
      { code: "WOR-1", state: "failed" },
    ]);
    expect((await store.getAgentRunByTaskId(bitUmbrella.taskId))?.pullRequestUrls).toEqual([bitLanePrUrl]);
    expect((await store.getAgentRunByTaskId(bit1.id))?.pullRequestUrls).toBeUndefined();
    expect((await getTask(bit1.id)).parentId).toBe(bitUmbrella.taskId);
    expect((await getTask(bit2.id)).parentId).toBe(bitUmbrella.taskId);
    expect((await getTask(bit3.id)).parentId).toBe(bitUmbrella.taskId);

    // 9. Explicitly retry failed WOR-1 on the next level up (`strong`), open WOR's single-task lane PR, and finish the queue.
    const retryRes = await postJson(`/api/work-queue-items/${worFailedEntry.id}/retry`, { level: "strong" });
    expect(retryRes.status).toBe(201);
    const retriedEntry = await retryRes.json<QueueEntryResponse>();
    expect(retriedEntry.resolvedSelection).toMatchObject(STRONG_SELECTION);

    const worRetryLaunch = host.launches.at(-1);
    const worRetryRun = await store.getAgentRunByTaskId(wor1.id);
    if (!worRetryLaunch || !worRetryRun) throw new Error("Expected WOR-1 retry launch and run");
    expect(worRetryLaunch.threadId).not.toBe(worFirstLaunch.threadId);
    expect(worRetryLaunch.launchArgs.clientRequestId).toBe(`wq:${retriedEntry.id}`);
    expect(worRetryLaunch.launchArgs.modelSelection).toMatchObject({
      instanceId: STRONG_SELECTION.providerInstanceId,
      model: STRONG_SELECTION.model,
    });

    const worLanePrUrl = "https://github.com/acme/workouse/pull/7";
    expect(
      (
        await callMcp("report_t3_git_metadata", {
          taskId: "WOR-1",
          runId: worRetryRun.id,
          threadId: worRetryLaunch.threadId,
          metadata: {
            branch: "bitig/WOR-1",
            headSha: "8".repeat(40),
            worktreePath: "/tmp/worktrees/wor-1",
            dirty: false,
            pullRequestUrls: [worLanePrUrl],
          },
        })
      ).isError,
    ).toBeUndefined();
    expect((await callMcp("complete_task", { id: "WOR-1" })).isError).toBeUndefined();
    host.finishThread(worRetryLaunch.threadId);
    expect((await request("/api/t3/runs")).status).toBe(200);

    // Retry history is preserved (`WOR-1: failed` + `WOR-1: done`) and WOR-1 holds its single-task PR.
    // The failed row is an earlier attempt, so it no longer keeps the queue open.
    expect(await getQueues(false)).toEqual([]);
    const [queueAfterRetryDone] = await getQueues(true);
    if (!queueAfterRetryDone) throw new Error("Expected queue with preserved failed attempt row");
    expect(queueAfterRetryDone.state).toBe("done");
    expect(queueAfterRetryDone.entries.map((entry) => ({ code: entry.taskCode, state: entry.state }))).toEqual([
      { code: "BIT-1", state: "done" },
      { code: "BIT-2", state: "done" },
      { code: "BIT-3", state: "done" },
      { code: "WOR-1", state: "failed" },
      { code: "WOR-1", state: "done" },
    ]);
    expect((await store.getAgentRunByTaskId(wor1.id))?.pullRequestUrls).toEqual([worLanePrUrl]);
  }, 60_000);

  it("enforces maxParallelRuns across lanes and lets a single-task lane ship its PR even when the multi-task umbrella lane hits a failure", async () => {
    await queueStore.setHostMaxParallelRuns(HOST_ID, 2);

    const bitProject = await createMappedProject("Bitig", "BIT");
    const worProject = await createMappedProject("Workouse", "WOR");

    const bit1 = await createTask(bitProject.id, "Schema validation", { order: 1 });
    const bit2 = await createTask(bitProject.id, "Worker endpoint", { order: 2 });
    const wor1 = await createTask(worProject.id, "Landing copy fix", { order: 1 });

    await store.saveTaskRunProfile({
      taskId: bit1.id,
      level: "standard",
      touches: ["packages/core/src/**"],
      parallelSafe: true,
      source: "agent",
    });
    await store.saveTaskRunProfile({
      taskId: bit2.id,
      level: "standard",
      touches: ["apps/worker/src/**"],
      parallelSafe: true,
      source: "agent",
    });
    await store.saveTaskRunProfile({
      taskId: wor1.id,
      level: "cheap",
      touches: ["src/pages/**"],
      parallelSafe: true,
      source: "agent",
    });

    const confirmRes = await postJson("/api/work-queue", {
      prompt: "BIT-1, BIT-2 and WOR-1",
      items: ["BIT-1", "BIT-2", "WOR-1"],
      approvals: [],
      overrides: [],
    });
    expect(confirmRes.status).toBe(201);
    const confirmed = await confirmRes.json<ConfirmResponse>();
    const bitUmbrella = confirmed.umbrellas[0];
    if (!bitUmbrella) throw new Error("Expected BIT queue umbrella");

    // Both host slots (cap = 2) are now occupied by BIT-3 (umbrella) and WOR-1 (single-task lane).
    expect(host.launches).toHaveLength(2);
    const umbrellaLaunch = host.launches.find((launch) => launch.projectId === "t3-bit");
    const worLaunch = host.launches.find((launch) => launch.projectId === "t3-wor");
    const umbrellaRun = await store.getAgentRunByTaskId(bitUmbrella.taskId);
    if (!umbrellaLaunch || !worLaunch || !umbrellaRun) throw new Error("Expected BIT-3 and WOR-1 runs");

    await callMcp("report_t3_git_metadata", {
      taskId: "BIT-3",
      runId: umbrellaRun.id,
      threadId: umbrellaLaunch.threadId,
      metadata: {
        branch: "bitig/BIT-3",
        headSha: "a".repeat(40),
        worktreePath: "/tmp/worktrees/bit-3",
        dirty: false,
      },
    });

    // A child's own umbrella hands it its slot, so lower the cap to 1: WOR-1 alone fills the host
    // and starting children hits `cap_reached`.
    await queueStore.setHostMaxParallelRuns(HOST_ID, 1);
    const cappedBatchRes = await callMcp("start_ready_children", { parentTaskId: "BIT-3" });
    expect(cappedBatchRes.isError).toBeUndefined();
    const cappedBatch = JSON.parse(cappedBatchRes.text) as StartReadyChildrenResult;
    expect(cappedBatch.started).toEqual([]);
    expect(cappedBatch.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ taskId: bit1.id, reason: "cap_reached" })]),
    );

    // Pause BIT-3 (`needsHuman`) due to a lane blocker -> WOR-1 is completely unaffected, opens its PR, and moves to `done`.
    expect(
      (await callMcp("update_task", { id: "BIT-3", needsHuman: "Merge conflict in worker routes" })).isError,
    ).toBeUndefined();

    const worRun = await store.getAgentRunByTaskId(wor1.id);
    if (!worRun) throw new Error("Expected WOR-1 run");
    const worPrUrl = "https://github.com/acme/workouse/pull/19";
    await callMcp("report_t3_git_metadata", {
      taskId: "WOR-1",
      runId: worRun.id,
      threadId: worLaunch.threadId,
      metadata: {
        branch: "bitig/WOR-1",
        headSha: "b".repeat(40),
        worktreePath: "/tmp/worktrees/wor-1",
        dirty: false,
        pullRequestUrls: [worPrUrl],
      },
    });
    expect((await callMcp("complete_task", { id: "WOR-1" })).isError).toBeUndefined();
    host.finishThread(worLaunch.threadId);
    expect((await request("/api/t3/runs")).status).toBe(200);

    const [openQueue] = await getQueues();
    if (!openQueue) throw new Error("Expected queue to remain active while BIT lane waits on human");
    expect(openQueue.entries.map((entry) => ({ code: entry.taskCode, state: entry.state }))).toEqual([
      { code: "BIT-1", state: "waiting" },
      { code: "BIT-2", state: "waiting" },
      { code: "WOR-1", state: "done" },
    ]);
    expect(openQueue.entries[0]?.waitingReason).toContain("Lane paused: Merge conflict in worker routes");
    expect((await store.getAgentRunByTaskId(wor1.id))?.pullRequestUrls).toEqual([worPrUrl]);

    // Stop the paused umbrella run and skip unstarted BIT-1 and BIT-2: they detach from BIT-3 and the queue closes as `done`.
    host.finishThread(umbrellaLaunch.threadId);
    expect((await request("/api/t3/runs")).status).toBe(200);
    const bit1Entry = openQueue.entries.find((entry) => entry.taskCode === "BIT-1");
    const bit2Entry = openQueue.entries.find((entry) => entry.taskCode === "BIT-2");
    if (!bit1Entry || !bit2Entry) throw new Error("Expected BIT-1 and BIT-2 entries");
    expect((await postJson(`/api/work-queue-items/${bit1Entry.id}/skip`)).status).toBe(200);
    expect((await postJson(`/api/work-queue-items/${bit2Entry.id}/skip`)).status).toBe(200);

    expect((await getTask(bit1.id)).parentId).toBeUndefined();
    expect((await getTask(bit2.id)).parentId).toBeUndefined();
    expect(await getQueues(false)).toEqual([]);
    const [doneQueue] = await getQueues(true);
    expect(doneQueue?.state).toBe("done");
  }, 60_000);
});
