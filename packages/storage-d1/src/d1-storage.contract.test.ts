import { env } from "cloudflare:workers";
import { runStorageContractSuite, type TestRuntime } from "@bitig/core/testing";
import { D1Storage } from "./d1-storage";

const STATEMENTS = [
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  `CREATE TABLE \`projects\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`kind\` text DEFAULT 'hobby' NOT NULL,
    \`resources\` text,
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
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `tasks_project_id_idx` ON `tasks` (`project_id`)",
  "CREATE INDEX `tasks_status_idx` ON `tasks` (`status`)",
  "CREATE INDEX `tasks_order_idx` ON `tasks` (`order`)",
];

async function resetDb(): Promise<void> {
  await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
}

runStorageContractSuite("D1Storage", async (runtime: TestRuntime) => {
  await resetDb();
  const storage = new D1Storage(env.DB, runtime);

  return {
    storage,
    dispose: async () => {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM `tasks`"),
        env.DB.prepare("DELETE FROM `projects`"),
      ]);
    },
  };
});

