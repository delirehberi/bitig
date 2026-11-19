import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORGANISATION_ID, defaultIdGenerator, type Project, type Task } from "@bitig/core";
import { D1WorkQueueStore, T3D1Store } from "@bitig/storage-d1";
import { createApp } from "../src/index";
import { encryptT3Token } from "../src/t3/crypto";
import { TEST_AUTH_HEADER, TEST_T3_ENCRYPTION_KEY } from "./constants";

const BASE_URL = "https://bitig.test";

/** Same schema the other worker specs set up, plus the work queue tables (migration 0030). */
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
    \`elapsed_ms\` integer,
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

const ROUTER_BASE_URL = "https://router.example.test/accounts/acc/ai/run";
const ROUTER_MODEL = "@cf/test/router-model";
const ROUTER_TOKEN = "work-queue-router-token";
const PARSE_PROMPT_MARKER = "work queue items";
const OTHER_ORG_ID = "01a10000-0000-7000-8000-000000000099";
const CHEAP_SELECTION = { providerInstanceId: "prov-a", model: "model-cheap" };
const STANDARD_SELECTION = { providerInstanceId: "prov-a", model: "model-standard" };
const STRONG_SELECTION = { providerInstanceId: "prov-a", model: "model-strong" };

interface RouterMock {
  profile: () => Response;
  parse: () => Response;
  profileCalls: number;
  parseCalls: number;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function profileAnswer(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    success: true,
    result: {
      response: {
        level: "standard",
        effort: "high",
        touches: ["packages/core/src/**"],
        parallelSafe: true,
        reason: "Scoped change in core.",
        confidence: 0.9,
        ...overrides,
      },
    },
  });
}

/** Stands in for the organisation's AI router: one endpoint serves both the parse and the profile calls. */
function createRouterFetch(mock: RouterMock): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(ROUTER_BASE_URL)) {
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes(PARSE_PROMPT_MARKER)) {
      mock.parseCalls += 1;
      return Promise.resolve(mock.parse());
    }
    mock.profileCalls += 1;
    return Promise.resolve(mock.profile());
  };
}

interface PlanRow {
  code: string;
  classification: string;
  queueable: boolean;
  taskId?: string;
  related?: string[];
  run?: {
    level: string | null;
    model: string | null;
    effort: string | null;
    source: string;
    note?: string;
  };
}

interface PlanBody {
  parse: {
    items: { code: string }[];
    unknownKeys: { key: string; suggestions: string[] }[];
    warnings: string[];
    fallback: string;
  };
  rows: PlanRow[];
  lanes: { projectKey: string; needsQueueUmbrella: boolean; codes: string[]; waves: { number: number; codes: string[] }[] }[];
  routing: { enabled: boolean; attempted: number; failed: number };
}

interface QueueBody {
  id: string;
  state: string;
  prompt: string;
  createdBy: string;
  entries: {
    id: string;
    taskId: string;
    taskCode?: string;
    position: number;
    lane: string;
    state: string;
    umbrellaTaskId: string | null;
    resolvedSelection: { providerInstanceId: string; model: string } | null;
  }[];
}

interface ConfirmBody {
  queue: QueueBody;
  umbrellas: { projectId: string; taskId: string; code?: string; title: string; children: string[] }[];
  approved: string[];
  plan: PlanBody;
}

describe("Work queue REST routes (BIT-202)", () => {
  let app: ReturnType<typeof createApp>;
  let router: RouterMock;
  let store: T3D1Store;

  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
    router = {
      profile: () => profileAnswer(),
      parse: () => jsonResponse({ success: true, result: { response: JSON.stringify({ codes: [], ranges: [] }) } }),
      profileCalls: 0,
      parseCalls: 0,
    };
    app = createApp({ t3Fetch: createRouterFetch(router) });
    store = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
  });

  function request(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    if (!headers.has("Authorization")) headers.set("Authorization", TEST_AUTH_HEADER);
    return Promise.resolve(app.request(`${BASE_URL}${path}`, { ...init, headers }, env));
  }

  function post(path: string, body?: unknown): Promise<Response> {
    return request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async function createProject(name: string, key: string, options: { connected?: boolean } = {}): Promise<Project> {
    const response = await post("/api/projects", { name, key });
    expect(response.status).toBe(201);
    const project = await response.json<Project>();
    if (options.connected !== false) {
      await store.upsertProjectMapping({
        projectId: project.id,
        hostId: null,
        t3ProjectId: `t3-${key.toLowerCase()}`,
        t3ProjectTitle: name,
      });
    }
    return project;
  }

  async function createTask(projectId: string, title: string, extra: Record<string, unknown> = {}): Promise<Task> {
    const response = await post("/api/tasks", { projectId, title, ...extra });
    expect(response.status).toBe(201);
    return await response.json<Task>();
  }

  async function getTask(id: string): Promise<Task> {
    return await (await request(`/api/tasks/${id}`)).json<Task>();
  }

  async function mapLevelModels(): Promise<void> {
    await store.setRunLevelModel({ levelKey: "cheap", hostId: null, selection: CHEAP_SELECTION });
    await store.setRunLevelModel({ levelKey: "standard", hostId: null, selection: STANDARD_SELECTION });
    await store.setRunLevelModel({ levelKey: "strong", hostId: null, selection: STRONG_SELECTION });
  }

  async function enableRouter(): Promise<void> {
    const encrypted = await encryptT3Token(ROUTER_TOKEN, TEST_T3_ENCRYPTION_KEY);
    await store.saveAiRouterSettings({
      baseUrl: ROUTER_BASE_URL,
      model: ROUTER_MODEL,
      apiStyle: "cloudflare-run",
      encryptedApiToken: encrypted.ciphertext,
      tokenIv: encrypted.iv,
      tokenLast4: ROUTER_TOKEN.slice(-4),
      enabled: true,
    });
  }

  function rowOf(rows: readonly PlanRow[], code: string): PlanRow {
    const row = rows.find((candidate) => candidate.code === code);
    if (!row) throw new Error(`Expected a plan row for ${code}`);
    return row;
  }

  async function listQueues(query = ""): Promise<QueueBody[]> {
    const response = await request(`/api/work-queues${query}`);
    expect(response.status).toBe(200);
    return await response.json<QueueBody[]>();
  }

  describe("POST /api/work-queue/plan", () => {
    it("resolves codes across projects, reports unknown keys and routes unprofiled tasks", async () => {
      await mapLevelModels();
      await enableRouter();
      const bit = await createProject("Bitig", "BIT");
      const web = await createProject("Website", "WEB", { connected: false });
      const first = await createTask(bit.id, "First");
      const second = await createTask(bit.id, "Second", { dependsOn: [first.id] });
      const pending = await createTask(bit.id, "Pending", { pendingApproval: true });
      const finished = await createTask(bit.id, "Finished", { status: "done" });
      await createTask(web.id, "Unmapped project task");
      await store.saveTaskRunProfile({
        taskId: first.id,
        level: "strong",
        touches: ["apps/web/src/**"],
        source: "manual",
      });

      const response = await post("/api/work-queue/plan", {
        prompt: "Start BIT-1 to BIT-5, WEB-1 and KOM-3",
      });

      expect(response.status).toBe(200);
      const plan = await response.json<PlanBody>();
      expect(plan.parse.items.map((item) => item.code)).toEqual(["BIT-1", "BIT-2", "BIT-3", "BIT-4", "BIT-5", "WEB-1"]);
      expect(plan.parse.unknownKeys.map((unknown) => unknown.key)).toEqual(["KOM"]);
      expect(plan.rows.map((row) => [row.code, row.classification])).toEqual([
        ["BIT-1", "ready"],
        ["BIT-2", "after_queued_task"],
        ["BIT-3", "needs_approval"],
        ["BIT-4", "done"],
        ["BIT-5", "not_found"],
        ["WEB-1", "project_not_connected"],
      ]);
      expect(rowOf(plan.rows, "BIT-2").related).toEqual(["BIT-1"]);
      expect(rowOf(plan.rows, "BIT-3").queueable).toBe(false);
      expect(rowOf(plan.rows, "BIT-4").run).toBeUndefined();

      // The manual profile is kept; only the two unprofiled tasks are routed.
      expect(plan.routing).toEqual({ enabled: true, attempted: 2, failed: 0 });
      expect(router.profileCalls).toBe(2);
      expect(rowOf(plan.rows, "BIT-1").run).toMatchObject({ level: "strong", model: "model-strong", source: "manual" });
      expect(rowOf(plan.rows, "BIT-2").run).toMatchObject({
        level: "standard",
        model: "model-standard",
        effort: "high",
        source: "router",
      });
      expect(rowOf(plan.rows, "BIT-2").run?.note).toBeUndefined();
      expect((await store.getTaskRunProfile(first.id))?.source).toBe("manual");
      expect(await store.getTaskRunProfile(second.id)).toMatchObject({ source: "router", level: "standard" });
      expect(await store.getTaskRunProfile(pending.id)).toMatchObject({ source: "router" });
      expect(await store.getTaskRunProfile(finished.id)).toBeUndefined();

      expect(plan.lanes).toHaveLength(1);
      expect(plan.lanes[0]).toMatchObject({ projectKey: "BIT", needsQueueUmbrella: true });
      expect(plan.lanes[0]?.waves[0]?.codes).toContain("BIT-1");
      expect(plan.lanes[0]?.waves[0]?.codes).not.toContain("BIT-2");

      // Planning writes nothing but router profiles.
      expect(await listQueues("?all=true")).toEqual([]);
      expect((await getTask(pending.id)).pendingApproval).toBe(true);
      expect((await getTask(second.id)).parentId).toBeUndefined();
    });

    it("falls back to the project default level, else the lowest level, when the router fails", async () => {
      await mapLevelModels();
      await enableRouter();
      router.profile = () => new Response("upstream down", { status: 500 });
      const bit = await createProject("Bitig", "BIT");
      const web = await createProject("Website", "WEB");
      await store.upsertProjectRunSettings(bit.id, { defaultRunLevel: "standard" });
      const withDefault = await createTask(bit.id, "Project default");
      const lowest = await createTask(web.id, "Lowest level");

      const response = await post("/api/work-queue/plan", { prompt: "BIT-1, WEB-1" });

      expect(response.status).toBe(200);
      const plan = await response.json<PlanBody>();
      expect(plan.routing).toEqual({ enabled: true, attempted: 2, failed: 2 });
      expect(rowOf(plan.rows, "BIT-1").run).toMatchObject({
        level: "standard",
        model: "model-standard",
        source: "default",
        note: "default, not routed",
      });
      expect(rowOf(plan.rows, "WEB-1").run).toMatchObject({
        level: "cheap",
        model: "model-cheap",
        source: "default",
        note: "default, not routed",
      });
      expect(rowOf(plan.rows, "BIT-1").queueable).toBe(true);
      expect(await store.getTaskRunProfile(withDefault.id)).toBeUndefined();
      expect(await store.getTaskRunProfile(lowest.id)).toBeUndefined();
    });

    it("plans without the router when it is not configured and never calls it", async () => {
      const bit = await createProject("Bitig", "BIT");
      await createTask(bit.id, "Only task");

      const response = await post("/api/work-queue/plan", { prompt: "BIT-1 and the header fixes" });

      const plan = await response.json<PlanBody>();
      expect(plan.routing).toEqual({ enabled: false, attempted: 0, failed: 0 });
      expect(plan.parse.fallback).toBe("router_unavailable");
      expect(plan.parse.warnings.join(" ")).toContain("AI parse fallback skipped");
      expect(rowOf(plan.rows, "BIT-1").run).toMatchObject({ level: "cheap", model: null, source: "default" });
      expect(router.profileCalls + router.parseCalls).toBe(0);
    });

    it("asks the parse model only when the deterministic parser leaves words unplaced", async () => {
      await enableRouter();
      const bit = await createProject("Bitig", "BIT");
      await createTask(bit.id, "One");
      await createTask(bit.id, "Two");
      router.parse = () =>
        jsonResponse({ success: true, result: { response: JSON.stringify({ codes: ["BIT-2"], ranges: [] }) } });

      const plan = await (await post("/api/work-queue/plan", { prompt: "BIT-1 and the second one" })).json<PlanBody>();

      expect(router.parseCalls).toBe(1);
      expect(plan.parse.fallback).toBe("applied");
      expect(plan.rows.map((row) => row.code)).toEqual(["BIT-1", "BIT-2"]);
    });

    it("rejects an empty prompt and unknown body keys", async () => {
      expect((await post("/api/work-queue/plan", { prompt: "   " })).status).toBe(400);
      expect((await post("/api/work-queue/plan", { prompt: "BIT-1", lanes: [] })).status).toBe(400);
    });
  });

  describe("POST /api/work-queue", () => {
    it("replans on the server, approves ticked tasks, saves overrides and creates lane umbrellas", async () => {
      await mapLevelModels();
      const bit = await createProject("Bitig", "BIT");
      const web = await createProject("Website", "WEB");
      const first = await createTask(bit.id, "First");
      const ticked = await createTask(bit.id, "Ticked", { pendingApproval: true });
      const unticked = await createTask(bit.id, "Unticked", { pendingApproval: true });
      const dependent = await createTask(bit.id, "Dependent", { dependsOn: [first.id] });
      const finished = await createTask(bit.id, "Finished", { status: "done" });
      const single = await createTask(web.id, "Single lane task");

      const response = await post("/api/work-queue", {
        prompt: "Start BIT-1 to BIT-5, BIT-9 and WEB-1",
        // A client cannot queue a finished or missing task by listing it.
        items: ["BIT-1", "bit-2", "BIT-3", "#BIT-4", "BIT-5", "BIT-9", "WEB-1"],
        approvals: ["BIT-2", "BIT-5"],
        overrides: [
          { code: "BIT-1", level: "strong" },
          { code: "BIT-5", level: "strong" },
        ],
      });

      expect(response.status).toBe(201);
      const body = await response.json<ConfirmBody>();
      expect(body.approved).toEqual(["BIT-2"]);
      expect(body.queue.state).toBe("active");
      expect(body.queue.prompt).toBe("Start BIT-1 to BIT-5, BIT-9 and WEB-1");
      expect(body.queue.entries.map((entry) => entry.taskCode).sort()).toEqual(["BIT-1", "BIT-2", "BIT-4", "WEB-1"]);
      expect(body.queue.entries.map((entry) => entry.position)).toEqual([0, 1, 2, 3]);
      expect(body.queue.entries.every((entry) => entry.state === "waiting")).toBe(true);
      expect(body.plan.rows.map((row) => row.code)).not.toContain("BIT-3");

      // One umbrella for the BIT lane (three tasks); the single WEB task runs on its own.
      expect(body.umbrellas).toHaveLength(1);
      const umbrellaView = body.umbrellas[0];
      if (!umbrellaView) throw new Error("Expected a queue umbrella");
      expect(umbrellaView).toMatchObject({ projectId: bit.id, title: "Queue: BIT-1, BIT-2, BIT-4" });
      expect([...umbrellaView.children].sort()).toEqual(["BIT-1", "BIT-2", "BIT-4"]);
      const umbrella = await getTask(umbrellaView.taskId);
      expect(umbrella.labels).toEqual(["work-queue"]);
      expect(umbrella.pendingApproval).toBeUndefined();
      expect(umbrella.status).toBe("todo");
      expect(umbrella.dependsOn).toBeUndefined();
      for (const task of [first, ticked, dependent]) {
        expect((await getTask(task.id)).parentId).toBe(umbrella.id);
      }
      for (const entry of body.queue.entries) {
        expect(entry.umbrellaTaskId).toBe(entry.lane === bit.id ? umbrella.id : null);
      }
      expect((await getTask(single.id)).parentId).toBeUndefined();

      // The ticked task is approved by the signed-in person; the unticked one is untouched.
      const approvedTask = await getTask(ticked.id);
      expect(approvedTask.pendingApproval).toBeUndefined();
      expect(approvedTask.activity?.at(-1)).toMatchObject({ action: "updated" });
      expect(approvedTask.activity?.at(-1)?.userId).toBeDefined();
      const untickedTask = await getTask(unticked.id);
      expect(untickedTask.pendingApproval).toBe(true);
      expect(untickedTask.parentId).toBeUndefined();

      // The override is a manual profile and decides the snapshotted selection.
      expect(await store.getTaskRunProfile(first.id)).toMatchObject({ source: "manual", level: "strong" });
      expect(await store.getTaskRunProfile(finished.id)).toBeUndefined();
      const firstEntry = body.queue.entries.find((entry) => entry.taskId === first.id);
      expect(firstEntry?.resolvedSelection).toMatchObject(STRONG_SELECTION);
      const singleEntry = body.queue.entries.find((entry) => entry.taskId === single.id);
      expect(singleEntry?.resolvedSelection).toMatchObject(CHEAP_SELECTION);
      expect(router.profileCalls + router.parseCalls).toBe(0);
    });

    it("does not queue a task twice and skips tasks that are queued or running", async () => {
      const bit = await createProject("Bitig", "BIT");
      const queued = await createTask(bit.id, "Queued");
      const running = await createTask(bit.id, "Running");
      const fresh = await createTask(bit.id, "Fresh");
      await store.saveAgentRun({
        id: defaultIdGenerator(),
        taskId: running.id,
        t3ProjectId: "t3-bit",
        threadId: "thread-running",
        state: "working",
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });

      const firstConfirm = await post("/api/work-queue", { prompt: "BIT-1 and BIT-2", items: ["BIT-1", "BIT-2"] });
      expect(firstConfirm.status).toBe(201);
      const firstBody = await firstConfirm.json<ConfirmBody>();
      expect(firstBody.queue.entries.map((entry) => entry.taskCode)).toEqual(["BIT-1"]);
      expect(firstBody.umbrellas).toEqual([]);
      expect(rowOf(firstBody.plan.rows, "BIT-2").classification).toBe("already_running");

      // The same prompt again has nothing left to queue.
      const repeat = await post("/api/work-queue", { prompt: "BIT-1 and BIT-2", items: ["BIT-1", "BIT-2"] });
      expect(repeat.status).toBe(409);
      const repeatBody = await repeat.json<{ error: string; plan: PlanBody }>();
      expect(repeatBody.error).toBe("nothing_to_queue");
      expect(rowOf(repeatBody.plan.rows, "BIT-1").classification).toBe("already_queued");
      expect(await listQueues()).toHaveLength(1);

      // A mixed list queues only the new task.
      const mixed = await post("/api/work-queue", { prompt: "BIT-1 to BIT-3", items: ["BIT-1", "BIT-2", "BIT-3"] });
      expect(mixed.status).toBe(201);
      const mixedBody = await mixed.json<ConfirmBody>();
      expect(mixedBody.queue.entries.map((entry) => entry.taskId)).toEqual([fresh.id]);
      expect(mixedBody.umbrellas).toEqual([]);
      expect((await getTask(queued.id)).parentId).toBeUndefined();
    });

    it("rejects a client-sent plan, an unknown override level and malformed codes", async () => {
      const bit = await createProject("Bitig", "BIT");
      await createTask(bit.id, "Only");

      const withPlan = await post("/api/work-queue", {
        prompt: "BIT-1",
        items: ["BIT-1"],
        lanes: [{ projectId: bit.id, codes: ["BIT-1"] }],
      });
      expect(withPlan.status).toBe(400);

      const badCode = await post("/api/work-queue", { prompt: "BIT-1", items: ["BIT-1; DROP"] });
      expect(badCode.status).toBe(400);

      const badLevel = await post("/api/work-queue", {
        prompt: "BIT-1",
        items: ["BIT-1"],
        overrides: [{ code: "BIT-1", level: "imaginary" }],
      });
      expect(badLevel.status).toBe(400);
      expect(await listQueues("?all=true")).toEqual([]);
    });
  });

  describe("queue and item controls", () => {
    async function confirmThree(): Promise<{ body: ConfirmBody; tasks: Task[]; project: Project }> {
      const project = await createProject("Bitig", "BIT");
      const tasks = [
        await createTask(project.id, "One"),
        await createTask(project.id, "Two"),
        await createTask(project.id, "Three"),
      ];
      const response = await post("/api/work-queue", { prompt: "BIT-1 to BIT-3", items: ["BIT-1", "BIT-2", "BIT-3"] });
      expect(response.status).toBe(201);
      return { body: await response.json<ConfirmBody>(), tasks, project };
    }

    it("lists open queues and pauses, resumes and cancels them", async () => {
      const { body, tasks } = await confirmThree();
      const queueId = body.queue.id;
      const umbrellaId = body.umbrellas[0]?.taskId;

      const listed = await listQueues();
      expect(listed.map((queue) => queue.id)).toEqual([queueId]);
      expect(listed[0]?.entries.map((entry) => entry.taskCode)).toEqual(["BIT-1", "BIT-2", "BIT-3"]);

      const paused = await post(`/api/work-queues/${queueId}/pause`);
      expect(paused.status).toBe(200);
      expect((await paused.json<QueueBody>()).state).toBe("paused");
      expect((await post(`/api/work-queues/${queueId}/pause`)).status).toBe(400);
      expect((await (await post(`/api/work-queues/${queueId}/resume`)).json<QueueBody>()).state).toBe("active");

      const cancelled = await post(`/api/work-queues/${queueId}/cancel`);
      expect(cancelled.status).toBe(200);
      const cancelledBody = await cancelled.json<QueueBody>();
      expect(cancelledBody.state).toBe("cancelled");
      expect(cancelledBody.entries.every((entry) => entry.state === "cancelled")).toBe(true);
      // Tasks that never started go back to the backlog as they were.
      for (const task of tasks) {
        expect((await getTask(task.id)).parentId).toBeUndefined();
      }
      expect(umbrellaId).toBeDefined();

      expect(await listQueues()).toEqual([]);
      expect((await listQueues("?all=true")).map((queue) => queue.id)).toEqual([queueId]);
      expect((await post(`/api/work-queues/${queueId}/resume`)).status).toBe(400);
      expect((await post(`/api/work-queues/${defaultIdGenerator()}/pause`)).status).toBe(404);

      // A cancelled queue frees its tasks for a new one.
      const again = await post("/api/work-queue", { prompt: "BIT-1", items: ["BIT-1"] });
      expect(again.status).toBe(201);
    });

    it("skips an entry, detaches its task and retries it as a new entry", async () => {
      await mapLevelModels();
      const { body, tasks } = await confirmThree();
      const umbrellaId = body.umbrellas[0]?.taskId;
      const target = body.queue.entries[1];
      const targetTask = tasks[1];
      if (!target || !targetTask || !umbrellaId) throw new Error("Expected a queued entry under an umbrella");

      expect((await post(`/api/work-queue-items/${target.id}/retry`)).status).toBe(400);

      const skipped = await post(`/api/work-queue-items/${target.id}/skip`);
      expect(skipped.status).toBe(200);
      expect(await skipped.json()).toMatchObject({ id: target.id, state: "skipped", taskCode: "BIT-2" });
      expect((await getTask(targetTask.id)).parentId).toBeUndefined();
      expect((await post(`/api/work-queue-items/${target.id}/skip`)).status).toBe(400);

      expect((await post(`/api/work-queue-items/${target.id}/retry`, { level: "imaginary" })).status).toBe(400);
      const retried = await post(`/api/work-queue-items/${target.id}/retry`, { level: "strong" });
      expect(retried.status).toBe(201);
      const retriedBody = await retried.json<QueueBody["entries"][number]>();
      expect(retriedBody).toMatchObject({
        taskId: targetTask.id,
        state: "waiting",
        position: 3,
        umbrellaTaskId: umbrellaId,
      });
      expect(retriedBody.id).not.toBe(target.id);
      expect(retriedBody.resolvedSelection).toMatchObject(STRONG_SELECTION);
      expect((await getTask(targetTask.id)).parentId).toBe(umbrellaId);

      const [queue] = await listQueues();
      expect(queue?.entries.map((entry) => entry.state)).toEqual(["waiting", "skipped", "waiting", "waiting"]);
      expect((await post(`/api/work-queue-items/${defaultIdGenerator()}/skip`)).status).toBe(404);
      expect((await post(`/api/work-queue-items/${defaultIdGenerator()}/retry`)).status).toBe(404);
    });
  });

  describe("access", () => {
    it("requires authentication, blocks cross-site writes and keeps queues inside their organisation", async () => {
      const anonymous = await app.request(
        `${BASE_URL}/api/work-queue/plan`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "BIT-1" }) },
        env,
      );
      expect(anonymous.status).toBe(401);
      expect((await app.request(`${BASE_URL}/api/work-queues`, {}, env)).status).toBe(401);

      const crossSite = await request("/api/work-queue", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ prompt: "BIT-1", items: ["BIT-1"] }),
      });
      expect(crossSite.status).toBe(403);

      const foreign = await new D1WorkQueueStore(env.DB, OTHER_ORG_ID).createQueue({
        id: defaultIdGenerator(),
        createdBy: "someone-else",
        prompt: "OTHER-1",
        now: Date.now(),
      });
      expect(await listQueues("?all=true")).toEqual([]);
      expect((await post(`/api/work-queues/${foreign.id}/cancel`)).status).toBe(404);
      expect((await new D1WorkQueueStore(env.DB, OTHER_ORG_ID).getQueue(foreign.id))?.state).toBe("planning");
    });
  });
});
