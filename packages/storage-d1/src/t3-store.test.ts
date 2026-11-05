import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0019_project_t3_threads.sql?raw";
import subagentMigration from "../migrations/0021_agent_run_subagents.sql?raw";
import { defaultIdGenerator } from "@bitig/core";
import { T3D1Store, type SaveProjectT3ThreadInput } from "./t3-store";

const PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc2f";
const OTHER_PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc30";
const STARTED_AT = Date.parse("2026-11-03T10:00:00.000Z");
const LATER = Date.parse("2026-11-03T11:00:00.000Z");

const SETUP = [
  "DROP TABLE IF EXISTS `project_t3_threads`",
  "DROP TABLE IF EXISTS `projects`",
  "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `name` text NOT NULL)",
];

function threadInput(overrides: Partial<SaveProjectT3ThreadInput> = {}): SaveProjectT3ThreadInput {
  return {
    id: defaultIdGenerator(),
    projectId: PROJECT_ID,
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

  it("scopes threads to their project and lists newest first", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput({ threadId: "old" }));
    await store.saveProjectThread(threadInput({ threadId: "new", startedAt: LATER, updatedAt: LATER }));
    await store.saveProjectThread(threadInput({ threadId: "elsewhere", projectId: OTHER_PROJECT_ID }));

    expect((await store.listProjectThreads(PROJECT_ID)).map((t) => t.threadId)).toEqual(["new", "old"]);
    expect(await store.listProjectThreads()).toHaveLength(3);
    expect(await store.getProjectThread(PROJECT_ID, "elsewhere")).toBeUndefined();
  });

  it("rejects a second record for the same T3 thread", async () => {
    const store = new T3D1Store(env.DB);
    await store.saveProjectThread(threadInput());
    await expect(store.saveProjectThread(threadInput())).rejects.toThrow();
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

/** `agent_runs` as it stood before #BIT-141, so the test also applies migration 0021. */
const AGENT_RUN_SETUP = [
  "DROP TABLE IF EXISTS `agent_runs`",
  "DROP TABLE IF EXISTS `tasks`",
  "CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `title` text NOT NULL)",
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
    for (const statement of subagentMigration.split("--> statement-breakpoint")) {
      await env.DB.prepare(statement.trim()).run();
    }
    await env.DB.prepare("INSERT INTO tasks (id, title) VALUES (?, ?), (?, ?)")
      .bind(PARENT_TASK_ID, "Umbrella", CHILD_TASK_ID, "Child")
      .run();
  });

  function runInput(taskId: string, threadId: string, parentTaskId?: string) {
    return {
      id: defaultIdGenerator(),
      taskId,
      t3ProjectId: "t3-project",
      threadId,
      state: "working" as const,
      ...(parentTaskId ? { parentTaskId } : {}),
      startedAt: STARTED_AT,
      updatedAt: STARTED_AT,
    };
  }

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
});
