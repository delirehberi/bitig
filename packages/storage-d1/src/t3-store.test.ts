import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0019_project_t3_threads.sql?raw";
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
