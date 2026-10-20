import { env } from "cloudflare:workers";
import { runStorageContractSuite, type TestRuntime } from "@bitig/core/testing";
import { D1Storage } from "@bitig/storage-d1";
import { ApiStorage } from "@bitig/api-client";
import { createApp } from "../src/index";
import { TEST_AUTH_HEADER } from "./constants";

const BASE_URL = "https://bitig.test";

const STATEMENTS = [
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
    \`number\` integer,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `tasks_project_id_idx` ON `tasks` (`project_id`)",
  "CREATE INDEX `tasks_status_idx` ON `tasks` (`status`)",
  "CREATE INDEX `tasks_order_idx` ON `tasks` (`order`)",
  "CREATE INDEX `tasks_project_number_idx` ON `tasks` (`project_id`,`number`)",
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
];

async function resetDb(): Promise<void> {
  await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
}

runStorageContractSuite("ApiStorage", async (runtime: TestRuntime) => {
  await resetDb();
  const app = createApp({
    storageFactory: () => new D1Storage(env.DB, runtime),
  });

  const storage = new ApiStorage({
    baseUrl: BASE_URL,
    auth: TEST_AUTH_HEADER,
    fetch: async (url, init) => await app.fetch(new Request(url, init), env),
  });

  return {
    storage,
    dispose: async () => {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM `comments`"),
        env.DB.prepare("DELETE FROM `tasks`"),
        env.DB.prepare("DELETE FROM `projects`"),
      ]);
    },
  };
});
