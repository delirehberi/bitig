import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DirEntry, FileSystemPort } from "@bitig/storage-markdown";
import { MarkdownStorage } from "@bitig/storage-markdown";
import { D1Storage } from "./d1-storage";

class MemoryFileSystem implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly bytes = new Map<string, Uint8Array>();
  private readonly dirs = new Set<string>([""]);

  readText(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  writeTextAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  readBytes(path: string): Promise<Uint8Array | null> {
    const raw = this.bytes.get(path);
    return Promise.resolve(raw ? new Uint8Array(raw) : null);
  }

  writeBytesAtomic(path: string, content: Uint8Array): Promise<void> {
    this.bytes.set(path, new Uint8Array(content));
    return Promise.resolve();
  }

  listDir(path: string): Promise<DirEntry[] | null> {
    if (!this.dirs.has(path) && path !== "") return Promise.resolve(null);
    const prefix = path === "" ? "" : `${path}/`;
    const entries = new Map<string, DirEntry>();

    for (const d of this.dirs) {
      if (d !== path && d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name) entries.set(name, { name, kind: "directory" });
      }
    }
    for (const f of [...this.files.keys(), ...this.bytes.keys()]) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        if (!rest.includes("/")) {
          entries.set(rest, { name: rest, kind: "file" });
        }
      }
    }
    return Promise.resolve([...entries.values()]);
  }

  makeDir(path: string): Promise<void> {
    this.dirs.add(path);
    return Promise.resolve();
  }

  removeFile(path: string): Promise<void> {
    this.files.delete(path);
    this.bytes.delete(path);
    return Promise.resolve();
  }

  removeDir(path: string): Promise<void> {
    this.dirs.delete(path);
    const prefix = `${path}/`;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.bytes.keys()]) {
      if (key.startsWith(prefix)) this.bytes.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key.startsWith(prefix)) this.dirs.delete(key);
    }
    return Promise.resolve();
  }

  fileExists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path) || this.bytes.has(path));
  }
}

const STATEMENTS = [
  "DROP TABLE IF EXISTS `feedback_entries`",
  "DROP TABLE IF EXISTS `feedback_forms`",
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
  `CREATE TABLE \`feedback_forms\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
    \`project_id\` text NOT NULL,
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
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `feedback_forms_public_id_unique` ON `feedback_forms` (`public_id`)",
  "CREATE INDEX `feedback_forms_org_id_idx` ON `feedback_forms` (`org_id`)",
  "CREATE INDEX `feedback_forms_project_id_idx` ON `feedback_forms` (`project_id`)",
  `CREATE TABLE \`feedback_entries\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text,
    \`form_id\` text NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL,
    \`project_id\` text NOT NULL,
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
    \`created_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE set null,
    FOREIGN KEY (\`form_id\`) REFERENCES \`feedback_forms\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `feedback_entries_form_outcome_idx` ON `feedback_entries` (`form_id`, `outcome`)",
  "CREATE INDEX `feedback_entries_task_id_idx` ON `feedback_entries` (`task_id`)",
  "CREATE INDEX `feedback_entries_duplicate_idx` ON `feedback_entries` (`form_id`, `ip_hash`, `body_hash`, `created_at`)",
];

async function resetDb(): Promise<void> {
  await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
}

describe("Cross-Mode Round-Trip Interoperability", () => {
  it("round-trips a project and diverse tasks across Markdown -> D1 -> Markdown without data loss", async () => {
    await resetDb();

    // 1. Initialize source Markdown storage
    const markdownFs = new MemoryFileSystem();
    const markdownStorage = new MarkdownStorage({ fs: markdownFs });

    // 2. Initialize D1 storage
    const d1Storage = new D1Storage(env.DB);

    // 3. Create rich source project in Markdown storage
    const project = await markdownStorage.createProject({
      name: "Cross-Mode Interop Project",
      kind: "open_source",
      description: "Testing lossless roundtrip across Markdown and D1",
      resources: [
        { type: "repository", label: "Code", url: "https://github.com/acme/interop" },
        { type: "issue_tracker", label: "Jira: INT", url: "https://acme.atlassian.net/browse/INT" },
      ],
    });

    const task1 = await markdownStorage.saveTask({
      projectId: project.id,
      title: "Public Urgent Bug",
      description: "Must be fixed ASAP with public visibility",
      status: "in_progress",
      priority: "urgent",
      dueDate: "2026-12-31",
      labels: ["security", "urgent"],
      order: 10,
      isPublic: true,
      checklist: [
        { text: "Reproduce", done: true },
        { text: "Patch", done: false },
      ],
    });

    const task2 = await markdownStorage.saveTask({
      projectId: project.id,
      title: "Private Confidential Feature",
      description: "Private task content",
      status: "todo",
      priority: "high",
      labels: ["confidential"],
      order: 20,
      isPublic: false,
      checklist: [{ text: "Private subtask", done: false }],
    });

    const task3 = await markdownStorage.saveTask({
      projectId: project.id,
      title: "Completed Maintenance",
      description: "Already finished task",
      status: "done",
      priority: "trivial",
      isPublic: true,
    });

    const task4 = await markdownStorage.saveTask({
      projectId: project.id,
      title: "Archived Legacy Task",
      description: "Archived item without priority or labels",
      status: "archived",
      isPublic: false,
    });

    // Step A: Export bundle from Markdown storage
    const markdownBundle = await markdownStorage.exportProject(project.id);
    expect(markdownBundle.version).toBe(1);
    expect(markdownBundle.project).toEqual(project);
    expect(markdownBundle.tasks).toEqual([task1, task2, task3, task4]);

    // Step B: Import into D1 storage
    const d1Project = await d1Storage.importProject(markdownBundle);
    expect(d1Project).toEqual(project);

    // Export bundle from D1 storage
    const d1Bundle = await d1Storage.exportProject(project.id);
    expect(d1Bundle.project).toEqual(project);
    expect(d1Bundle.tasks).toEqual([task1, task2, task3, task4]);

    // Step C: Import back into a fresh, completely separate Markdown storage instance
    const freshMarkdownFs = new MemoryFileSystem();
    const freshMarkdownStorage = new MarkdownStorage({ fs: freshMarkdownFs });
    const restoredProject = await freshMarkdownStorage.importProject(d1Bundle);
    expect(restoredProject).toEqual(project);

    // Export bundle from restored Markdown storage
    const restoredBundle = await freshMarkdownStorage.exportProject(project.id);

    // FINAL ASSERTION: Zero loss across both modes
    expect(restoredBundle.project).toEqual(project);
    expect(restoredBundle.tasks).toEqual([task1, task2, task3, task4]);
    expect(restoredBundle.version).toBe(markdownBundle.version);
  });
});
