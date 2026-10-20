import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { DirEntry, FileSystemPort } from "@bitig/storage-markdown";
import { MarkdownStorage } from "@bitig/storage-markdown";
import { NostrStorage, PrivateKeySigner, RelayManager } from "@bitig/storage-nostr";
import type { VerifiedEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { matchFilters } from "nostr-tools/filter";
import { D1Storage } from "./d1-storage";

class MemoryFileSystem implements FileSystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>([""]);

  readText(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  writeTextAtomic(path: string, content: string): Promise<void> {
    this.files.set(path, content);
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
    for (const f of this.files.keys()) {
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
    return Promise.resolve();
  }

  removeDir(path: string): Promise<void> {
    this.dirs.delete(path);
    const prefix = `${path}/`;
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key.startsWith(prefix)) this.dirs.delete(key);
    }
    return Promise.resolve();
  }

  fileExists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
}

class MemoryRelayManager extends RelayManager {
  private events: VerifiedEvent[] = [];

  constructor() {
    super({ relays: ["ws://mock-relay"] });
  }

  override publishEvent(event: VerifiedEvent): Promise<void> {
    if (event.kind >= 30000 && event.kind < 40000) {
      const dTag = event.tags.find((t) => t[0] === "d")?.[1];
      this.events = this.events.filter((existing) => {
        if (existing.kind !== event.kind || existing.pubkey !== event.pubkey) return true;
        const existingD = existing.tags.find((t) => t[0] === "d")?.[1];
        return existingD !== dTag;
      });
    }
    this.events.push(event);
    return Promise.resolve();
  }

  override queryEvents(filter: Filter): Promise<VerifiedEvent[]> {
    return Promise.resolve(this.events.filter((ev) => matchFilters([filter], ev)));
  }
}

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

describe("Cross-Mode Round-Trip Interoperability", () => {
  it("round-trips a project and diverse tasks across Markdown -> D1 -> Nostr -> Markdown without data loss", async () => {
    await resetDb();

    // 1. Initialize source Markdown storage
    const markdownFs = new MemoryFileSystem();
    const markdownStorage = new MarkdownStorage({ fs: markdownFs });

    // 2. Initialize D1 storage
    const d1Storage = new D1Storage(env.DB);

    // 3. Initialize Nostr storage with self-encrypting NIP-44 signer
    const nostrSigner = new PrivateKeySigner();
    const nostrRelayManager = new MemoryRelayManager();
    const nostrStorage = new NostrStorage({
      signer: nostrSigner,
      relayManager: nostrRelayManager,
    });

    // 4. Create rich source project in Markdown storage
    const project = await markdownStorage.createProject({
      name: "Cross-Mode Interop Project",
      kind: "open_source",
      description: "Testing lossless roundtrip across Markdown, D1, and Nostr",
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
      description: "Top secret NIP-44 encrypted task content",
      status: "todo",
      priority: "high",
      labels: ["confidential"],
      order: 20,
      isPublic: false,
      checklist: [{ text: "Encrypted subtask", done: false }],
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

    // Step C: Import into Nostr storage (encrypting private tasks)
    const nostrProject = await nostrStorage.importProject(d1Bundle);
    expect(nostrProject).toEqual(project);

    // Export bundle from Nostr storage (decrypting private tasks)
    const nostrBundle = await nostrStorage.exportProject(project.id);
    expect(nostrBundle.project).toEqual(project);
    expect(nostrBundle.tasks).toEqual([task1, task2, task3, task4]);

    // Step D: Import back into a fresh, completely separate Markdown storage instance
    const freshMarkdownFs = new MemoryFileSystem();
    const freshMarkdownStorage = new MarkdownStorage({ fs: freshMarkdownFs });
    const restoredProject = await freshMarkdownStorage.importProject(nostrBundle);
    expect(restoredProject).toEqual(project);

    // Export bundle from restored Markdown storage
    const restoredBundle = await freshMarkdownStorage.exportProject(project.id);

    // FINAL ASSERTION: Zero loss across all three modes
    expect(restoredBundle.project).toEqual(project);
    expect(restoredBundle.tasks).toEqual([task1, task2, task3, task4]);
    expect(restoredBundle.version).toBe(markdownBundle.version);
  });
});
