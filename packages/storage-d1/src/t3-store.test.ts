import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0019_project_t3_threads.sql?raw";
import subagentMigration from "../migrations/0021_agent_run_subagents.sql?raw";
import gitMigration from "../migrations/0023_agent_run_git_metadata.sql?raw";
import requestMigration from "../migrations/0024_t3_run_requests.sql?raw";
import multiHostMigration from "../migrations/0025_multi_host_t3.sql?raw";
import workspaceRootMigration from "../migrations/0026_project_mapping_workspace_root.sql?raw";
import runOrchestrationMigration from "../migrations/0027_run_orchestration.sql?raw";
import { DEFAULT_ORGANISATION_ID, defaultIdGenerator } from "@bitig/core";
import { T3_REQUEST_LEASE_MS } from "./t3-request-store";
import { T3D1Store, type SaveProjectT3ThreadInput } from "./t3-store";

const PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc2f";
const OTHER_PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc30";
const STARTED_AT = Date.parse("2026-11-03T10:00:00.000Z");
const LATER = Date.parse("2026-11-03T11:00:00.000Z");

const SETUP = [
  "DROP TABLE IF EXISTS `agent_run_children`",
  "DROP TABLE IF EXISTS `project_run_settings`",
  "DROP TABLE IF EXISTS `task_run_profiles`",
  "DROP TABLE IF EXISTS `org_ai_router_settings`",
  "DROP TABLE IF EXISTS `run_level_models`",
  "DROP TABLE IF EXISTS `run_levels`",
  "DROP TABLE IF EXISTS `project_t3_threads`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL, `name` text NOT NULL)",
];

function threadInput(overrides: Partial<SaveProjectT3ThreadInput> = {}): SaveProjectT3ThreadInput {
  return {
    id: defaultIdGenerator(),
    projectId: PROJECT_ID,
    hostId: "host-1",
    t3ProjectId: "t3-project",
    threadId: "thread-1",
    title: "Check environment",
    state: "working",
    workspaceStrategy: "root",
    startedBy: "you",
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    ...overrides,
  };
}

describe("T3D1Store project threads (BIT-127)", () => {
  beforeEach(async () => {
    for (const statement of SETUP) {
      await env.DB.prepare(statement).run();
    }
    for (const statement of migration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    await env.DB.prepare("DROP INDEX IF EXISTS `project_t3_threads_thread_id_idx`").run();
    await env.DB.prepare("ALTER TABLE `project_t3_threads` ADD `host_id` text").run();
    await env.DB
      .prepare("CREATE UNIQUE INDEX `project_t3_threads_host_thread_idx` ON `project_t3_threads` (`host_id`, `thread_id`)")
      .run();
    await env.DB
      .prepare("CREATE INDEX `project_t3_threads_thread_id_idx` ON `project_t3_threads` (`thread_id`)")
      .run();
    await env.DB.prepare("INSERT INTO projects (id, name) VALUES (?, ?), (?, ?)")
      .bind(PROJECT_ID, "Bitig", OTHER_PROJECT_ID, "Other")
      .run();
  });

  it("saves a thread with its model selection and reads it back", async () => {
    const store = new T3D1Store(env.DB);
    const saved = await store.saveProjectThread(
      threadInput({
        link: "https://t3.example/thread-1",
        selection: {
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          options: [{ id: "effort", value: "high" }],
        },
      }),
    );
    expect(saved).toMatchObject({
      projectId: PROJECT_ID,
      hostId: "host-1",
      threadId: "thread-1",
      title: "Check environment",
      link: "https://t3.example/thread-1",
      model: "claude-opus-5-5",
      providerInstanceId: "claudeAgent",
      modelOptions: [{ id: "effort", value: "high" }],
      workspaceStrategy: "root",
      startedBy: "you",
      startedAt: "2026-11-03T10:00:00.000Z",
    });
    expect(await store.getProjectThread(PROJECT_ID, "thread-1")).toEqual(saved);
  });

  it("requires a host for colliding IDs and only mutates that host's record", async () => {
    const store = new T3D1Store(env.DB);
    const first = await store.saveProjectThread(threadInput({ hostId: "host-a" }));
    const second = await store.saveProjectThread(threadInput({ hostId: "host-b" }));
    await expect(store.getProjectThread(PROJECT_ID, "thread-1")).rejects.toThrow("multiple hosts");
    await expect(store.deleteProjectThread(PROJECT_ID, "thread-1")).rejects.toThrow("multiple hosts");
    await store.updateProjectThreadState(PROJECT_ID, "thread-1", { hostId: "host-a", state: "finished" });
    expect((await store.getProjectThread(PROJECT_ID, "thread-1", "host-a"))?.state).toBe("finished");
    expect(await store.getProjectThread(PROJECT_ID, "thread-1", "host-b")).toEqual(second);
    expect(await store.deleteProjectThread(PROJECT_ID, "thread-1", "host-a")).toBe(true);
    expect((await store.listProjectThreads(PROJECT_ID)).map((thread) => thread.id)).toEqual([second.id]);
    expect(first.id).not.toBe(second.id);
  });

  it("does not expose or mutate another organisation's project threads", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput());
    const foreign = new T3D1Store(env.DB, defaultIdGenerator());
    expect(await foreign.getProjectThread(PROJECT_ID, "thread-1", "host-1")).toBeUndefined();
    expect(await foreign.listProjectThreads(PROJECT_ID)).toEqual([]);
    expect(await foreign.deleteProjectThread(PROJECT_ID, "thread-1", "host-1")).toBe(false);
    expect(await foreign.updateProjectThreadModel(PROJECT_ID, "thread-1", { hostId: "host-1", selection: { providerInstanceId: "other", model: "other" } })).toBeUndefined();
    expect(await store.getProjectThread(PROJECT_ID, "thread-1", "host-1")).toBeDefined();
  });

  it("scopes threads to their project and lists newest first", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput({ threadId: "old" }));
    await store.saveProjectThread(threadInput({ threadId: "new", startedAt: LATER, updatedAt: LATER }));
    await store.saveProjectThread(threadInput({ threadId: "elsewhere", projectId: OTHER_PROJECT_ID }));

    expect((await store.listProjectThreads(PROJECT_ID)).map((t) => t.threadId)).toEqual(["new", "old"]);
    expect(await store.listProjectThreads()).toHaveLength(3);
    expect(await store.getProjectThread(PROJECT_ID, "elsewhere")).toBeUndefined();
  });

  it("rejects a second record for the same T3 thread on the same host, but allows the same threadId on a different host", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput({ hostId: "host-a", threadId: "shared-thread" }));
    await expect(
      store.saveProjectThread(threadInput({ hostId: "host-a", threadId: "shared-thread" })),
    ).rejects.toThrow();

    const onOtherHost = await store.saveProjectThread(
      threadInput({ projectId: OTHER_PROJECT_ID, hostId: "host-b", threadId: "shared-thread" }),
    );
    expect(onOtherHost.hostId).toBe("host-b");
    expect((await store.getProjectThread(PROJECT_ID, "shared-thread"))?.hostId).toBe("host-a");
    expect((await store.getProjectThread(OTHER_PROJECT_ID, "shared-thread"))?.hostId).toBe("host-b");
  });

  it("deletes only the requested project's thread and reports missing records", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput());
    await store.saveProjectThread(threadInput({ projectId: OTHER_PROJECT_ID, threadId: "other" }));
    expect(await store.deleteProjectThread(OTHER_PROJECT_ID, "thread-1")).toBe(false);
    expect(await store.deleteProjectThread(PROJECT_ID, "missing")).toBe(false);
    expect(await store.deleteProjectThread(PROJECT_ID, "thread-1")).toBe(true);
    expect(await store.deleteProjectThread(PROJECT_ID, "thread-1")).toBe(false);
    expect(await store.listProjectThreads(PROJECT_ID)).toEqual([]);
    expect(await store.listProjectThreads(OTHER_PROJECT_ID)).toHaveLength(1);
  });

  it("updates state and keeps the link when none is given", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput({ link: "https://t3.example/a" }));
    const updated = await store.updateProjectThreadState(PROJECT_ID, "thread-1", { state: "finished", now: LATER });
    expect(updated).toMatchObject({ state: "finished", link: "https://t3.example/a" });
    expect(await store.getProjectThread(PROJECT_ID, "thread-1")).toEqual(updated);
    expect(
      await store.updateProjectThreadState(OTHER_PROJECT_ID, "thread-1", { state: "failed" }),
    ).toBeUndefined();
  });

  it("records a model switch and clears options when the new model has none", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(
      threadInput({
        selection: { providerInstanceId: "codex", model: "gpt-6", options: [{ id: "fast", value: true }] },
      }),
    );
    const switched = await store.updateProjectThreadModel(PROJECT_ID, "thread-1", {
      selection: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
      now: LATER,
    });
    expect(switched?.model).toBe("claude-opus-5-5");
    expect(switched?.modelOptions).toBeUndefined();
    expect(await store.getProjectThread(PROJECT_ID, "thread-1")).toEqual(switched);
    expect(
      await store.updateProjectThreadModel(PROJECT_ID, "missing", {
        selection: { providerInstanceId: "codex", model: "gpt-6" },
      }),
    ).toBeUndefined();
  });
});

const PARENT_TASK_ID = "01a14ecf-281e-7436-8c52-a524c5fabd01";
const CHILD_TASK_ID = "01a14ecf-281e-7436-8c52-a524c5fabd02";

/** `agent_runs` as it stood before #BIT-141, so the test also applies migrations 0021, 0023, 0024, and 0025. */
const AGENT_RUN_SETUP = [
  "DROP TABLE IF EXISTS `agent_run_children`",
  "DROP TABLE IF EXISTS `project_run_settings`",
  "DROP TABLE IF EXISTS `task_run_profiles`",
  "DROP TABLE IF EXISTS `org_ai_router_settings`",
  "DROP TABLE IF EXISTS `run_level_models`",
  "DROP TABLE IF EXISTS `run_levels`",
  "DROP TABLE IF EXISTS `t3_run_requests`",
  "DROP TABLE IF EXISTS `agent_runs`",
  "DROP TABLE IF EXISTS `project_t3_threads`",
  "DROP TABLE IF EXISTS `t3_project_mappings`",
  "DROP TABLE IF EXISTS `t3_oauth_states`",
  "DROP TABLE IF EXISTS `t3_connections`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  "DROP TABLE IF EXISTS `organisations`",
  "CREATE TABLE `organisations` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL, `slug` text NOT NULL, `created_at` integer NOT NULL, `updated_at` integer NOT NULL, `deleted_at` integer)",
  "INSERT INTO `organisations` (`id`, `name`, `slug`, `created_at`, `updated_at`) VALUES ('01a10000-0000-7000-8000-000000000001', 'Default Organisation', 'default', 1791723553130, 1791723553130)",
  "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL, `name` text NOT NULL)",
  "CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `project_id` text DEFAULT '01a14ecf-281e-7436-8c52-a524c5fabc2f' NOT NULL, `title` text NOT NULL, `status` text DEFAULT 'todo' NOT NULL, `needs_human` text, `completed_at` integer)",
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
    \`workspace_strategy\` text,
    \`started_by\` text,
    \`started_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `agent_runs_task_id_idx` ON `agent_runs` (`task_id`)",
];

describe("T3D1Store umbrella and child runs (BIT-141)", () => {
  beforeEach(async () => {
    for (const statement of AGENT_RUN_SETUP) {
      await env.DB.prepare(statement).run();
    }
    for (const statement of migration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of subagentMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of gitMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of requestMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of multiHostMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of workspaceRootMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of runOrchestrationMigration.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await env.DB.prepare(trimmed).run();
    }
    await env.DB.prepare("INSERT INTO projects (id, name) VALUES (?, ?), (?, ?)")
      .bind(PROJECT_ID, "Bitig", OTHER_PROJECT_ID, "Other")
      .run();
    await env.DB.prepare("INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?), (?, ?, ?)")
      .bind(PARENT_TASK_ID, PROJECT_ID, "Umbrella", CHILD_TASK_ID, PROJECT_ID, "Child")
      .run();
  });

  function runInput(taskId: string, threadId: string, parentTaskId?: string) {
    return {
      id: defaultIdGenerator(),
      taskId,
      hostId: "host-1",
      t3ProjectId: "t3-project",
      threadId,
      state: "working" as const,
      ...(parentTaskId ? { parentTaskId } : {}),
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    };
  }

  it("round trips Git metadata, preserves missing values, clears explicit values, and rejects stale reports", async () => {
    const store = new T3D1Store(env.DB);
    const run = await store.saveAgentRun(runInput(PARENT_TASK_ID, "thread-parent"));
    expect(run.branch).toBeUndefined();
    const metadata = { branch: "feature/bit-162", headSha: "a".repeat(40), diffStat: { filesChanged: 2, insertions: 8, deletions: 3 }, pullRequestUrls: ["https://github.com/example/repo/pull/1"] };
    await store.updateAgentRunGitMetadata(run.taskId, run.id, run.threadId, metadata, LATER);
    expect(await store.getAgentRunByTaskId(run.taskId)).toMatchObject(metadata);
    await store.updateAgentRunGitMetadata(run.taskId, run.id, run.threadId, { branch: "renamed" });
    expect(await store.getAgentRunByTaskId(run.taskId)).toMatchObject({ ...metadata, branch: "renamed" });
    expect(await store.updateAgentRunGitMetadata(run.taskId, run.id, "stale-thread", { branch: "wrong" })).toBeUndefined();
    expect(await store.updateAgentRunGitMetadata(run.taskId, defaultIdGenerator(), run.threadId, { branch: "wrong" })).toBeUndefined();
    await store.updateAgentRunGitMetadata(run.taskId, run.id, run.threadId, { branch: null, headSha: null, diffStat: null, pullRequestUrls: [] });
    expect(await store.getAgentRunByTaskId(run.taskId)).toMatchObject({ pullRequestUrls: [] });
    expect((await store.getAgentRunByTaskId(run.taskId))?.headSha).toBeUndefined();
    await store.updateAgentRunGitMetadata(run.taskId, run.id, run.threadId, metadata);
    const replacement = await store.saveAgentRun(runInput(PARENT_TASK_ID, "replacement"));
    expect(replacement.branch).toBeUndefined();
    expect(replacement.pullRequestUrls).toBeUndefined();
  });

  it("links a child run to its parent and lets exactly one caller claim the parent's wait", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveAgentRun(runInput(PARENT_TASK_ID, "thread-parent"));
    const child = await store.saveAgentRun(runInput(CHILD_TASK_ID, "thread-child", PARENT_TASK_ID));
    expect(child.parentTaskId).toBe(PARENT_TASK_ID);
    expect(await store.getAgentRunByTaskId(CHILD_TASK_ID)).toEqual(child);

    const waiting = await store.setAgentRunWaitingFor(PARENT_TASK_ID, { childTaskId: CHILD_TASK_ID, now: LATER });
    expect(waiting).toMatchObject({ state: "waiting_subagent", waitingForTaskId: CHILD_TASK_ID });
    expect(await store.getAgentRunByTaskId(PARENT_TASK_ID)).toEqual(waiting);
    expect((await store.listAgentRunsWaitingFor(CHILD_TASK_ID)).map((r) => r.taskId)).toEqual([PARENT_TASK_ID]);

    // A state reconciliation keeps the wait pointer.
    await store.updateAgentRunState(PARENT_TASK_ID, { state: "working" });
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.waitingForTaskId).toBe(CHILD_TASK_ID);

    const claimed = await store.claimAgentRunWaitingFor(PARENT_TASK_ID, CHILD_TASK_ID, { state: "working", now: LATER });
    expect(claimed?.state).toBe("working");
    expect(claimed?.waitingForTaskId).toBeUndefined();
    expect(await store.claimAgentRunWaitingFor(PARENT_TASK_ID, CHILD_TASK_ID, { state: "working" })).toBeUndefined();
    expect(await store.listAgentRunsWaitingFor(CHILD_TASK_ID)).toEqual([]);
    expect(await store.setAgentRunWaitingFor("missing", { childTaskId: CHILD_TASK_ID })).toBeUndefined();
  });

  it("drops the wait on relaunch and clears links when a linked task is deleted", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveAgentRun(runInput(PARENT_TASK_ID, "thread-parent"));
    await store.saveAgentRun(runInput(CHILD_TASK_ID, "thread-child", PARENT_TASK_ID));
    await store.setAgentRunWaitingFor(PARENT_TASK_ID, { childTaskId: CHILD_TASK_ID });

    const relaunched = await store.saveAgentRun(runInput(PARENT_TASK_ID, "thread-parent-2"));
    expect(relaunched.waitingForTaskId).toBeUndefined();
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.waitingForTaskId).toBeUndefined();

    await env.DB.prepare("PRAGMA foreign_keys = ON").run();
    await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(PARENT_TASK_ID).run();
    expect((await store.getAgentRunByTaskId(CHILD_TASK_ID))?.parentTaskId).toBeUndefined();
  });

  it("enqueues launches and replies in order, enforces single-flight claims with token fencing, and cancels unattempted requests (BIT-161)", async () => {
    const store = new T3D1Store(env.DB);
    const runId = defaultIdGenerator();
    await store.requests.enqueue({
      id: runId,
      hostId: "host-1",
      taskId: PARENT_TASK_ID,
      kind: "launch",
      payload: JSON.stringify({ title: "BIT-1", prompt: "go" }),
      now: STARTED_AT,
      launch: {
        id: runId,
        taskId: PARENT_TASK_ID,
        hostId: "host-1",
        t3ProjectId: "t3-project",
        threadId: `queued:${runId}`,
        state: "queued",
        model: "claude-opus-4-7",
        providerInstanceId: "prov-claude",
        modelOptions: [{ id: "effort", value: "high" }],
        workspaceStrategy: "worktree",
        startedBy: "emre",
        startedAt: STARTED_AT,
        updatedAt: STARTED_AT,
      },
    });

    expect(await store.requests.hasPending(PARENT_TASK_ID)).toBe(true);
    expect(await store.requests.listPendingTaskIds()).toEqual([PARENT_TASK_ID]);
    const queuedRun = await store.getAgentRunByTaskId(PARENT_TASK_ID);
    expect(queuedRun).toMatchObject({
      id: runId,
      hostId: "host-1",
      state: "queued",
      threadId: `queued:${runId}`,
      model: "claude-opus-4-7",
      providerInstanceId: "prov-claude",
      modelOptions: [{ id: "effort", value: "high" }],
    });

    // Duplicate launch enqueue while pending is ignored
    const secondRunId = defaultIdGenerator();
    await store.requests.enqueue({
      id: secondRunId,
      hostId: "host-2",
      taskId: PARENT_TASK_ID,
      kind: "launch",
      payload: JSON.stringify({ title: "duplicate" }),
      now: LATER,
      launch: {
        id: secondRunId,
        taskId: PARENT_TASK_ID,
        hostId: "host-2",
        t3ProjectId: "t3-project",
        threadId: `queued:${secondRunId}`,
        state: "queued",
        startedAt: LATER,
        updatedAt: LATER,
      },
    });
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.id).toBe(runId);

    // Follow-up reply can be enqueued behind the launch
    const replyId = defaultIdGenerator();
    await store.requests.enqueue({
      id: replyId,
      hostId: "host-1",
      taskId: PARENT_TASK_ID,
      kind: "reply",
      payload: JSON.stringify({ prompt: "follow-up" }),
      now: LATER,
    });

    // Only one caller can claim while the lease is active
    const claimed1 = await store.requests.claim(PARENT_TASK_ID, "token-1", STARTED_AT);
    expect(claimed1).toMatchObject({
      id: runId,
      host_id: "host-1",
      kind: "launch",
      claim_token: "token-1",
      attempted: 0,
    });
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.state).toBe("working");
    expect(await store.requests.claim(PARENT_TASK_ID, "token-2", STARTED_AT + 1000)).toBeNull();

    // After lease expiry, a new caller can re-claim and fence out the stale token
    const expiredAt = STARTED_AT + T3_REQUEST_LEASE_MS + 1;
    const reclaimed = await store.requests.claim(PARENT_TASK_ID, "token-2", expiredAt);
    expect(reclaimed).toMatchObject({ id: runId, host_id: "host-1", claim_token: "token-2" });
    expect(await store.requests.markAttempted(runId, "token-1")).toBe(false);
    expect(await store.requests.markAttempted(runId, "token-2")).toBe(true);

    if (!reclaimed) {
      throw new Error("Expected reclaimed request");
    }
    // Finishing the launch while the reply is still queued keeps agent_runs.state = 'queued' until the reply drains
    await store.requests.finish(reclaimed, "delivered", expiredAt);
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.state).toBe("queued");

    // Unattempted reply can be cancelled before it is claimed
    expect(await store.requests.cancel(PARENT_TASK_ID, expiredAt + 100)).toBe(true);
    expect(await store.requests.hasPending(PARENT_TASK_ID)).toBe(false);
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.state).toBe("stopped");
  });
});

describe("T3D1Store multi-host persistence and migration (BIT-147)", () => {
  it("migrates legacy single-host connections, mappings, runs, threads, and requests without data loss", async () => {
    for (const statement of AGENT_RUN_SETUP) {
      await env.DB.prepare(statement).run();
    }
    for (const statement of migration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of subagentMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of gitMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of requestMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }

    // Seed pre-migration records (no host_id / label / kind / projects_root columns yet)
    await env.DB.prepare("INSERT INTO projects (id, org_id, name) VALUES (?, ?, ?)")
      .bind(PROJECT_ID, DEFAULT_ORGANISATION_ID, "Bitig")
      .run();
    await env.DB.prepare("INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)")
      .bind(PARENT_TASK_ID, PROJECT_ID, "Migrate hosts")
      .run();
    await env.DB
      .prepare(
        `INSERT INTO t3_connections
          (id, org_id, mcp_url, issuer, client_id, encrypted_access_token, token_iv, scope, expires_at, connected_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "default",
        DEFAULT_ORGANISATION_ID,
        "https://legacy-host.example.com/mcp",
        "https://legacy-host.example.com",
        "client-legacy",
        "cipher-legacy",
        "iv-legacy",
        "orchestration:read orchestration:operate",
        STARTED_AT + 86_400_000,
        STARTED_AT,
        STARTED_AT,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO t3_project_mappings (project_id, t3_project_id, t3_project_title, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(PROJECT_ID, "t3-legacy-proj", "Legacy Project", STARTED_AT)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO agent_runs (id, task_id, t3_project_id, thread_id, state, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("01a14ecf-281e-7436-8c52-a524c5fabe01", PARENT_TASK_ID, "t3-legacy-proj", "legacy-thread-1", "working", STARTED_AT, STARTED_AT)
      .run();
    await env.DB
      .prepare(
        `INSERT INTO project_t3_threads (id, project_id, t3_project_id, thread_id, title, state, workspace_strategy, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "01a14ecf-281e-7436-8c52-a524c5fabe02",
        PROJECT_ID,
        "t3-legacy-proj",
        "legacy-proj-thread-1",
        "Check env",
        "finished",
        "root",
        STARTED_AT,
        STARTED_AT,
      )
      .run();
    await env.DB
      .prepare(
        `INSERT INTO t3_run_requests (id, org_id, task_id, kind, payload, state, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("req-legacy-1", DEFAULT_ORGANISATION_ID, PARENT_TASK_ID, "reply", "{}", "queued", STARTED_AT)
      .run();

    // Apply migration 0025 and 0026
    for (const statement of multiHostMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of workspaceRootMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of runOrchestrationMigration.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await env.DB.prepare(trimmed).run();
    }

    const store = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const conn = await store.getConnection();
    expect(conn).toMatchObject({
      id: "default",
      orgId: DEFAULT_ORGANISATION_ID,
      kind: "user",
      projectsRoot: "~/www",
      mcpUrl: "https://legacy-host.example.com/mcp",
    });

    const mapping = await store.getProjectMapping(PROJECT_ID);
    expect(mapping).toMatchObject({
      projectId: PROJECT_ID,
      hostId: "default",
      t3ProjectId: "t3-legacy-proj",
      t3ProjectTitle: "Legacy Project",
    });
    expect(mapping?.workspaceRoot).toBeUndefined();

    // Updating a host-bound mapping stores workspaceRoot, and omitting it on a same-project update preserves it
    const withFolder = await store.upsertProjectMapping({
      projectId: PROJECT_ID,
      hostId: "default",
      t3ProjectId: "t3-legacy-proj",
      t3ProjectTitle: "Legacy Project",
      workspaceRoot: "~/www/bitig",
      now: LATER,
    });
    expect(withFolder.workspaceRoot).toBe("~/www/bitig");
    const retitled = await store.upsertProjectMapping({
      projectId: PROJECT_ID,
      hostId: "default",
      t3ProjectId: "t3-legacy-proj",
      t3ProjectTitle: "Renamed Legacy Project",
      now: LATER + 1000,
    });
    expect(retitled).toMatchObject({
      t3ProjectTitle: "Renamed Legacy Project",
      workspaceRoot: "~/www/bitig",
    });

    const run = await store.getAgentRunByTaskId(PARENT_TASK_ID);
    expect(run).toMatchObject({
      taskId: PARENT_TASK_ID,
      hostId: "default",
      threadId: "legacy-thread-1",
    });

    const projThread = await store.getProjectThread(PROJECT_ID, "legacy-proj-thread-1");
    expect(projThread).toMatchObject({
      projectId: PROJECT_ID,
      hostId: "default",
      threadId: "legacy-proj-thread-1",
    });

    const claimedReq = await store.requests.claim(PARENT_TASK_ID, "claim-1", STARTED_AT);
    expect(claimedReq).toMatchObject({
      id: "req-legacy-1",
      host_id: "default",
    });
  });

  it("persists multiple hosts per organisation, updates host metadata/projectsRoot, and isolates tenants", async () => {
    for (const statement of AGENT_RUN_SETUP) {
      await env.DB.prepare(statement).run();
    }
    for (const statement of migration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of subagentMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of gitMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of requestMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of multiHostMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of workspaceRootMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of runOrchestrationMigration.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed) await env.DB.prepare(trimmed).run();
    }

    const orgA = new T3D1Store(env.DB, "01a10000-0000-7000-8000-000000000011");
    const orgB = new T3D1Store(env.DB, "01a10000-0000-7000-8000-000000000022");

    const host1 = await orgA.saveConnection({
      label: "Laptop",
      kind: "user",
      mcpUrl: "https://laptop.example.com/mcp",
      issuer: "https://laptop.example.com",
      clientId: "c1",
      encryptedAccessToken: "enc-1",
      tokenIv: "iv-1",
      scope: "orchestration:read orchestration:operate",
      expiresAt: STARTED_AT + 100_000,
      now: STARTED_AT,
    });
    expect(host1).toMatchObject({
      label: "Laptop",
      kind: "user",
      projectsRoot: "~/www",
      mcpUrl: "https://laptop.example.com/mcp",
    });

    const host2 = await orgA.saveConnection({
      label: "Managed Container",
      kind: "container",
      mcpUrl: "https://container.example.com/mcp",
      issuer: "https://container.example.com",
      clientId: "c2",
      encryptedAccessToken: "enc-2",
      tokenIv: "iv-2",
      scope: "orchestration:read orchestration:operate",
      expiresAt: STARTED_AT + 200_000,
      now: LATER,
    });
    expect(host2).toMatchObject({
      label: "Managed Container",
      kind: "container",
      projectsRoot: "/var/www",
      mcpUrl: "https://container.example.com/mcp",
    });
    expect(host2.id).not.toBe(host1.id);

    // Org A has both hosts; Org B sees neither
    expect((await orgA.listConnections()).map((h) => h.id)).toEqual([host1.id, host2.id]);
    expect(await orgB.listConnections()).toEqual([]);
    expect(await orgB.getConnection(host1.id)).toBeUndefined();

    // Reauthorising host1 updates only host1 and preserves host2
    const reauthedHost1 = await orgA.saveConnection({
      id: host1.id,
      mcpUrl: "https://laptop.example.com/mcp",
      issuer: "https://laptop.example.com",
      clientId: "c1-new",
      encryptedAccessToken: "enc-1-refreshed",
      tokenIv: "iv-1-refreshed",
      scope: "orchestration:read orchestration:operate",
      expiresAt: STARTED_AT + 500_000,
      now: LATER + 1000,
    });
    expect(reauthedHost1.id).toBe(host1.id);
    expect(reauthedHost1.label).toBe("Laptop");
    expect((await orgA.getConnection(host2.id))?.encryptedAccessToken).toBe("enc-2");

    // Org B cannot overwrite Org A's hostId
    await expect(
      orgB.saveConnection({
        id: host1.id,
        mcpUrl: "https://evil.example.com/mcp",
        issuer: "https://evil.example.com",
        clientId: "evil",
        encryptedAccessToken: "evil",
        tokenIv: "evil",
        scope: "orchestration:read",
        expiresAt: LATER,
      }),
    ).rejects.toThrow(/another organisation/);

    // Updating host metadata and switching kind updates default projectsRoot when not customised
    const updatedHost1 = await orgA.updateConnection(host1.id, {
      label: "Containerized Laptop",
      kind: "container",
      now: LATER + 2000,
    });
    expect(updatedHost1).toMatchObject({
      id: host1.id,
      label: "Containerized Laptop",
      kind: "container",
      projectsRoot: "/var/www",
    });

    // Deleting host1 leaves host2 intact
    expect(await orgB.deleteConnection(host1.id)).toBe(false);
    expect(await orgA.deleteConnection(host1.id)).toBe(true);
    expect((await orgA.listConnections()).map((h) => h.id)).toEqual([host2.id]);
  });
});

describe("T3D1Store run orchestration tables and stores (BIT-185)", () => {
  const ORG_B_ID = "01a10000-0000-7000-8000-000000000022";
  const ORG_B_PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc99";
  const ORG_B_TASK_ID = "01a14ecf-281e-7436-8c52-a524c5fabd99";
  const CHILD_TWO_TASK_ID = "01a14ecf-281e-7436-8c52-a524c5fabd03";
  const CHILD_THREE_TASK_ID = "01a14ecf-281e-7436-8c52-a524c5fabd04";

  async function applyPre0027Migrations(): Promise<void> {
    for (const statement of AGENT_RUN_SETUP) {
      await env.DB.prepare(statement).run();
    }
    for (const statement of migration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of subagentMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of gitMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of requestMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of multiHostMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    for (const statement of workspaceRootMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
  }

  async function apply0027Migration(): Promise<void> {
    for (const statement of runOrchestrationMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
  }

  beforeEach(async () => {
    await applyPre0027Migrations();
    await apply0027Migration();
    await env.DB.prepare(
      "INSERT INTO organisations (id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(ORG_B_ID, "Second Org", "second", STARTED_AT, STARTED_AT)
      .run();
    await env.DB.prepare("INSERT INTO projects (id, org_id, name) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)")
      .bind(
        PROJECT_ID,
        DEFAULT_ORGANISATION_ID,
        "Bitig",
        OTHER_PROJECT_ID,
        DEFAULT_ORGANISATION_ID,
        "Other",
        ORG_B_PROJECT_ID,
        ORG_B_ID,
        "Org B Project",
      )
      .run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?), (?, ?, ?)",
    )
      .bind(
        PARENT_TASK_ID,
        PROJECT_ID,
        "Umbrella",
        CHILD_TASK_ID,
        PROJECT_ID,
        "Child 1",
        CHILD_TWO_TASK_ID,
        PROJECT_ID,
        "Child 2",
        CHILD_THREE_TASK_ID,
        PROJECT_ID,
        "Child 3",
        ORG_B_TASK_ID,
        ORG_B_PROJECT_ID,
        "Org B Task",
      )
      .run();
  });

  it("seeds cheap, standard, and strong on first read per organisation, supports default and per-host model bindings, and isolates tenants", async () => {
    const orgA = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const orgB = new T3D1Store(env.DB, ORG_B_ID);

    // Seeded on first read
    const seededA = await orgA.listRunLevels({ now: STARTED_AT });
    expect(seededA.map((l) => ({ key: l.key, label: l.label, order: l.order }))).toEqual([
      { key: "cheap", label: "Cheap", order: 0 },
      { key: "standard", label: "Standard", order: 1 },
      { key: "strong", label: "Strong", order: 2 },
    ]);

    // Connect two hosts in Org A
    const host1 = await orgA.saveConnection({
      id: "host-a",
      mcpUrl: "https://host-a.example.com/mcp",
      issuer: "https://host-a.example.com",
      clientId: "c1",
      encryptedAccessToken: "enc-1",
      tokenIv: "iv-1",
      scope: "mcp:tools",
      expiresAt: LATER,
    });
    const host2 = await orgA.saveConnection({
      id: "host-b",
      mcpUrl: "https://host-b.example.com/mcp",
      issuer: "https://host-b.example.com",
      clientId: "c2",
      encryptedAccessToken: "enc-2",
      tokenIv: "iv-2",
      scope: "mcp:tools",
      expiresAt: LATER,
    });

    // Bind default (hostId: null) and host-specific models
    await orgA.setRunLevelModel({
      levelKey: "standard",
      hostId: null,
      selection: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [{ id: "effort", value: "medium" }],
      },
      now: STARTED_AT,
    });
    // Updating default binding in-place does not duplicate rows
    await orgA.setRunLevelModel({
      levelKey: "standard",
      hostId: null,
      selection: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: [{ id: "effort", value: "high" }],
      },
      now: LATER,
    });
    await orgA.setRunLevelModel({
      levelKey: "standard",
      hostId: host1.id,
      selection: {
        providerInstanceId: "codex",
        model: "gpt-5.4",
      },
      now: LATER,
    });

    const bindings = await orgA.listRunLevelModels();
    expect(bindings).toHaveLength(2);

    // Without hostId (or with host2 which has no override), resolves to the default binding
    const defaultStandard = await orgA.getRunLevel("standard");
    expect(defaultStandard?.selection).toEqual({
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: [{ id: "effort", value: "high" }],
    });
    const host2Standard = await orgA.getRunLevel("standard", { hostId: host2.id });
    expect(host2Standard?.selection).toEqual(defaultStandard?.selection);

    // With host1, resolves to host1's specific model binding
    const host1Standard = await orgA.getRunLevel("standard", { hostId: host1.id });
    expect(host1Standard?.selection).toEqual({
      providerInstanceId: "codex",
      model: "gpt-5.4",
    });

    // Adding a custom level in Org A does not leak to Org B
    await orgA.upsertRunLevel({
      key: "review",
      label: "Review",
      description: "Focused review pass",
      order: 3,
      selection: { providerInstanceId: "claudeAgent", model: "claude-opus-4-7" },
      now: LATER,
    });
    expect((await orgA.listRunLevels()).map((l) => l.key)).toEqual([
      "cheap",
      "standard",
      "strong",
      "review",
    ]);
    expect((await orgB.listRunLevels()).map((l) => l.key)).toEqual(["cheap", "standard", "strong"]);
    expect(await orgB.listRunLevelModels()).toEqual([]);
  });

  it("refuses deleting or removing a run level still used by tasks or projects unless a replacement key is passed", async () => {
    const orgA = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const orgB = new T3D1Store(env.DB, ORG_B_ID);

    await orgA.saveTaskRunProfile({
      taskId: CHILD_TASK_ID,
      level: "cheap",
      source: "agent",
      now: STARTED_AT,
    });
    await orgA.upsertProjectRunSettings(PROJECT_ID, {
      defaultRunLevel: "cheap",
      now: STARTED_AT,
    });
    // Org B also uses "cheap" on its own task
    await orgB.saveTaskRunProfile({
      taskId: ORG_B_TASK_ID,
      level: "cheap",
      source: "agent",
      now: STARTED_AT,
    });

    // Refused without replacementKey
    await expect(orgA.deleteRunLevel("cheap")).rejects.toThrow(/still used by 1 task and 1 project/);
    await expect(
      orgA.deleteRunLevel("cheap", { replacementKey: "cheap" }),
    ).rejects.toThrow(/must be different/);
    await expect(
      orgA.deleteRunLevel("cheap", { replacementKey: "nonexistent" }),
    ).rejects.toThrow(/does not exist/);

    // Succeeds with replacementKey and reassigns Org A's task and project without touching Org B
    expect(await orgA.deleteRunLevel("cheap", { replacementKey: "standard", now: LATER })).toBe(true);
    expect((await orgA.listRunLevels()).map((l) => l.key)).toEqual(["standard", "strong"]);
    expect((await orgA.getTaskRunProfile(CHILD_TASK_ID))?.level).toBe("standard");
    expect((await orgA.getProjectRunSettings(PROJECT_ID))?.defaultRunLevel).toBe("standard");
    expect((await orgB.getTaskRunProfile(ORG_B_TASK_ID))?.level).toBe("cheap");

    // Bulk saveRunLevels also enforces replacementKeys when removing a used level
    await expect(
      orgA.saveRunLevels({
        levels: [{ key: "strong", label: "Strong", description: "Only strong left" }],
      }),
    ).rejects.toThrow(/still used by tasks or projects/);

    const saved = await orgA.saveRunLevels({
      levels: [{ key: "strong", label: "Strong", description: "Only strong left" }],
      replacementKeys: { standard: "strong" },
      now: LATER + 1000,
    });
    expect(saved.map((l) => l.key)).toEqual(["strong"]);
    expect((await orgA.getTaskRunProfile(CHILD_TASK_ID))?.level).toBe("strong");
    expect((await orgA.getProjectRunSettings(PROJECT_ID))?.defaultRunLevel).toBe("strong");

    // Cannot delete the last remaining level in an organisation
    await expect(
      orgA.deleteRunLevel("strong", { replacementKey: "standard" }),
    ).rejects.toThrow(/at least one run level/);
  });

  it("persists per-organisation AI router settings with encrypted token fields and tenant isolation", async () => {
    const orgA = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const orgB = new T3D1Store(env.DB, ORG_B_ID);

    expect(await orgA.getAiRouterSettings()).toBeUndefined();

    const saved = await orgA.saveAiRouterSettings({
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc-1/ai/run",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      apiStyle: "cloudflare-run",
      encryptedApiToken: "ciphertext-base64",
      tokenIv: "iv-base64",
      tokenLast4: "9f2a",
      enabled: true,
      updatedBy: "emre",
      now: STARTED_AT,
    });
    expect(saved).toEqual({
      orgId: DEFAULT_ORGANISATION_ID,
      baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc-1/ai/run",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      apiStyle: "cloudflare-run",
      hasToken: true,
      tokenLast4: "9f2a",
      enabled: true,
      updatedBy: "emre",
      updatedAt: "2026-11-03T10:00:00.000Z",
    });

    const rawRecord = await orgA.getAiRouterSettingsRecord();
    expect(rawRecord?.encryptedApiToken).toBe("ciphertext-base64");
    expect(rawRecord?.tokenIv).toBe("iv-base64");

    // Org B cannot see Org A's router settings
    expect(await orgB.getAiRouterSettings()).toBeUndefined();

    // Updating endpoint/model without touching token preserves existing encrypted token
    const updated = await orgA.saveAiRouterSettings({
      baseUrl: "https://router.example.com/v1",
      model: "gpt-4o-mini",
      apiStyle: "openai-chat",
      now: LATER,
    });
    expect(updated).toMatchObject({
      baseUrl: "https://router.example.com/v1",
      model: "gpt-4o-mini",
      apiStyle: "openai-chat",
      hasToken: true,
      tokenLast4: "9f2a",
      enabled: true,
    });

    // Clearing the token removes ciphertext, IV, and tokenLast4
    const cleared = await orgA.saveAiRouterSettings({
      baseUrl: "https://router.example.com/v1",
      model: "gpt-4o-mini",
      apiStyle: "openai-chat",
      clearToken: true,
      enabled: false,
      now: LATER + 1000,
    });
    expect(cleared.hasToken).toBe(false);
    expect(cleared.tokenLast4).toBeUndefined();
    expect(cleared.enabled).toBe(false);
    expect((await orgA.getAiRouterSettingsRecord())?.encryptedApiToken).toBeNull();
  });

  it("persists task_run_profiles, enforces manual > agent > router precedence, and scopes by organisation", async () => {
    const orgA = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const orgB = new T3D1Store(env.DB, ORG_B_ID);

    // 1. Router writes initial profile
    const routerProfile = await orgA.saveTaskRunProfile({
      taskId: CHILD_TASK_ID,
      level: "cheap",
      touches: ["packages/core/src/**"],
      parallelSafe: true,
      source: "router",
      reason: "Small schema change",
      confidence: 0.82,
      now: STARTED_AT,
    });
    expect(routerProfile).toMatchObject({
      taskId: CHILD_TASK_ID,
      level: "cheap",
      touches: ["packages/core/src/**"],
      parallelSafe: true,
      source: "router",
      reason: "Small schema change",
      confidence: 0.82,
    });

    // 2. Agent can overwrite router
    const agentProfile = await orgA.saveTaskRunProfile({
      taskId: CHILD_TASK_ID,
      level: "standard",
      touches: ["packages/storage-d1/src/**", "packages/storage-d1/migrations/**"],
      parallelSafe: false,
      source: "agent",
      reason: "Touches D1 migrations",
      updatedBy: "claude-umbrella",
      now: LATER,
    });
    expect(agentProfile).toMatchObject({
      level: "standard",
      source: "agent",
      parallelSafe: false,
      updatedBy: "claude-umbrella",
    });

    // 3. Router cannot overwrite agent
    const rejectedRouter = await orgA.saveTaskRunProfile({
      taskId: CHILD_TASK_ID,
      level: "cheap",
      source: "router",
      now: LATER + 500,
    });
    expect(rejectedRouter.level).toBe("standard");
    expect(rejectedRouter.source).toBe("agent");

    // 4. Manual can overwrite agent and preserves omitted fields (touches, parallelSafe)
    const manualProfile = await orgA.saveTaskRunProfile({
      taskId: CHILD_TASK_ID,
      level: "strong",
      selection: {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-4-7",
        options: [{ id: "effort", value: "max" }],
      },
      source: "manual",
      updatedBy: "emre",
      now: LATER + 1000,
    });
    expect(manualProfile).toMatchObject({
      level: "strong",
      selection: {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-4-7",
        options: [{ id: "effort", value: "max" }],
      },
      touches: ["packages/storage-d1/src/**", "packages/storage-d1/migrations/**"],
      parallelSafe: false,
      source: "manual",
      updatedBy: "emre",
    });

    // 5. Neither agent nor router can overwrite manual
    const rejectedAgent = await orgA.saveTaskRunProfile({
      taskId: CHILD_TASK_ID,
      level: "cheap",
      source: "agent",
      now: LATER + 2000,
    });
    expect(rejectedAgent.level).toBe("strong");
    expect(rejectedAgent.source).toBe("manual");

    // 6. Org B cannot read, list, update, or delete Org A's task profile
    expect(await orgB.getTaskRunProfile(CHILD_TASK_ID)).toBeUndefined();
    expect(await orgB.listTaskRunProfiles(PROJECT_ID)).toEqual([]);
    await expect(
      orgB.saveTaskRunProfile({ taskId: CHILD_TASK_ID, level: "cheap", source: "manual" }),
    ).rejects.toThrow(/task/);
    expect(await orgB.deleteTaskRunProfile(CHILD_TASK_ID)).toBe(false);
    expect(await orgA.listTaskRunProfiles(PROJECT_ID)).toHaveLength(1);
  });

  it("persists project_run_settings with defaults, glob normalization, level validation, and org scoping", async () => {
    const orgA = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);
    const orgB = new T3D1Store(env.DB, ORG_B_ID);

    // Defaults when not yet written
    const defaults = await orgA.getProjectRunSettings(PROJECT_ID);
    expect(defaults).toEqual({
      projectId: PROJECT_ID,
      serialPaths: [],
      maxParallelChildren: 3,
    });

    // Upsert settings
    const updated = await orgA.upsertProjectRunSettings(PROJECT_ID, {
      defaultRunLevel: "standard",
      serialPaths: ["./packages/storage-d1/migrations/**", "pnpm-lock.yaml"],
      maxParallelChildren: 5,
      now: STARTED_AT,
    });
    expect(updated).toEqual({
      projectId: PROJECT_ID,
      defaultRunLevel: "standard",
      serialPaths: ["packages/storage-d1/migrations/**", "pnpm-lock.yaml"],
      maxParallelChildren: 5,
      updatedAt: "2026-11-03T10:00:00.000Z",
    });

    // Rejects unknown run level
    await expect(
      orgA.upsertProjectRunSettings(PROJECT_ID, { defaultRunLevel: "unknown-level" }),
    ).rejects.toThrow(/does not exist/);

    // Org B cannot read or mutate Org A's project run settings
    expect(await orgB.getProjectRunSettings(PROJECT_ID)).toBeUndefined();
    await expect(
      orgB.upsertProjectRunSettings(PROJECT_ID, { maxParallelChildren: 1 }),
    ).rejects.toThrow(/project/);
    expect(await orgB.deleteProjectRunSettings(PROJECT_ID)).toBe(false);
  });

  it("tracks multiple waiting children in agent_run_children, enforces single-flight claim, and migrates existing waiting_for_task_id rows", async () => {
    // First test the SQL migration of existing agent_runs.waiting_for_task_id rows
    await applyPre0027Migrations();
    await env.DB.prepare("INSERT INTO projects (id, org_id, name) VALUES (?, ?, ?)")
      .bind(PROJECT_ID, DEFAULT_ORGANISATION_ID, "Bitig")
      .run();
    await env.DB.prepare(
      "INSERT INTO tasks (id, project_id, title, status, needs_human, completed_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        PARENT_TASK_ID,
        PROJECT_ID,
        "Umbrella 1",
        "in_progress",
        null,
        null,
        CHILD_TASK_ID,
        PROJECT_ID,
        "Running Child",
        "in_progress",
        null,
        null,
        CHILD_TWO_TASK_ID,
        PROJECT_ID,
        "Umbrella 2",
        "in_progress",
        null,
        null,
        CHILD_THREE_TASK_ID,
        PROJECT_ID,
        "Completed Child",
        "done",
        null,
        LATER,
      )
      .run();

    // Umbrella 1 waits on Running Child (with branch and head_sha); Umbrella 2 waits on Completed Child
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, task_id, host_id, t3_project_id, thread_id, state, waiting_for_task_id, started_at, updated_at)
       VALUES (?, ?, 'default', 't3-proj', 'thread-u1', 'waiting_subagent', ?, ?, ?),
              (?, ?, 'default', 't3-proj', 'thread-u2', 'waiting_subagent', ?, ?, ?)`,
    )
      .bind(
        defaultIdGenerator(),
        PARENT_TASK_ID,
        CHILD_TASK_ID,
        STARTED_AT,
        STARTED_AT,
        defaultIdGenerator(),
        CHILD_TWO_TASK_ID,
        CHILD_THREE_TASK_ID,
        STARTED_AT,
        LATER,
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO agent_runs (id, task_id, host_id, t3_project_id, thread_id, state, parent_task_id, branch, head_sha, started_at, updated_at)
       VALUES (?, ?, 'default', 't3-proj', 'thread-c1', 'working', ?, 'feat/child-1', ?, ?, ?)`,
    )
      .bind(
        defaultIdGenerator(),
        CHILD_TASK_ID,
        PARENT_TASK_ID,
        "a".repeat(40),
        STARTED_AT + 100,
        STARTED_AT + 200,
      )
      .run();

    await apply0027Migration();

    const store = new T3D1Store(env.DB, DEFAULT_ORGANISATION_ID);

    // Existing waiting_for_task_id column stays readable for #BIT-189 transition
    expect((await store.getAgentRunByTaskId(PARENT_TASK_ID))?.waitingForTaskId).toBe(CHILD_TASK_ID);

    // Migrated rows in agent_run_children
    const migratedU1 = await store.listAgentRunChildren(PARENT_TASK_ID);
    expect(migratedU1).toEqual([
      {
        parentTaskId: PARENT_TASK_ID,
        childTaskId: CHILD_TASK_ID,
        state: "running",
        branch: "feat/child-1",
        headSha: "a".repeat(40),
        startedAt: new Date(STARTED_AT + 100).toISOString(),
      },
    ]);
    const migratedU2 = await store.listAgentRunChildren(CHILD_TWO_TASK_ID);
    expect(migratedU2).toEqual([
      {
        parentTaskId: CHILD_TWO_TASK_ID,
        childTaskId: CHILD_THREE_TASK_ID,
        state: "done",
        startedAt: new Date(LATER).toISOString(),
        finishedAt: new Date(LATER).toISOString(),
      },
    ]);

    // Umbrella 1 can add multiple parallel children
    const child2 = await store.addAgentRunChild({
      parentTaskId: PARENT_TASK_ID,
      childTaskId: CHILD_TWO_TASK_ID,
      state: "running",
      branch: "feat/child-2",
      startedAt: STARTED_AT + 300,
    });
    const child3 = await store.addAgentRunChild({
      parentTaskId: PARENT_TASK_ID,
      childTaskId: CHILD_THREE_TASK_ID,
      state: "running",
      branch: "feat/child-3",
      startedAt: STARTED_AT + 400,
    });
    expect(child2.state).toBe("running");
    expect(child3.state).toBe("running");

    const allChildren = await store.listAgentRunChildren(PARENT_TASK_ID);
    expect(allChildren.map((c) => c.childTaskId)).toEqual([
      CHILD_TASK_ID,
      CHILD_TWO_TASK_ID,
      CHILD_THREE_TASK_ID,
    ]);
    expect((await store.listAgentRunParentsForChild(CHILD_TWO_TASK_ID)).map((c) => c.parentTaskId)).toEqual([
      PARENT_TASK_ID,
    ]);

    // Single-flight claim transitions running child to done once
    const claimed = await store.claimAgentRunChild(PARENT_TASK_ID, CHILD_TASK_ID, {
      state: "done",
      headSha: "b".repeat(40),
      now: LATER,
    });
    expect(claimed).toMatchObject({
      parentTaskId: PARENT_TASK_ID,
      childTaskId: CHILD_TASK_ID,
      state: "done",
      branch: "feat/child-1",
      headSha: "b".repeat(40),
      finishedAt: new Date(LATER).toISOString(),
    });
    expect(
      await store.claimAgentRunChild(PARENT_TASK_ID, CHILD_TASK_ID, {
        state: "done",
        now: LATER + 100,
      }),
    ).toBeUndefined();

    // Record merge on completed child
    const merged = await store.recordAgentRunChildMerge(PARENT_TASK_ID, CHILD_TASK_ID, {
      mergedSha: "c".repeat(40),
      mergedAt: LATER + 500,
    });
    expect(merged).toMatchObject({
      mergedSha: "c".repeat(40),
      mergedAt: new Date(LATER + 500).toISOString(),
    });

    // Update child2 to needs_human
    const paused = await store.updateAgentRunChild(PARENT_TASK_ID, CHILD_TWO_TASK_ID, {
      state: "needs_human",
      now: LATER + 600,
    });
    expect(paused?.state).toBe("needs_human");
    expect(paused?.finishedAt).toBe(new Date(LATER + 600).toISOString());
  });
});

