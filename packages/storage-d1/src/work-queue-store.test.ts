import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import migration from "../migrations/0030_work_queues.sql?raw";
import {
  DEFAULT_HOST_MAX_PARALLEL_RUNS,
  DEFAULT_ORGANISATION_ID,
  NotFoundError,
  ValidationError,
  WORK_QUEUE_WAITING_REASON_MAX,
  defaultIdGenerator,
} from "@bitig/core";
import { D1WorkQueueStore } from "./work-queue-store";

const OTHER_ORG_ID = "01a10000-0000-7000-8000-000000000002";
const PROJECT_ID = "01a14ecf-281e-7436-8c52-a524c5fabc2f";
const TASK_A = "01a1e22a-001e-7284-b821-87e76f3986a7";
const TASK_B = "01a1e22a-001e-7284-b821-87e76f3986a8";
const TASK_C = "01a1e22a-001e-7284-b821-87e76f3986a9";
const HOST_ID = "01a1e22a-0000-7000-8000-000000000010";
const MISSING_HOST_ID = "01a1e22a-0000-7000-8000-000000000099";
const NOW = Date.parse("2026-11-16T06:00:00.000Z");
const LATER = Date.parse("2026-11-16T07:00:00.000Z");
const NOW_ISO = "2026-11-16T06:00:00.000Z";
const LATER_ISO = "2026-11-16T07:00:00.000Z";

/** Pre-0030 shape of the tables this store touches; the migration is applied on top. */
const SETUP = [
  "DROP TABLE IF EXISTS `work_queue_items`",
  "DROP TABLE IF EXISTS `work_queues`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  "DROP TABLE IF EXISTS `t3_connections`",
  "CREATE TABLE `projects` (`id` text PRIMARY KEY NOT NULL, `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL, `name` text NOT NULL)",
  "CREATE TABLE `tasks` (`id` text PRIMARY KEY NOT NULL, `project_id` text NOT NULL, `title` text NOT NULL, FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade)",
  "CREATE TABLE `t3_connections` (`id` text PRIMARY KEY NOT NULL, `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL, `mcp_url` text NOT NULL)",
];

function statementsOf(sqlText: string): string[] {
  return sqlText
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function expectRejection(promise: Promise<unknown>, type: abstract new (...args: never[]) => Error): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(type);
}

describe("D1WorkQueueStore (BIT-200)", () => {
  let store: D1WorkQueueStore;

  beforeEach(async () => {
    for (const statement of SETUP) {
      await env.DB.prepare(statement).run();
    }
    for (const statement of statementsOf(migration)) {
      await env.DB.prepare(statement).run();
    }
    await env.DB.prepare("INSERT INTO projects (id, name) VALUES (?, ?)").bind(PROJECT_ID, "Bitig").run();
    await env.DB.prepare("INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)")
      .bind(TASK_A, PROJECT_ID, "A", TASK_B, PROJECT_ID, "B", TASK_C, PROJECT_ID, "C")
      .run();
    await env.DB.prepare("INSERT INTO t3_connections (id, mcp_url) VALUES (?, ?)")
      .bind(HOST_ID, "https://t3.example/mcp")
      .run();
    store = new D1WorkQueueStore(env.DB);
  });

  describe("queues", () => {
    it("creates a planning queue and reads it back with its org and timestamps", async () => {
      const id = defaultIdGenerator();
      const created = await store.createQueue({ id, createdBy: "Emre", prompt: "BIT-1 and BIT-2", now: NOW });

      expect(created).toEqual({
        id,
        orgId: DEFAULT_ORGANISATION_ID,
        createdBy: "Emre",
        prompt: "BIT-1 and BIT-2",
        state: "planning",
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
      });
      expect(await store.getQueue(id)).toEqual(created);
    });

    it("hides queues from another organisation", async () => {
      const id = defaultIdGenerator();
      await store.createQueue({ id, createdBy: "Emre", prompt: "BIT-1", now: NOW });

      const foreign = new D1WorkQueueStore(env.DB, OTHER_ORG_ID);
      expect(await foreign.getQueue(id)).toBeUndefined();
      expect(await foreign.listQueues()).toEqual([]);
      await expectRejection(foreign.transitionQueue(id, "active", LATER), NotFoundError);
    });

    it("lists open queues newest first and drops finished ones when asked for open only", async () => {
      const older = defaultIdGenerator();
      const newer = defaultIdGenerator();
      const finished = defaultIdGenerator();
      await store.createQueue({ id: older, createdBy: "Emre", prompt: "old", now: NOW });
      await store.createQueue({ id: newer, createdBy: "Emre", prompt: "new", now: LATER });
      await store.createQueue({ id: finished, createdBy: "Emre", prompt: "finished", now: NOW - 1_000 });
      await store.transitionQueue(finished, "cancelled", LATER);

      expect((await store.listQueues()).map((queue) => queue.id)).toEqual([newer, older, finished]);
      expect((await store.listQueues({ openOnly: true })).map((queue) => queue.id)).toEqual([newer, older]);
    });

    it("follows the queue state machine and rejects invalid moves", async () => {
      const id = defaultIdGenerator();
      await store.createQueue({ id, createdBy: "Emre", prompt: "BIT-1", now: NOW });

      await expectRejection(store.transitionQueue(id, "done", LATER), ValidationError);

      const active = await store.transitionQueue(id, "active", LATER);
      expect(active).toMatchObject({ state: "active", updatedAt: LATER_ISO, createdAt: NOW_ISO });
      await store.transitionQueue(id, "paused", LATER);
      await store.transitionQueue(id, "active", LATER);
      expect((await store.transitionQueue(id, "done", LATER)).state).toBe("done");
      await expectRejection(store.transitionQueue(id, "active", LATER), ValidationError);
    });

    it("reports unknown queues as not found", async () => {
      await expectRejection(store.transitionQueue(defaultIdGenerator(), "active", LATER), NotFoundError);
    });
  });

  describe("entries", () => {
    async function createActiveQueue(prompt = "BIT-1 BIT-2"): Promise<string> {
      const id = defaultIdGenerator();
      await store.createQueue({ id, createdBy: "Emre", prompt, now: NOW });
      await store.transitionQueue(id, "active", NOW);
      return id;
    }

    it("adds entries with a resolved selection snapshot and lists them in position order", async () => {
      const queueId = await createActiveQueue();
      const selection = {
        providerInstanceId: "claudeAgent",
        model: "claude-haiku-5-5",
        options: [{ id: "effort", value: "medium" }],
      };
      const second = await store.addEntry({
        id: defaultIdGenerator(),
        queueId,
        taskId: TASK_B,
        position: 1,
        lane: PROJECT_ID,
        now: NOW,
      });
      const first = await store.addEntry({
        id: defaultIdGenerator(),
        queueId,
        taskId: TASK_A,
        position: 0,
        lane: PROJECT_ID,
        resolvedSelection: selection,
        umbrellaTaskId: TASK_C,
        now: NOW,
      });

      expect(first).toMatchObject({
        queueId,
        taskId: TASK_A,
        position: 0,
        lane: PROJECT_ID,
        state: "waiting",
        waitingReason: null,
        resolvedSelection: selection,
        umbrellaTaskId: TASK_C,
        createdAt: NOW_ISO,
      });
      expect(second.resolvedSelection).toBeNull();
      expect(second.umbrellaTaskId).toBeNull();
      expect((await store.listEntries(queueId)).map((entry) => entry.taskId)).toEqual([TASK_A, TASK_B]);
    });

    it("rejects a duplicate position inside one queue", async () => {
      const queueId = await createActiveQueue();
      await store.addEntry({ id: defaultIdGenerator(), queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });
      await expect(
        store.addEntry({ id: defaultIdGenerator(), queueId, taskId: TASK_B, position: 0, lane: PROJECT_ID, now: NOW }),
      ).rejects.toThrow();
    });

    it("refuses to add entries to a closed queue or for an unknown queue", async () => {
      const queueId = await createActiveQueue();
      await store.transitionQueue(queueId, "cancelled", LATER);
      await expectRejection(
        store.addEntry({ id: defaultIdGenerator(), queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: LATER }),
        ValidationError,
      );
      await expectRejection(
        store.addEntry({ id: defaultIdGenerator(), queueId: defaultIdGenerator(), taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW }),
        NotFoundError,
      );
    });

    it("refuses tasks that are not in the queue's organisation", async () => {
      const queueId = await createActiveQueue();
      const unknownTask = defaultIdGenerator();
      await expectRejection(
        store.addEntry({ id: defaultIdGenerator(), queueId, taskId: unknownTask, position: 0, lane: PROJECT_ID, now: NOW }),
        NotFoundError,
      );
    });

    it("enforces one active entry per task across queues", async () => {
      const first = await createActiveQueue("first");
      const second = await createActiveQueue("second");
      await store.addEntry({ id: defaultIdGenerator(), queueId: first, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });

      await expectRejection(
        store.addEntry({ id: defaultIdGenerator(), queueId: second, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW }),
        ValidationError,
      );
      expect((await store.findActiveEntryForTask(TASK_A))?.queueId).toBe(first);
    });

    it("enforces the one-active rule in the database even when the store check is bypassed", async () => {
      const queueId = await createActiveQueue();
      await store.addEntry({ id: defaultIdGenerator(), queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });

      await expect(
        env.DB.prepare(
          "INSERT INTO work_queue_items (id, queue_id, task_id, position, lane, state, created_at, updated_at) VALUES (?, ?, ?, 1, ?, 'ready', ?, ?)",
        )
          .bind(defaultIdGenerator(), queueId, TASK_A, PROJECT_ID, NOW, NOW)
          .run(),
      ).rejects.toThrow();
    });

    it("lets a task re-enter a queue once its previous entry is finished", async () => {
      const queueId = await createActiveQueue();
      const firstId = defaultIdGenerator();
      await store.addEntry({ id: firstId, queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });
      await store.transitionEntry(firstId, { to: "skipped", now: LATER });

      expect(await store.findActiveEntryForTask(TASK_A)).toBeUndefined();
      const retry = await store.addEntry({ id: defaultIdGenerator(), queueId, taskId: TASK_A, position: 1, lane: PROJECT_ID, now: LATER });
      expect(retry.state).toBe("waiting");
    });

    it("walks an entry through its states, records the waiting reason and rejects invalid moves", async () => {
      const queueId = await createActiveQueue();
      const id = defaultIdGenerator();
      await store.addEntry({ id, queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });

      await expectRejection(store.transitionEntry(id, { to: "running", now: LATER }), ValidationError);
      await expectRejection(
        store.transitionEntry(id, { to: "ready", waitingReason: "x".repeat(WORK_QUEUE_WAITING_REASON_MAX + 1), now: LATER }),
        ValidationError,
      );
      expect((await store.listEntries(queueId))[0]?.state).toBe("waiting");

      await store.transitionEntry(id, { to: "ready", now: LATER });
      const waiting = await store.transitionEntry(id, { to: "waiting", waitingReason: "waits on BIT-B", now: LATER });
      expect(waiting).toMatchObject({ state: "waiting", waitingReason: "waits on BIT-B", updatedAt: LATER_ISO });

      await store.transitionEntry(id, { to: "ready", now: LATER });
      const running = await store.transitionEntry(id, { to: "running", now: LATER });
      expect(running).toMatchObject({ state: "running", waitingReason: null });
      await store.transitionEntry(id, { to: "merged", now: LATER });
      expect((await store.transitionEntry(id, { to: "done", now: LATER })).state).toBe("done");

      await expectRejection(store.transitionEntry(id, { to: "waiting", now: LATER }), ValidationError);
      expect(await store.findActiveEntryForTask(TASK_A)).toBeUndefined();
    });

    it("moves a running entry to failed and keeps the task out of the active set", async () => {
      const queueId = await createActiveQueue();
      const id = defaultIdGenerator();
      await store.addEntry({ id, queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });
      await store.transitionEntry(id, { to: "ready", now: LATER });
      await store.transitionEntry(id, { to: "running", now: LATER });
      expect((await store.transitionEntry(id, { to: "failed", now: LATER })).state).toBe("failed");
      expect(await store.findActiveEntryForTask(TASK_A)).toBeUndefined();
    });

    it("reports unknown entries as not found", async () => {
      await expectRejection(store.transitionEntry(defaultIdGenerator(), { to: "ready", now: NOW }), NotFoundError);
    });

    it("does not let another organisation move or list entries", async () => {
      const queueId = await createActiveQueue();
      const id = defaultIdGenerator();
      await store.addEntry({ id, queueId, taskId: TASK_A, position: 0, lane: PROJECT_ID, now: NOW });

      const foreign = new D1WorkQueueStore(env.DB, OTHER_ORG_ID);
      await expectRejection(foreign.transitionEntry(id, { to: "ready", now: LATER }), NotFoundError);
      await expectRejection(foreign.listEntries(queueId), NotFoundError);
      expect(await foreign.findActiveEntryForTask(TASK_A)).toBeUndefined();
    });
  });

  describe("host parallel run cap", () => {
    it("uses the code default while the host has no stored cap", async () => {
      expect(DEFAULT_HOST_MAX_PARALLEL_RUNS).toBe(3);
      expect(await store.getHostMaxParallelRuns(HOST_ID)).toBe(3);
    });

    it("stores an explicit cap, reads it back, and clears it with null", async () => {
      expect(await store.setHostMaxParallelRuns(HOST_ID, 5)).toBe(5);
      expect(await store.getHostMaxParallelRuns(HOST_ID)).toBe(5);

      expect(await store.setHostMaxParallelRuns(HOST_ID, null)).toBe(DEFAULT_HOST_MAX_PARALLEL_RUNS);
      expect(await store.getHostMaxParallelRuns(HOST_ID)).toBe(DEFAULT_HOST_MAX_PARALLEL_RUNS);
    });

    it("rejects caps outside 1..20 and non-integers without touching the stored value", async () => {
      await store.setHostMaxParallelRuns(HOST_ID, 2);
      await expectRejection(store.setHostMaxParallelRuns(HOST_ID, 0), ValidationError);
      await expectRejection(store.setHostMaxParallelRuns(HOST_ID, 21), ValidationError);
      await expectRejection(store.setHostMaxParallelRuns(HOST_ID, 2.5), ValidationError);
      expect(await store.getHostMaxParallelRuns(HOST_ID)).toBe(2);
    });

    it("reports unknown hosts as not found and scopes the cap to the organisation", async () => {
      await expectRejection(store.getHostMaxParallelRuns(MISSING_HOST_ID), NotFoundError);
      await expectRejection(store.setHostMaxParallelRuns(MISSING_HOST_ID, 4), NotFoundError);

      const foreign = new D1WorkQueueStore(env.DB, OTHER_ORG_ID);
      await expectRejection(foreign.setHostMaxParallelRuns(HOST_ID, 9), NotFoundError);
      await expectRejection(foreign.getHostMaxParallelRuns(HOST_ID), NotFoundError);
      expect(await store.getHostMaxParallelRuns(HOST_ID)).toBe(DEFAULT_HOST_MAX_PARALLEL_RUNS);
    });
  });
});
