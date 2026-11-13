import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ORGANISATION_ID,
  FEEDBACK_DUPLICATE_WINDOW_MS,
  FEEDBACK_PURGE_RETENTION_MS,
  NotFoundError,
  ValidationError,
} from "@bitig/core";
import { createTestRuntime } from "@bitig/core/testing";
import migration from "../migrations/0028_feedback_forms.sql?raw";
import { D1Storage } from "./d1-storage";
import { D1FeedbackStore, findFormByPublicId } from "./feedback-store";

const SECOND_ORG_ID = "01a10000-0000-7000-8000-000000000002";

const BASE_STATEMENTS = [
  "DROP TABLE IF EXISTS `feedback_entries`",
  "DROP TABLE IF EXISTS `feedback_forms`",
  "DROP TABLE IF EXISTS `webhooks`",
  "DROP TABLE IF EXISTS `attachments`",
  "DROP TABLE IF EXISTS `checkpoints`",
  "DROP TABLE IF EXISTS `comments`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  "DROP TABLE IF EXISTS `organisations`",
  `CREATE TABLE \`organisations\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`slug\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`deleted_at\` integer
  )`,
  `CREATE TABLE \`projects\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL REFERENCES \`organisations\`(\`id\`) ON DELETE cascade,
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
    \`project_id\` text NOT NULL REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade,
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
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`comments\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL REFERENCES \`tasks\`(\`id\`) ON DELETE cascade,
    \`body\` text NOT NULL,
    \`author_type\` text NOT NULL,
    \`author\` text,
    \`author_id\` text,
    \`author_avatar_url\` text,
    \`created_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`attachments\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL REFERENCES \`tasks\`(\`id\`) ON DELETE cascade,
    \`name\` text NOT NULL,
    \`mime_type\` text NOT NULL,
    \`size\` integer NOT NULL,
    \`created_at\` integer NOT NULL,
    \`created_by\` text
  )`,
  `CREATE TABLE \`checkpoints\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL REFERENCES \`tasks\`(\`id\`) ON DELETE cascade,
    \`step_index\` integer NOT NULL,
    \`status\` text NOT NULL,
    \`state_snapshot\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`created_by\` text
  )`,
  `CREATE TABLE \`webhooks\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`project_id\` text NOT NULL REFERENCES \`projects\`(\`id\`) ON DELETE cascade,
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
    \`updated_at\` integer NOT NULL
  )`,
];

describe("D1FeedbackStore (BIT-175)", () => {
  beforeEach(async () => {
    await env.DB.batch(BASE_STATEMENTS.map((sql) => env.DB.prepare(sql)));
    for (const statement of migration.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) {
        await env.DB.prepare(trimmed).run();
      }
    }
    const now = Date.parse("2026-11-12T00:00:00.000Z");
    await env.DB.prepare(
      "INSERT INTO `organisations` (`id`, `name`, `slug`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)",
    )
      .bind(
        DEFAULT_ORGANISATION_ID,
        "Default Org",
        "default",
        now,
        now,
        SECOND_ORG_ID,
        "Second Org",
        "second",
        now,
        now,
      )
      .run();
  });

  it("performs form CRUD scoped by organisation and resolves orgId via findFormByPublicId", async () => {
    const runtime = createTestRuntime();
    const org1Storage = new D1Storage({ db: env.DB, orgId: DEFAULT_ORGANISATION_ID, deps: runtime });
    const org2Storage = new D1Storage({ db: env.DB, orgId: SECOND_ORG_ID, deps: runtime });

    const p1 = await org1Storage.createProject({ name: "Alpha", key: "ALP" });
    const p2 = await org2Storage.createProject({ name: "Beta", key: "BET" });

    const org1Feedback = new D1FeedbackStore({
      db: env.DB,
      orgId: DEFAULT_ORGANISATION_ID,
      deps: runtime,
    });
    const org2Feedback = new D1FeedbackStore(env.DB, SECOND_ORG_ID, runtime);

    // Cannot create a form on another org's project
    await expect(
      org1Feedback.createForm({
        projectId: p2.id,
        name: "Cross-org attempt",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const form1 = await org1Feedback.createForm(
      {
        projectId: p1.id,
        name: "Bug Reports",
        title: "Report a bug",
        intro: "Let us know what went wrong.",
        fields: {
          email: "required",
          name: true,
          categories: ["UI", "API"],
          bannedWords: ["crypto"],
        },
        allowedOrigins: ["https://app.example.com/"],
        turnstile: true,
        defaultLabels: ["triage", "customer"],
        defaultPriority: "high",
        thankYouText: "Thanks for reporting!",
        accentColor: "#2563EB",
        bannedWords: ["spamlink"],
      },
      { actor: "emre" },
    );

    expect(form1.orgId).toBe(DEFAULT_ORGANISATION_ID);
    expect(form1.projectId).toBe(p1.id);
    expect(form1.publicId.length).toBeGreaterThanOrEqual(16);
    expect(form1.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(form1.fields).toEqual({
      email: "required",
      name: true,
      categories: ["UI", "API"],
      bannedWords: ["crypto"],
    });
    expect(form1.defaultLabels).toEqual(["triage", "customer"]);
    expect(form1.defaultPriority).toBe("high");
    expect(form1.accentColor).toBe("#2563eb");
    expect(form1.bannedWords).toEqual(["spamlink"]);
    expect(form1.createdBy).toBe("emre");
    expect(form1.submissionCount).toBe(0);

    const form2 = await org2Feedback.createForm({
      projectId: p2.id,
      name: "Second Org Feedback",
    });

    // Org isolation on getForm / getFormByPublicId / listForms / updateForm / deleteForm
    expect(await org1Feedback.getForm(form1.id)).toEqual(form1);
    expect(await org1Feedback.getForm(form2.id)).toBeNull();
    expect(await org2Feedback.getForm(form1.id)).toBeNull();

    expect(await org1Feedback.getFormByPublicId(form1.publicId)).toEqual(form1);
    expect(await org2Feedback.getFormByPublicId(form1.publicId)).toBeNull();

    expect(await org1Feedback.listForms()).toEqual([form1]);
    expect(await org1Feedback.listForms(p1.id)).toEqual([form1]);
    expect(await org1Feedback.listForms(p2.id)).toEqual([]);
    expect(await org2Feedback.listForms()).toEqual([form2]);

    // findFormByPublicId resolves owning org across the database (like findWebhookOrgId)
    expect(await findFormByPublicId(env.DB, form1.publicId)).toBe(DEFAULT_ORGANISATION_ID);
    expect(await org1Feedback.findFormByPublicId(form2.publicId)).toBe(SECOND_ORG_ID);
    expect(await findFormByPublicId(env.DB, "unknown_public_id_123456")).toBeNull();
    expect(await findFormByPublicId(env.DB, "short")).toBeNull();

    // Update form
    runtime.testClock.advance(5_000);
    const updated = await org1Feedback.updateForm(form1.id, {
      name: "Updated Bug Reports",
      enabled: false,
      turnstile: false,
      defaultLabels: null,
      defaultPriority: null,
      accentColor: null,
      bannedWords: null,
    });
    expect(updated.name).toBe("Updated Bug Reports");
    expect(updated.enabled).toBe(false);
    expect(updated.turnstile).toBe(false);
    expect(updated.defaultLabels).toBeUndefined();
    expect(updated.defaultPriority).toBeUndefined();
    expect(updated.accentColor).toBeUndefined();
    expect(updated.bannedWords).toBeUndefined();
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(form1.updatedAt));

    await expect(
      org2Feedback.updateForm(form1.id, { name: "Hijack" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Record submission counter
    runtime.testClock.advance(2_000);
    const bumped = await org1Feedback.recordFormSubmission(form1.id);
    expect(bumped.submissionCount).toBe(1);
    expect(bumped.lastSubmittedAt).toBeDefined();

    // Delete form
    await expect(org2Feedback.deleteForm(form1.id)).rejects.toBeInstanceOf(NotFoundError);
    await org1Feedback.deleteForm(form1.id);
    expect(await org1Feedback.getForm(form1.id)).toBeNull();
  });

  it("rotates a form's publicId and rejects collisions", async () => {
    const runtime = createTestRuntime();
    const storage = new D1Storage({ db: env.DB, deps: runtime });
    const project = await storage.createProject({ name: "Rotate Project" });
    const store = new D1FeedbackStore({ db: env.DB, deps: runtime });

    const formA = await store.createForm({
      projectId: project.id,
      name: "Form A",
    });
    const formB = await store.createForm({
      projectId: project.id,
      name: "Form B",
    });

    const originalPublicId = formA.publicId;
    runtime.testClock.advance(1_000);
    const rotated = await store.rotatePublicId(formA.id);
    expect(rotated.publicId).not.toBe(originalPublicId);
    expect(rotated.publicId.length).toBeGreaterThanOrEqual(16);
    expect(await store.getFormByPublicId(originalPublicId)).toBeNull();
    expect(await store.getFormByPublicId(rotated.publicId)).toEqual(rotated);

    // Rotating to an existing publicId throws ValidationError
    await expect(
      store.rotatePublicId(formA.id, formB.publicId),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("creates entries, looks up by task, updates outcome, and sets taskId to null when task is deleted", async () => {
    const runtime = createTestRuntime();
    const storage = new D1Storage({ db: env.DB, deps: runtime });
    const project = await storage.createProject({ name: "Entries Project" });
    const store = new D1FeedbackStore({ db: env.DB, deps: runtime });

    const form = await store.createForm({
      projectId: project.id,
      name: "Feedback Form",
      fields: {
        email: "optional",
        name: true,
        categories: ["Bug", "Feature"],
      },
    });

    const task = await storage.saveTask({
      projectId: project.id,
      title: "Visitor bug report",
      description: "> Something broke",
      pendingApproval: true,
      labels: ["feedback"],
    });

    const longUserAgent = `Mozilla/5.0 ${"X".repeat(350)}`;
    const entry = await store.createEntry({
      taskId: task.id,
      formId: form.id,
      category: "Bug",
      submitterEmail: "visitor@example.com",
      submitterName: "Ada Lovelace",
      pageUrl: "https://example.com/pricing",
      ipHash: "ip_hash_abc",
      bodyHash: "body_hash_xyz",
      userAgent: longUserAgent,
      spamScore: 15,
    });

    expect(entry.taskId).toBe(task.id);
    expect(entry.formId).toBe(form.id);
    expect(entry.orgId).toBe(DEFAULT_ORGANISATION_ID);
    expect(entry.projectId).toBe(project.id);
    expect(entry.outcome).toBe("pending");
    expect(entry.category).toBe("Bug");
    expect(entry.submitterEmail).toBe("visitor@example.com");
    expect(entry.submitterName).toBe("Ada Lovelace");
    expect(entry.pageUrl).toBe("https://example.com/pricing");
    expect(entry.userAgent?.length).toBe(300);
    expect(entry.spamScore).toBe(15);

    expect(await store.getEntryByTaskId(task.id)).toEqual(entry);
    expect(await store.getPendingCount(form.id)).toBe(1);

    // Approve entry via setEntryOutcomeByTaskId
    runtime.testClock.advance(10_000);
    const approved = await store.setEntryOutcomeByTaskId(task.id, "approved", {
      reviewedBy: "emre",
    });
    expect(approved.outcome).toBe("approved");
    expect(approved.reviewedBy).toBe("emre");
    expect(approved.reviewedAt).toBeDefined();
    expect(await store.getPendingCount(form.id)).toBe(0);

    // Deleting the task nulls out task_id on the entry without deleting the entry
    await storage.deleteTask(task.id);
    const afterTaskDelete = await store.getEntry(entry.id);
    expect(afterTaskDelete).not.toBeNull();
    expect(afterTaskDelete?.taskId).toBeNull();
    expect(afterTaskDelete?.outcome).toBe("approved");
    expect(await store.getEntryByTaskId(task.id)).toBeNull();
  });

  it("computes pending counts per form, detects duplicates within 24h, and purges rejected/spam entries older than 30 days", async () => {
    const runtime = createTestRuntime();
    const storage = new D1Storage({ db: env.DB, deps: runtime });
    const project = await storage.createProject({ name: "Abuse & Purge Project" });
    const store = new D1FeedbackStore({ db: env.DB, deps: runtime });

    const form = await store.createForm({
      projectId: project.id,
      name: "Public Form",
    });

    const e1 = await store.createEntry({
      formId: form.id,
      outcome: "pending",
      ipHash: "ip-1",
      bodyHash: "body-1",
    });
    const e2 = await store.createEntry({
      formId: form.id,
      outcome: "rejected",
      ipHash: "ip-2",
      bodyHash: "body-2",
    });
    const e3 = await store.createEntry({
      formId: form.id,
      outcome: "spam",
      ipHash: "ip-3",
      bodyHash: "body-3",
      spamScore: 120,
    });

    expect(await store.getPendingCount(form.id)).toBe(1);
    const countsMap = await store.getPendingCountsByFormIds([form.id]);
    expect(countsMap.get(form.id)).toBe(1);

    // Duplicate check within 24h
    expect(
      await store.findDuplicateEntry({
        formId: form.id,
        ipHash: "ip-1",
        bodyHash: "body-1",
      }),
    ).toEqual(e1);
    expect(
      await store.hasDuplicateEntry({
        formId: form.id,
        ipHash: "ip-1",
        bodyHash: "other-body",
      }),
    ).toBe(false);

    // Advance 24h + 1ms -> no longer a duplicate
    runtime.testClock.advance(FEEDBACK_DUPLICATE_WINDOW_MS + 1);
    expect(
      await store.findDuplicateEntry({
        formId: form.id,
        ipHash: "ip-1",
        bodyHash: "body-1",
      }),
    ).toBeNull();

    // Create a fresh rejected entry at t = +24h
    const recentRejected = await store.createEntry({
      formId: form.id,
      outcome: "rejected",
      ipHash: "ip-4",
      bodyHash: "body-4",
    });

    // Advance so e1/e2/e3 (created ~24h before recentRejected) are > 30 days old,
    // while recentRejected is < 30 days old
    runtime.testClock.advance(FEEDBACK_PURGE_RETENTION_MS - 60_000);

    const purgedCount = await store.purgeExpiredEntries();
    // Only e2 (rejected) and e3 (spam) older than 30 days should be purged;
    // e1 (pending) and recentRejected (< 30 days old) must remain.
    expect(purgedCount).toBe(2);
    expect(await store.getEntry(e2.id)).toBeNull();
    expect(await store.getEntry(e3.id)).toBeNull();
    expect(await store.getEntry(e1.id)).not.toBeNull();
    expect(await store.getEntry(recentRejected.id)).not.toBeNull();
  });

  it("cascades form and entry deletion when the project is deleted", async () => {
    const runtime = createTestRuntime();
    const storage = new D1Storage({ db: env.DB, deps: runtime });
    const project = await storage.createProject({ name: "Cascade Project" });
    const store = new D1FeedbackStore({ db: env.DB, deps: runtime });

    const form = await store.createForm({
      projectId: project.id,
      name: "Cascade Form",
    });
    const entry = await store.createEntry({
      formId: form.id,
      ipHash: "ip-c",
      bodyHash: "body-c",
    });

    await storage.deleteProject(project.id);
    expect(await store.getForm(form.id)).toBeNull();
    expect(await store.getEntry(entry.id)).toBeNull();
  });

  it("blocks and unblocks IP hashes per form", async () => {
    const runtime = createTestRuntime();
    const storage = new D1Storage({ db: env.DB, deps: runtime });
    const project = await storage.createProject({ name: "IP Block Project" });
    const store = new D1FeedbackStore({ db: env.DB, deps: runtime });

    const form = await store.createForm({
      projectId: project.id,
      name: "Block Form",
    });

    const hashA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const hashB = "FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210FEDCBA9876543210";

    expect(await store.isIpHashBlocked(form.id, hashA)).toBe(false);

    const afterBlockA = await store.blockIpHash(form.id, hashA);
    expect(afterBlockA.blockedIpHashes).toEqual([hashA]);
    expect(await store.isIpHashBlocked(form.id, hashA)).toBe(true);
    expect(await store.isIpHashBlocked(form.id, hashB)).toBe(false);

    // Idempotent when blocking an already-blocked hash (case-insensitive)
    const afterBlockB = await store.blockIpHash(form.id, hashB);
    expect(afterBlockB.blockedIpHashes).toEqual([hashA, hashB.toLowerCase()]);
    const duplicateBlock = await store.blockIpHash(form.id, hashA.toUpperCase());
    expect(duplicateBlock.blockedIpHashes).toEqual([hashA, hashB.toLowerCase()]);

    // Unblock hashA
    const afterUnblockA = await store.unblockIpHash(form.id, hashA);
    expect(afterUnblockA.blockedIpHashes).toEqual([hashB.toLowerCase()]);
    expect(await store.isIpHashBlocked(form.id, hashA)).toBe(false);
    expect(await store.isIpHashBlocked(form.id, hashB)).toBe(true);

    // Unblock remaining hash clears blockedIpHashes
    const afterUnblockB = await store.unblockIpHash(form.id, hashB);
    expect(afterUnblockB.blockedIpHashes).toBeUndefined();
    expect(await store.isIpHashBlocked(form.id, hashB)).toBe(false);
  });
});
