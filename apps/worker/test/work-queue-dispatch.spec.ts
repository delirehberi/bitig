import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORGANISATION_ID, RealtimeEventSchema, defaultIdGenerator, type RealtimeEvent, type Task, type WorkQueueEntry } from "@bitig/core";
import { D1Storage, D1WorkQueueStore, T3D1Store } from "@bitig/storage-d1";
import { encryptT3Token } from "../src/t3/crypto";
import { dispatchQueuedTaskT3Run, launchTaskInT3, reportChildMerge, startReadyChildrenInT3, type T3ServiceDeps } from "../src/t3/service";
import { shouldDispatchWorkQueuesAfter } from "../src/background";
import {
  checkWorkQueueLaunch,
  dispatchWorkQueues,
  hasWorkQueuesNeedingDispatch,
  recordWorkQueueFailure,
  reserveWorkQueueLaunch,
} from "../src/work-queue/dispatcher";
import { TEST_T3_ENCRYPTION_KEY } from "./constants";

// Mirror the worker integration schema, including the queue migration.
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

const HOST_ID = "queue-host";
const SECOND_HOST_ID = "other-host";
const TEST_TOKEN = "queue-test-token";
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 16, 12);
const SELECTION = { providerInstanceId: "test-provider", model: "test-model" };

interface ToolCall { name: string; args: Record<string, unknown> }

describe("Work queue dispatcher (BIT-203)", () => {
  let store: T3D1Store;
  let queues: D1WorkQueueStore;
  let storage: D1Storage;
  let deps: T3ServiceDeps;
  let calls: ToolCall[];
  let events: RealtimeEvent[];
  let offline: boolean;
  let launchError: string | undefined;
  let tick: number;

  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
    store = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    queues = new D1WorkQueueStore(env.DB, DEFAULT_ORGANISATION_ID);
    storage = new D1Storage({ db: env.DB, bucket: env.ATTACHMENTS, orgId: DEFAULT_ORGANISATION_ID });
    calls = [];
    events = [];
    offline = false;
    launchError = undefined;
    tick = NOW;
    const fetchFn: typeof fetch = async (input, init) => {
      if (offline) throw new Error("Test host offline");
      const request = new Request(input, init);
      if (request.method === "DELETE") return new Response(null, { status: 204 });
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const body = await request.json<{ id?: number | string; method: string; params?: { name: string; arguments: Record<string, unknown> } }>();
      const headers = { "mcp-session-id": "queue-test-session" };
      if (body.method === "notifications/initialized") return new Response(null, { status: 202, headers });
      if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "queue-test", version: "1" },
      } }, { headers });
      const name = body.params?.name ?? "";
      const args = body.params?.arguments ?? {};
      calls.push({ name, args });
      if (name === "t3_thread_launch" && launchError) return Response.json({ jsonrpc: "2.0", id: body.id,
        result: { isError: true, content: [{ type: "text", text: launchError }] } }, { headers });
      const payload = name === "t3_thread_launch"
        ? { threadId: `thread-${String(calls.length)}`, link: `https://t3.test/threads/${String(calls.length)}` }
        : name === "orchestrator_capabilities"
          ? { providers: [{ providerInstanceId: SELECTION.providerInstanceId, driverKind: "codex", canRunChildTask: true, models: [{ id: SELECTION.model }] }] }
          : { ok: true, threads: [] };
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }, { headers });
    };
    deps = {
      store, storage, encryptionKey: TEST_T3_ENCRYPTION_KEY, fetchFn,
      now: () => tick, workQueue: { db: env.DB, orgId: DEFAULT_ORGANISATION_ID },
      dispatchingWorkQueue: true,
      publishRealtime: (event) => { events.push(RealtimeEventSchema.parse(event)); return Promise.resolve(); },
    };
    await host(HOST_ID);
  });

  async function host(id: string): Promise<void> {
    const encrypted = await encryptT3Token(TEST_TOKEN, TEST_T3_ENCRYPTION_KEY);
    await store.saveConnection({ id, orgId: DEFAULT_ORGANISATION_ID, mcpUrl: `https://${id}.test/mcp`, issuer: `https://${id}.test`,
      clientId: "test", encryptedAccessToken: encrypted.ciphertext, tokenIv: encrypted.iv, scope: "mcp:tools", expiresAt: NOW + HOUR_MS, now: NOW });
  }

  async function task(key: string, hostId = HOST_ID): Promise<Task> {
    const project = await storage.createProject({ name: key, key });
    await store.upsertProjectMapping({ projectId: project.id, hostId, t3ProjectId: `project-${key}`, t3ProjectTitle: key });
    return storage.saveTask({ projectId: project.id, title: `${key} task` });
  }

  async function queue(tasks: Task[], umbrellaTaskId?: string): Promise<{ id: string; entries: WorkQueueEntry[] }> {
    const created = await queues.createQueue({ id: defaultIdGenerator(), prompt: "test queue", createdBy: "test", now: tick });
    const entries: WorkQueueEntry[] = [];
    for (const [position, candidate] of tasks.entries()) {
      entries.push(await queues.addEntry({ id: defaultIdGenerator(), queueId: created.id, taskId: candidate.id, lane: candidate.projectId,
        position, resolvedSelection: SELECTION, umbrellaTaskId: umbrellaTaskId ?? null, now: tick }));
    }
    await queues.transitionQueue(created.id, "active", tick);
    return { id: created.id, entries };
  }

  async function dispatch(): Promise<void> { await dispatchWorkQueues({ db: env.DB, orgId: DEFAULT_ORGANISATION_ID, t3: deps }); }
  function launches(): ToolCall[] { return calls.filter((call) => call.name === "t3_thread_launch"); }

  it("starts cross-project lanes in worktrees and delivers stable idempotency keys", async () => {
    const first = await task("ONE");
    const second = await task("TWO");
    const queued = await queue([first, second]);
    await dispatch();
    expect(launches()).toHaveLength(2);
    expect(launches().map((call) => call.args.clientRequestId)).toEqual(queued.entries.map((entry) => `wq:${entry.id}`));
    expect(launches().map((call) => call.args.workspaceStrategy)).toEqual([
      { type: "worktree", baseRef: "HEAD", branch: "bitig/ONE-1" },
      { type: "worktree", baseRef: "HEAD", branch: "bitig/TWO-1" },
    ]);
    await dispatch();
    expect(launches()).toHaveLength(2);
    expect((await queues.listEntries(queued.id)).map((entry) => entry.state)).toEqual(["running", "running"]);
    expect(events.some((event) => event.type === "work_queue_item.updated")).toBe(true);
  });

  it("reserves the last host slot atomically across concurrent dispatchers", async () => {
    await queues.setHostMaxParallelRuns(HOST_ID, 1);
    const first = await task("ONE");
    const second = await task("TWO");
    await queue([first, second]);
    await Promise.all([dispatch(), dispatch()]);
    expect(launches()).toHaveLength(1);
    expect((await store.listAgentRuns()).filter((run) => run.state === "working")).toHaveLength(1);
  });

  it("counts non-queue runs against the host cap and isolates other hosts", async () => {
    await queues.setHostMaxParallelRuns(HOST_ID, 1);
    const outside = await task("EXT");
    await store.saveAgentRun({ id: defaultIdGenerator(), taskId: outside.id, hostId: HOST_ID, t3ProjectId: "external",
      threadId: "external", state: "working", startedAt: tick, updatedAt: tick });
    const held = await task("ONE");
    await host(SECOND_HOST_ID);
    const free = await task("TWO", SECOND_HOST_ID);
    const queued = await queue([held, free]);
    await dispatch();
    expect(launches()).toHaveLength(1);
    expect((await queues.listEntries(queued.id))[0]?.waitingReason).toContain("cap");
    await store.updateAgentRunState(outside.id, { state: "finished", now: ++tick });
    await dispatch();
    expect(launches()).toHaveLength(2);
  });

  it("waits for dependencies and completes a successful single-task lane", async () => {
    const dependency = await task("DEP");
    const dependent = await task("NEXT");
    await storage.updateTask(dependent.id, { dependsOn: [dependency.id] });
    const queued = await queue([dependency, dependent]);
    await dispatch();
    expect(launches()).toHaveLength(1);
    await storage.completeTask(dependency.id);
    await store.updateAgentRunState(dependency.id, { state: "finished", now: ++tick });
    await dispatch();
    expect(launches()).toHaveLength(2);
    expect((await queues.listEntries(queued.id))[0]?.state).toBe("done");
  });

  it("launches only the umbrella and requires a reported merge for its dependents", async () => {
    const parent = await task("UMB");
    const first = await storage.saveTask({ projectId: parent.projectId, title: "first", parentId: parent.id });
    const second = await storage.saveTask({ projectId: parent.projectId, title: "second", parentId: parent.id, dependsOn: [first.id] });
    const queued = await queue([first, second], parent.id);
    await dispatch();
    expect(launches()).toHaveLength(1);
    expect((await store.getAgentRunByTaskId(parent.id))?.state).toBe("working");
    expect(await store.getAgentRunByTaskId(first.id)).toBeUndefined();
    await storage.completeTask(first.id);
    await store.addAgentRunChild({ parentTaskId: parent.id, childTaskId: first.id, state: "done", startedAt: tick });
    await expect(checkWorkQueueLaunch(deps, second.id)).rejects.toThrow("merged");
    await reportChildMerge(deps, { parentTaskId: parent.id, childTaskId: first.id, mergedSha: "a".repeat(40) });
    await expect(checkWorkQueueLaunch(deps, second.id)).resolves.toBeDefined();
    expect((await queues.listEntries(queued.id))[1]?.state).toBe("waiting");
  });

  it("starts the next batch for an idle queue umbrella whose own child start hit the host cap", async () => {
    await queues.setHostMaxParallelRuns(HOST_ID, 2);
    const parent = await task("UMB");
    const first = await storage.saveTask({ projectId: parent.projectId, title: "first", parentId: parent.id });
    const second = await storage.saveTask({ projectId: parent.projectId, title: "second", parentId: parent.id, dependsOn: [first.id] });
    const queued = await queue([first, second], parent.id);
    await dispatch();
    const umbrellaRun = await store.getAgentRunByTaskId(parent.id);
    if (!umbrellaRun) throw new Error("Expected umbrella run");
    await store.updateAgentRunGitMetadata(parent.id, umbrellaRun.id, umbrellaRun.threadId,
      { branch: "bitig/UMB-1", headSha: "a".repeat(40), worktreePath: "/tmp/umb", dirty: false }, ++tick);
    await storage.completeTask(first.id);
    await store.addAgentRunChild({ parentTaskId: parent.id, childTaskId: first.id, state: "done", startedAt: tick });
    await reportChildMerge(deps, { parentTaskId: parent.id, childTaskId: first.id, mergedSha: "a".repeat(40) });
    // Two unrelated sessions fill the host while the umbrella merges, so its own start is held.
    const outsiders: Task[] = [];
    for (const key of ["EXA", "EXB"]) {
      const outside = await task(key);
      outsiders.push(outside);
      await store.saveAgentRun({ id: defaultIdGenerator(), taskId: outside.id, hostId: HOST_ID, t3ProjectId: key,
        threadId: key, state: "working", startedAt: tick, updatedAt: tick });
    }
    await dispatch();
    expect(launches()).toHaveLength(1);
    // The umbrella ends its turn; one outside session finishes. Nothing but the dispatcher is left to start the child.
    await store.updateAgentRunState(parent.id, { state: "finished", now: ++tick });
    await store.updateAgentRunState(outsiders[0]?.id ?? "", { state: "finished", now: ++tick });
    await dispatch();
    expect(launches()).toHaveLength(2);
    expect(launches()[1]?.args.workspaceStrategy).toMatchObject({ branch: expect.stringContaining("bitig/") as unknown });
    expect((await store.getAgentRunChild(parent.id, second.id))?.state).toBe("running");
    expect((await store.getAgentRunByTaskId(parent.id))?.state).toBe("waiting_subagent");
    expect((await queues.listEntries(queued.id))[1]?.state).toBe("running");
    await dispatch();
    expect(launches()).toHaveLength(2);
  });

  it("does not count a waiting umbrella or a child's own umbrella against the host cap", async () => {
    await queues.setHostMaxParallelRuns(HOST_ID, 1);
    const parent = await task("UMB");
    const child = await storage.saveTask({ projectId: parent.projectId, title: "child", parentId: parent.id });
    await queue([child], parent.id);
    await dispatch();
    const umbrellaRun = await store.getAgentRunByTaskId(parent.id);
    if (!umbrellaRun) throw new Error("Expected umbrella run");
    await store.updateAgentRunGitMetadata(parent.id, umbrellaRun.id, umbrellaRun.threadId,
      { branch: "bitig/UMB-1", headSha: "a".repeat(40), worktreePath: "/tmp/umb", dirty: false }, ++tick);
    // The working umbrella fills the only slot, yet its own child may take it.
    const started = await launchTaskInT3(deps, { taskRef: child.id, parentTaskRef: parent.id, workspaceStrategy: "worktree" });
    expect(started.run.state).toBe("working");
    expect((await store.getAgentRunByTaskId(parent.id))?.state).toBe("waiting_subagent");
  });

  it("persists offline launches as ready and drains exactly once after reconnection", async () => {
    const candidate = await task("OFF");
    const queued = await queue([candidate]);
    offline = true;
    await dispatch();
    expect((await store.getAgentRunByTaskId(candidate.id))?.state).toBe("queued");
    expect((await queues.listEntries(queued.id))[0]?.state).toBe("ready");
    await dispatch();
    offline = false;
    await dispatchQueuedTaskT3Run(deps, candidate.id);
    await dispatchQueuedTaskT3Run(deps, candidate.id);
    expect(launches()).toHaveLength(1);
  });

  it("does not deliver an offline launch while paused; resumes without a duplicate", async () => {
    const candidate = await task("PAU");
    const queued = await queue([candidate]);
    offline = true;
    await dispatch();
    await queues.transitionQueue(queued.id, "paused", ++tick);
    offline = false;
    await dispatchQueuedTaskT3Run(deps, candidate.id);
    expect(launches()).toHaveLength(0);
    await queues.transitionQueue(queued.id, "active", ++tick);
    await dispatchQueuedTaskT3Run(deps, candidate.id);
    expect(launches()).toHaveLength(1);
  });

  it("isolates failures, leaves dependents waiting, and allows an explicit fresh retry", async () => {
    const failed = await task("BAD");
    const waiting = await task("WAIT");
    const unrelated = await task("GOOD");
    await storage.updateTask(waiting.id, { dependsOn: [failed.id] });
    const queued = await queue([failed, waiting, unrelated]);
    await dispatch();
    await store.updateAgentRunState(failed.id, { state: "failed", now: ++tick });
    await dispatch();
    expect((await queues.listEntries(queued.id)).map((entry) => entry.state)).toEqual(["failed", "waiting", "running"]);
    const retry = await queues.addEntry({ id: defaultIdGenerator(), queueId: queued.id, taskId: failed.id, lane: failed.projectId, position: 3, now: ++tick });
    await dispatch();
    expect(launches().at(-1)?.args.clientRequestId).toBe(`wq:${retry.id}`);
  });

  it("keeps a session that paused mid-task running, not failed, and clears the pause when it resumes", async () => {
    const paused = await task("ASK");
    const queued = await queue([paused]);
    await dispatch();
    await store.updateAgentRunState(paused.id, { state: "finished", now: ++tick });
    await dispatch();
    let [entry] = await queues.listEntries(queued.id);
    expect(entry?.state).toBe("running");
    expect(entry?.waitingReason).toContain("Waiting on you");
    await store.updateAgentRunState(paused.id, { state: "working", now: ++tick });
    await dispatch();
    [entry] = await queues.listEntries(queued.id);
    expect(entry?.state).toBe("running");
    expect(entry?.waitingReason ?? null).toBeNull();
  });

  it("recovers a failed latest entry whose task was finished or whose session is working again", async () => {
    const done = await task("DONE");
    const revived = await task("BACK");
    const queued = await queue([done, revived]);
    await dispatch();
    for (const candidate of [done, revived]) await store.updateAgentRunState(candidate.id, { state: "failed", now: ++tick });
    await dispatch();
    expect((await queues.listEntries(queued.id)).map((entry) => entry.state)).toEqual(["failed", "failed"]);
    await storage.completeTask(done.id);
    await store.updateAgentRunState(revived.id, { state: "working", now: ++tick });
    await dispatch();
    const states = (await queues.listEntries(queued.id)).map((entry) => entry.state);
    expect(states[0]).toMatch(/merged|done/);
    expect(states[1]).toBe("running");
  });

  it("lets an umbrella stop waiting on a child session that paused mid-task", async () => {
    const parent = await task("UMB");
    const first = await storage.saveTask({ projectId: parent.projectId, title: "first", parentId: parent.id });
    const queued = await queue([first], parent.id);
    await dispatch();
    const umbrellaRun = await store.getAgentRunByTaskId(parent.id);
    if (!umbrellaRun) throw new Error("Expected umbrella run");
    await store.updateAgentRunGitMetadata(parent.id, umbrellaRun.id, umbrellaRun.threadId,
      { branch: "bitig/UMB-1", headSha: "a".repeat(40), worktreePath: "/tmp/umb", dirty: false }, ++tick);
    await store.updateAgentRunState(parent.id, { state: "finished", now: ++tick });
    await dispatch();
    expect((await store.getAgentRunChild(parent.id, first.id))?.state).toBe("running");
    // The child asks a question in a comment and ends its turn before its task is done.
    await storage.updateTask(first.id, { status: "in_progress" });
    await store.updateAgentRunState(first.id, { state: "finished", now: ++tick });
    await startReadyChildrenInT3(deps, { parentTaskRef: parent.id, actor: "test" });
    expect((await store.getAgentRunChild(parent.id, first.id))?.state).toBe("needs_human");
    await dispatch();
    const [entry] = await queues.listEntries(queued.id);
    expect(entry?.state).toBe("running");
    expect(entry?.waitingReason).toContain("Waiting on you");
  });

  it("finishes a queue whose failed attempt was retried after the task got done outside the queue", async () => {
    const parent = await task("UMB");
    const first = await storage.saveTask({ projectId: parent.projectId, title: "first", parentId: parent.id });
    const queued = await queue([first], parent.id);
    await dispatch();
    const [original] = await queues.listEntries(queued.id);
    if (!original) throw new Error("Expected an entry");
    await queues.transitionEntry(original.id, { to: "running", now: ++tick });
    await queues.transitionEntry(original.id, { to: "failed", waitingReason: "Run ended before the task was completed", now: ++tick });
    const retry = await queues.addEntry({ id: defaultIdGenerator(), queueId: queued.id, taskId: first.id, lane: first.projectId,
      position: 1, umbrellaTaskId: parent.id, now: ++tick });
    await queues.transitionEntry(retry.id, { to: "skipped", waitingReason: "Task is done", now: ++tick });
    // The child finished without a reported merge, and the umbrella task is done.
    await storage.completeTask(first.id);
    await storage.completeTask(parent.id);
    await dispatch();
    expect((await queues.listEntries(queued.id)).map((entry) => entry.state)).toEqual(["done", "skipped"]);
    expect((await queues.getQueue(queued.id))?.state).toBe("done");
  });

  it("delivers a person's comment to a session whose queue entry failed", async () => {
    const candidate = await task("MSG");
    const queued = await queue([candidate]);
    await dispatch();
    await store.updateAgentRunState(candidate.id, { state: "failed", now: ++tick });
    await dispatch();
    expect((await queues.listEntries(queued.id))[0]?.state).toBe("failed");
    await store.requests.enqueue({ id: defaultIdGenerator(), hostId: HOST_ID, taskId: candidate.id, kind: "message",
      payload: JSON.stringify({ hostId: HOST_ID, prompt: "approved, go ahead", clientRequestId: "c1:r1", taskLabel: "MSG-1" }), now: ++tick });
    await dispatchQueuedTaskT3Run(deps, candidate.id);
    expect(calls.some((call) => call.name === "t3_thread_send")).toBe(true);
  });

  it.each(["archived", "approval", "parent", "dependency"])("rechecks %s edits immediately before offline delivery", async (edit) => {
    const candidate = await task("EDIT");
    await queue([candidate]);
    offline = true;
    await dispatch();
    if (edit === "archived") await storage.updateTask(candidate.id, { status: "archived" });
    if (edit === "approval") await storage.updateTask(candidate.id, { pendingApproval: true });
    if (edit === "dependency") {
      const dependency = await task("DEP");
      await storage.updateTask(candidate.id, { dependsOn: [dependency.id] });
    }
    if (edit === "parent") {
      const parent = await storage.saveTask({ projectId: candidate.projectId, title: "new parent" });
      await storage.updateTask(candidate.id, { parentId: parent.id });
    }
    offline = false;
    await dispatchQueuedTaskT3Run(deps, candidate.id);
    expect(launches()).toHaveLength(0);
  });

  it("pauses a queue when T3 sign-in expires", async () => {
    const candidate = await task("EXP");
    const queued = await queue([candidate]);
    tick += HOUR_MS;
    await dispatch();
    expect((await queues.getQueue(queued.id))?.state).toBe("paused");
    expect(launches()).toHaveLength(0);
  });

  it("holds only the affected host on a usage limit, preserving its reset message", async () => {
    const limited = await task("LIMIT");
    const queued = await queue([limited]);
    await dispatch();
    const run = await store.getAgentRunByTaskId(limited.id);
    if (!run) throw new Error("Expected limited run");
    await recordWorkQueueFailure(deps, run, "Usage limit; resets at 18:00 UTC");
    await store.updateAgentRunState(limited.id, { state: "failed", now: ++tick });
    const sameHost = await task("HELD");
    await queue([sameHost]);
    await host(SECOND_HOST_ID);
    const otherHost = await task("FREE", SECOND_HOST_ID);
    await queue([otherHost]);
    await dispatch();
    expect(launches()).toHaveLength(2);
    expect((await queues.listEntries(queued.id))[0]?.waitingReason).toContain("18:00 UTC");
    expect(await store.getAgentRunByTaskId(sameHost.id)).toBeUndefined();
  });

  it("pauses only an umbrella lane needing human help", async () => {
    const parent = await task("UMB");
    const child = await storage.saveTask({ projectId: parent.projectId, parentId: parent.id, title: "child" });
    const other = await task("OTHER");
    await queue([child], parent.id);
    await queue([other]);
    await storage.updateTask(parent.id, { needsHuman: "merge conflict" });
    await dispatch();
    expect(launches()).toHaveLength(1);
    expect(await store.getAgentRunByTaskId(parent.id)).toBeUndefined();
  });

  it("cancels running work without deleting branches and detaches never-started children", async () => {
    const running = await task("RUN");
    const queued = await queue([running]);
    await dispatch();
    await queues.transitionQueue(queued.id, "cancelled", ++tick);
    await dispatch();
    expect((await store.getAgentRunByTaskId(running.id))?.state).toBe("stopped");
    expect((await queues.listEntries(queued.id))[0]?.state).toBe("cancelled");
    expect(calls.some((call) => call.name === "t3_thread_interrupt")).toBe(true);
    expect(calls.some((call) => /delete|remove/.test(call.name))).toBe(false);
    const parent = await task("UMB");
    const child = await storage.saveTask({ projectId: parent.projectId, title: "child", parentId: parent.id });
    const untouched = await queue([child], parent.id);
    await queues.transitionQueue(untouched.id, "cancelled", ++tick);
    await dispatch();
    expect((await storage.getTask(child.id))?.parentId).toBeUndefined();
  });

  it("recovers a slot reserved before a Worker interruption", async () => {
    const candidate = await task("REC");
    await queue([candidate]);
    const reservation = await reserveWorkQueueLaunch(deps, candidate.id);
    await dispatch();
    expect((await store.getAgentRunByTaskId(candidate.id))?.id).toBe(reservation?.runId);
    expect(launches()).toHaveLength(1);
  });

  it("stops a running queue umbrella after a REST cancel already closed every entry", async () => {
    const parent = await task("UMB");
    const first = await storage.saveTask({ projectId: parent.projectId, title: "first", parentId: parent.id });
    const second = await storage.saveTask({ projectId: parent.projectId, title: "second", parentId: parent.id });
    const queued = await queue([first, second], parent.id);
    await dispatch();
    expect((await store.getAgentRunByTaskId(parent.id))?.state).toBe("working");
    // The REST cancel route cancels unstarted entries itself and leaves running work to the dispatcher.
    await queues.transitionQueue(queued.id, "cancelled", ++tick);
    for (const entry of await queues.listEntries(queued.id)) {
      await queues.transitionEntry(entry.id, { to: "cancelled", waitingReason: "Queue cancelled", now: tick });
    }
    expect(await hasWorkQueuesNeedingDispatch({ db: env.DB, orgId: DEFAULT_ORGANISATION_ID })).toBe(true);
    await dispatch();
    expect((await store.getAgentRunByTaskId(parent.id))?.state).toBe("stopped");
    expect(await hasWorkQueuesNeedingDispatch({ db: env.DB, orgId: DEFAULT_ORGANISATION_ID })).toBe(false);
  });

  it("releases a stale reservation so it no longer holds the host slot", async () => {
    await queues.setHostMaxParallelRuns(HOST_ID, 1);
    const abandoned = await task("ABN");
    const abandonedQueue = await queue([abandoned]);
    await reserveWorkQueueLaunch(deps, abandoned.id);
    const [entry] = await queues.listEntries(abandonedQueue.id);
    if (!entry) throw new Error("Expected an entry");
    await queues.transitionEntry(entry.id, { to: "skipped", waitingReason: "Skipped by a person", now: tick });
    const next = await task("NEXT");
    await queue([next]);
    await dispatch();
    expect(launches()).toHaveLength(0);
    tick += 11 * 60 * 1000;
    await dispatch();
    expect((await store.getAgentRunByTaskId(abandoned.id))?.state).toBe("failed");
    expect(launches()).toHaveLength(1);
    expect((await store.getAgentRunByTaskId(next.id))?.state).toBe("working");
  });

  it("dispatches after mutating, successful API and MCP requests only", () => {
    expect(shouldDispatchWorkQueuesAfter("POST", "/api/work-queue", 201)).toBe(true);
    expect(shouldDispatchWorkQueuesAfter("POST", "/mcp", 200)).toBe(true);
    expect(shouldDispatchWorkQueuesAfter("GET", "/api/work-queues", 200)).toBe(false);
    expect(shouldDispatchWorkQueuesAfter("POST", "/api/work-queue", 409)).toBe(false);
    expect(shouldDispatchWorkQueuesAfter("POST", "/f/form", 200)).toBe(false);
  });

  it("honours queue gates even when a caller launches directly", async () => {
    const candidate = await task("DIRECT");
    const queued = await queue([candidate]);
    await queues.transitionQueue(queued.id, "paused", ++tick);
    await expect(launchTaskInT3(deps, { taskRef: candidate.id })).rejects.toThrow("paused");
    expect(launches()).toHaveLength(0);
  });
});
