import { env } from "cloudflare:workers";
import { describe, expect, it, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import { D1Storage } from "./d1-storage";
import * as schema from "./schema";

const STATEMENTS = [
  "DROP TABLE IF EXISTS `webhooks`",
  "DROP TABLE IF EXISTS `attachments`",
  "DROP TABLE IF EXISTS `checkpoints`",
  "DROP TABLE IF EXISTS `comments`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
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
  "CREATE INDEX `projects_org_id_idx` ON `projects` (`org_id`)",
  "CREATE UNIQUE INDEX `projects_org_key_unique` ON `projects` (`org_id`, `key`)",
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
];

describe("D1Storage extra tests", () => {
  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  it("can be constructed with options object or raw D1Database", async () => {
    const storageFromRaw = new D1Storage(env.DB);
    const p1 = await storageFromRaw.createProject({ name: "From Raw" });
    expect(p1.name).toBe("From Raw");

    const storageFromOpts = new D1Storage({ db: env.DB });
    const p2 = await storageFromOpts.createProject({ name: "From Opts" });
    expect(p2.name).toBe("From Opts");

    const drizzleDb = drizzle(env.DB, { schema });
    const storageFromDrizzle = new D1Storage({ db: drizzleDb });
    const p3 = await storageFromDrizzle.createProject({ name: "From Drizzle" });
    expect(p3.name).toBe("From Drizzle");
  });

  it("cascades task deletion when project is deleted", async () => {
    const storage = new D1Storage(env.DB);
    const proj = await storage.createProject({ name: "Cascade Project" });
    const task = await storage.saveTask({ projectId: proj.id, title: "Cascade Task" });

    expect(await storage.getTask(task.id)).not.toBeNull();
    await storage.deleteProject(proj.id);
    expect(await storage.getProject(proj.id)).toBeNull();
    expect(await storage.getTask(task.id)).toBeNull();
  });

  it("assigns distinct sequential numbers when tasks are saved or moved concurrently", async () => {
    const storage = new D1Storage(env.DB);
    const proj = await storage.createProject({ name: "Concurrent Project", key: "ULA" });
    const otherProj = await storage.createProject({ name: "Other Project", key: "OTH" });

    const created = await Promise.all([
      storage.saveTask({ projectId: proj.id, title: "Task A" }),
      storage.saveTask({ projectId: proj.id, title: "Task B" }),
      storage.saveTask({ projectId: proj.id, title: "Task C" }),
      storage.saveTask({ projectId: proj.id, title: "Task D" }),
    ]);

    expect(created.map((t) => t.number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([1, 2, 3, 4]);

    const otherTasks = await Promise.all([
      storage.saveTask({ projectId: otherProj.id, title: "Move 1" }),
      storage.saveTask({ projectId: otherProj.id, title: "Move 2" }),
      storage.saveTask({ projectId: otherProj.id, title: "Move 3" }),
    ]);

    const moved = await Promise.all(
      otherTasks.map((t) => storage.updateTask(t.id, { projectId: proj.id })),
    );

    expect(moved.map((t) => t.number).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([5, 6, 7]);
  });
});

