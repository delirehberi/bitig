import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Organisation, Project, Task, User } from "@bitig/core";
import { D1FeedbackStore } from "@bitig/storage-d1";
import { createApp } from "../src/index";
import { FakeMailer } from "../src/mailer";
import { setFeedbackAbuseCheckHook, type FeedbackFormResponse } from "../src/routes/feedback";
import { TEST_AUTH_HEADER } from "./constants";

const BASE_URL = "https://bitig.test";

const STATEMENTS = [
  "DROP TABLE IF EXISTS `feedback_entries`",
  "DROP TABLE IF EXISTS `feedback_forms`",
  "DROP TABLE IF EXISTS `webhooks`",
  "DROP TABLE IF EXISTS `attachments`",
  "DROP TABLE IF EXISTS `checkpoints`",
  "DROP TABLE IF EXISTS `comments`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  "DROP TABLE IF EXISTS `invitations`",
  "DROP TABLE IF EXISTS `access_tokens`",
  "DROP TABLE IF EXISTS `auth_codes`",
  "DROP TABLE IF EXISTS `sessions`",
  "DROP TABLE IF EXISTS `memberships`",
  "DROP TABLE IF EXISTS `organisations`",
  "DROP TABLE IF EXISTS `users`",
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
  `CREATE TABLE \`checkpoints\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL,
    \`step_index\` integer NOT NULL,
    \`status\` text NOT NULL,
    \`state_snapshot\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`created_by\` text,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
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

let ipCounter = 0;
function uniqueIp(): string {
  ipCounter += 1;
  return `198.51.100.${String(ipCounter)}`;
}

function cookiePair(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("REST API: Feedback form management (BIT-176)", () => {
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    mailer = new FakeMailer();
    app = createApp({ mailer });
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  function req(
    path: string,
    init: RequestInit & {
      cookie?: string;
      token?: string;
      authHeader?: string;
      org?: string;
      origin?: string | null;
      bodyJson?: unknown;
    } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", uniqueIp());
    if (init.origin === undefined) {
      headers.set("Origin", BASE_URL);
    } else if (init.origin !== null) {
      headers.set("Origin", init.origin);
    }
    headers.set("X-Bitig-Request", "true");
    if (init.cookie) headers.set("Cookie", init.cookie);
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
    if (init.authHeader) headers.set("Authorization", init.authHeader);
    if (init.org) headers.set("X-Bitig-Org", init.org);
    const requestInit: RequestInit = { ...init, headers };
    if (init.bodyJson !== undefined) {
      headers.set("Content-Type", "application/json");
      requestInit.body = JSON.stringify(init.bodyJson);
    }
    return Promise.resolve(app.fetch(new Request(`${BASE_URL}${path}`, requestInit), env));
  }

  async function registerAndVerify(input: {
    email: string;
    username: string;
    displayName: string;
    organisationName?: string;
    inviteToken?: string;
  }) {
    const reg = await req("/api/auth/register", {
      method: "POST",
      bodyJson: input,
    });
    expect(reg.status).toBe(200);
    const code = mailer.extractLastCode(input.email);
    expect(code).toMatch(/^\d{6}$/);
    const verify = await req("/api/auth/verify", {
      method: "POST",
      bodyJson: {
        email: input.email,
        code,
        ...(input.organisationName ? { organisationName: input.organisationName } : {}),
        ...(input.inviteToken ? { inviteToken: input.inviteToken } : {}),
      },
    });
    expect(verify.status).toBe(200);
    const cookie = cookiePair(verify);
    const json = await verify.json<{
      user: string;
      profile: User;
      memberships: { organisation: Organisation; role: string }[];
      needsOnboarding: boolean;
    }>();
    return { cookie, ...json };
  }

  it("supports creating, listing, reading, patching, rotating, and deleting feedback forms with public link and pending count", async () => {
    const projectRes = await req("/api/projects", {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: { name: "Feedback App", key: "FBK" },
    });
    expect(projectRes.status).toBe(201);
    const project = await projectRes.json<Project>();

    // Empty list initially
    const initialListRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      authHeader: TEST_AUTH_HEADER,
    });
    expect(initialListRes.status).toBe(200);
    expect(await initialListRes.json()).toEqual([]);

    // Create a form under the project
    const createRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "Public Bugs",
        title: "Report an Issue",
        intro: "Tell us what broke.",
        fields: {
          email: "required",
          name: true,
          categories: ["Bug", "Feature"],
        },
        allowedOrigins: ["https://app.example.com/"],
        turnstile: false,
        defaultLabels: ["triage"],
        defaultPriority: "high",
        thankYouText: "Thanks for reporting!",
        accentColor: "#2563EB",
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<FeedbackFormResponse>();
    expect(created.projectId).toBe(project.id);
    expect(created.name).toBe("Public Bugs");
    expect(created.title).toBe("Report an Issue");
    expect(created.intro).toBe("Tell us what broke.");
    expect(created.enabled).toBe(true);
    expect(created.turnstile).toBe(false);
    expect(created.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(created.defaultLabels).toEqual(["triage"]);
    expect(created.defaultPriority).toBe("high");
    expect(created.accentColor).toBe("#2563eb");
    expect(created.publicId.length).toBeGreaterThanOrEqual(16);
    expect(created.publicPath).toBe(`/f/${created.publicId}`);
    expect(created.publicUrl).toBe(`${BASE_URL}/f/${created.publicId}`);
    expect(created.publicLink).toBe(`${BASE_URL}/f/${created.publicId}`);
    expect(created.pendingCount).toBe(0);

    // Seed pending and non-pending entries in D1FeedbackStore to verify pendingCount
    const store = new D1FeedbackStore({ db: env.DB, orgId: created.orgId });
    await store.createEntry({
      formId: created.id,
      outcome: "pending",
      category: "Bug",
    });
    await store.createEntry({
      formId: created.id,
      outcome: "pending",
      category: "Feature",
    });
    await store.createEntry({
      formId: created.id,
      outcome: "approved",
    });
    await store.createEntry({
      formId: created.id,
      outcome: "spam",
    });

    // GET /api/projects/:id/feedback-forms returns the form with pendingCount = 2
    const listRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      authHeader: TEST_AUTH_HEADER,
    });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json<FeedbackFormResponse[]>();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);
    expect(listed[0]?.pendingCount).toBe(2);
    expect(listed[0]?.publicUrl).toBe(`${BASE_URL}/f/${created.publicId}`);
    expect(listed[0]?.publicLink).toBe(`${BASE_URL}/f/${created.publicId}`);

    // GET /api/feedback-forms/:id returns the form with pendingCount = 2
    const getRes = await req(`/api/feedback-forms/${created.id}`, {
      authHeader: TEST_AUTH_HEADER,
    });
    expect(getRes.status).toBe(200);
    const fetched = await getRes.json<FeedbackFormResponse>();
    expect(fetched.id).toBe(created.id);
    expect(fetched.pendingCount).toBe(2);
    expect(fetched.publicUrl).toBe(`${BASE_URL}/f/${created.publicId}`);

    // PATCH /api/feedback-forms/:id updates fields and preserves pendingCount
    const patchRes = await req(`/api/feedback-forms/${created.id}`, {
      method: "PATCH",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "Renamed Bugs",
        enabled: false,
        defaultLabels: null,
        accentColor: null,
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<FeedbackFormResponse>();
    expect(patched.name).toBe("Renamed Bugs");
    expect(patched.enabled).toBe(false);
    expect(patched.defaultLabels).toBeUndefined();
    expect(patched.accentColor).toBeUndefined();
    expect(patched.pendingCount).toBe(2);
    expect(patched.publicId).toBe(created.publicId);

    // POST /api/feedback-forms/:id/rotate generates a new publicId and updates publicUrl / publicLink
    const rotateRes = await req(`/api/feedback-forms/${created.id}/rotate`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
    });
    expect(rotateRes.status).toBe(200);
    const rotated = await rotateRes.json<FeedbackFormResponse>();
    expect(rotated.id).toBe(created.id);
    expect(rotated.publicId).not.toBe(created.publicId);
    expect(rotated.publicPath).toBe(`/f/${rotated.publicId}`);
    expect(rotated.publicUrl).toBe(`${BASE_URL}/f/${rotated.publicId}`);
    expect(rotated.publicLink).toBe(`${BASE_URL}/f/${rotated.publicId}`);
    expect(rotated.pendingCount).toBe(2);

    // DELETE /api/feedback-forms/:id deletes the form and returns 204
    const deleteRes = await req(`/api/feedback-forms/${created.id}`, {
      method: "DELETE",
      authHeader: TEST_AUTH_HEADER,
    });
    expect(deleteRes.status).toBe(204);

    // Subsequent GET / PATCH / DELETE / rotate return 404
    expect(
      (await req(`/api/feedback-forms/${created.id}`, { authHeader: TEST_AUTH_HEADER })).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/feedback-forms/${created.id}`, {
          method: "PATCH",
          authHeader: TEST_AUTH_HEADER,
          bodyJson: { name: "Gone" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/feedback-forms/${created.id}`, {
          method: "DELETE",
          authHeader: TEST_AUTH_HEADER,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/feedback-forms/${created.id}/rotate`, {
          method: "POST",
          authHeader: TEST_AUTH_HEADER,
        })
      ).status,
    ).toBe(404);
  });

  it("validates payloads and returns 404 for unknown projects or forms", async () => {
    const projectRes = await req("/api/projects", {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: { name: "Validation App", key: "VAL" },
    });
    const project = await projectRes.json<Project>();

    // Invalid create payload (empty name, invalid origin, >10 categories)
    const badCreate = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "   ",
        allowedOrigins: ["not-a-url"],
      },
    });
    expect(badCreate.status).toBe(400);
    expect(await badCreate.json()).toMatchObject({ error: "validation_error" });

    // Unknown project on GET and POST
    const unknownId = "01940000-0000-7000-8000-999999999999";
    expect(
      (
        await req(`/api/projects/${unknownId}/feedback-forms`, {
          authHeader: TEST_AUTH_HEADER,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/projects/${unknownId}/feedback-forms`, {
          method: "POST",
          authHeader: TEST_AUTH_HEADER,
          bodyJson: { name: "Orphan Form" },
        })
      ).status,
    ).toBe(404);

    // Empty PATCH body fails validation
    const createRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: { name: "Valid Form" },
    });
    const form = await createRes.json<FeedbackFormResponse>();

    const emptyPatch = await req(`/api/feedback-forms/${form.id}`, {
      method: "PATCH",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {},
    });
    expect(emptyPatch.status).toBe(400);
    expect(await emptyPatch.json()).toMatchObject({ error: "validation_error" });

    // Rejects unauthenticated requests with 401 and cross-site writes with 403 (CSRF)
    expect((await req(`/api/projects/${project.id}/feedback-forms`)).status).toBe(401);
    expect((await req(`/api/feedback-forms/${form.id}`)).status).toBe(401);
    expect(
      (
        await req(`/api/projects/${project.id}/feedback-forms`, {
          method: "POST",
          authHeader: TEST_AUTH_HEADER,
          origin: "https://evil.example.com",
          bodyJson: { name: "CSRF Form" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(`/api/feedback-forms/${form.id}/rotate`, {
          method: "POST",
          authHeader: TEST_AUTH_HEADER,
          origin: "https://evil.example.com",
        })
      ).status,
    ).toBe(403);
  });

  it("enforces owner, editor, and viewer roles on feedback form routes", async () => {
    const owner = await registerAndVerify({
      email: "owner@bitig.test",
      username: "owner",
      displayName: "Org Owner",
      organisationName: "Acme Feedback",
    });
    const org = owner.memberships[0]?.organisation;
    expect(org).toBeDefined();
    if (!org) throw new Error("missing org");

    // Invite an editor and a viewer
    const editorInvRes = await req(`/api/orgs/${org.slug}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      bodyJson: { email: "editor@bitig.test", role: "editor" },
    });
    expect(editorInvRes.status).toBe(201);
    const { token: editorInvite } = await editorInvRes.json<{ token: string }>();

    const viewerInvRes = await req(`/api/orgs/${org.slug}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      bodyJson: { email: "viewer@bitig.test", role: "viewer" },
    });
    expect(viewerInvRes.status).toBe(201);
    const { token: viewerInvite } = await viewerInvRes.json<{ token: string }>();

    const editor = await registerAndVerify({
      email: "editor@bitig.test",
      username: "editor",
      displayName: "Org Editor",
      inviteToken: editorInvite,
    });
    const viewer = await registerAndVerify({
      email: "viewer@bitig.test",
      username: "viewer",
      displayName: "Org Viewer",
      inviteToken: viewerInvite,
    });

    // Owner creates a project
    const projRes = await req("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      org: org.slug,
      bodyJson: { name: "Shared Project", key: "SHR" },
    });
    expect(projRes.status).toBe(201);
    const project = await projRes.json<Project>();

    // Owner can create a feedback form
    const ownerFormRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      cookie: owner.cookie,
      org: org.slug,
      bodyJson: { name: "Owner Form" },
    });
    expect(ownerFormRes.status).toBe(201);
    const ownerForm = await ownerFormRes.json<FeedbackFormResponse>();
    expect(ownerForm.createdBy).toBe("Org Owner");

    // Editor can also create, patch, rotate, and delete feedback forms
    const editorFormRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      cookie: editor.cookie,
      org: org.slug,
      bodyJson: { name: "Editor Form" },
    });
    expect(editorFormRes.status).toBe(201);
    const editorForm = await editorFormRes.json<FeedbackFormResponse>();
    expect(editorForm.createdBy).toBe("Org Editor");

    const editorPatchRes = await req(`/api/feedback-forms/${ownerForm.id}`, {
      method: "PATCH",
      cookie: editor.cookie,
      org: org.slug,
      bodyJson: { title: "Edited by Editor" },
    });
    expect(editorPatchRes.status).toBe(200);
    expect((await editorPatchRes.json<FeedbackFormResponse>()).title).toBe("Edited by Editor");

    const editorRotateRes = await req(`/api/feedback-forms/${ownerForm.id}/rotate`, {
      method: "POST",
      cookie: editor.cookie,
      org: org.slug,
    });
    expect(editorRotateRes.status).toBe(200);
    const rotatedByEditor = await editorRotateRes.json<FeedbackFormResponse>();
    expect(rotatedByEditor.publicId).not.toBe(ownerForm.publicId);

    // Viewer can list and get feedback forms
    const viewerListRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      cookie: viewer.cookie,
      org: org.slug,
    });
    expect(viewerListRes.status).toBe(200);
    expect(await viewerListRes.json<FeedbackFormResponse[]>()).toHaveLength(2);

    const viewerGetRes = await req(`/api/feedback-forms/${ownerForm.id}`, {
      cookie: viewer.cookie,
      org: org.slug,
    });
    expect(viewerGetRes.status).toBe(200);
    expect((await viewerGetRes.json<FeedbackFormResponse>()).id).toBe(ownerForm.id);

    // Viewer gets 403 Forbidden on all write operations (create, patch, rotate, delete)
    expect(
      (
        await req(`/api/projects/${project.id}/feedback-forms`, {
          method: "POST",
          cookie: viewer.cookie,
          org: org.slug,
          bodyJson: { name: "Viewer Attempt" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(`/api/feedback-forms/${ownerForm.id}`, {
          method: "PATCH",
          cookie: viewer.cookie,
          org: org.slug,
          bodyJson: { name: "Viewer Patch" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(`/api/feedback-forms/${ownerForm.id}/rotate`, {
          method: "POST",
          cookie: viewer.cookie,
          org: org.slug,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await req(`/api/feedback-forms/${ownerForm.id}`, {
          method: "DELETE",
          cookie: viewer.cookie,
          org: org.slug,
        })
      ).status,
    ).toBe(403);

    // Editor can delete their form, and owner can delete the remaining form
    expect(
      (
        await req(`/api/feedback-forms/${editorForm.id}`, {
          method: "DELETE",
          cookie: editor.cookie,
          org: org.slug,
        })
      ).status,
    ).toBe(204);
    expect(
      (
        await req(`/api/feedback-forms/${ownerForm.id}`, {
          method: "DELETE",
          cookie: owner.cookie,
          org: org.slug,
        })
      ).status,
    ).toBe(204);
  });

  it("isolates feedback forms across organisations", async () => {
    const alice = await registerAndVerify({
      email: "alice@bitig.test",
      username: "alice",
      displayName: "Alice",
      organisationName: "Alice Org",
    });
    const bob = await registerAndVerify({
      email: "bob@bitig.test",
      username: "bob",
      displayName: "Bob",
      organisationName: "Bob Org",
    });

    const aliceOrg = alice.memberships[0]?.organisation;
    const bobOrg = bob.memberships[0]?.organisation;
    expect(aliceOrg).toBeDefined();
    expect(bobOrg).toBeDefined();
    if (!aliceOrg || !bobOrg) throw new Error("missing orgs");

    const aliceProjRes = await req("/api/projects", {
      method: "POST",
      cookie: alice.cookie,
      org: aliceOrg.slug,
      bodyJson: { name: "Alice Project", key: "ALC" },
    });
    const aliceProject = await aliceProjRes.json<Project>();

    const bobProjRes = await req("/api/projects", {
      method: "POST",
      cookie: bob.cookie,
      org: bobOrg.slug,
      bodyJson: { name: "Bob Project", key: "BOB" },
    });
    const bobProject = await bobProjRes.json<Project>();

    const aliceFormRes = await req(`/api/projects/${aliceProject.id}/feedback-forms`, {
      method: "POST",
      cookie: alice.cookie,
      org: aliceOrg.slug,
      bodyJson: { name: "Alice Feedback" },
    });
    expect(aliceFormRes.status).toBe(201);
    const aliceForm = await aliceFormRes.json<FeedbackFormResponse>();

    // Bob cannot list or create forms on Alice's project
    expect(
      (
        await req(`/api/projects/${aliceProject.id}/feedback-forms`, {
          cookie: bob.cookie,
          org: bobOrg.slug,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/projects/${aliceProject.id}/feedback-forms`, {
          method: "POST",
          cookie: bob.cookie,
          org: bobOrg.slug,
          bodyJson: { name: "Cross-org Form" },
        })
      ).status,
    ).toBe(404);

    // Bob cannot get, patch, rotate, or delete Alice's form (all return 404)
    expect(
      (
        await req(`/api/feedback-forms/${aliceForm.id}`, {
          cookie: bob.cookie,
          org: bobOrg.slug,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/feedback-forms/${aliceForm.id}`, {
          method: "PATCH",
          cookie: bob.cookie,
          org: bobOrg.slug,
          bodyJson: { name: "Hijacked" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/feedback-forms/${aliceForm.id}/rotate`, {
          method: "POST",
          cookie: bob.cookie,
          org: bobOrg.slug,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await req(`/api/feedback-forms/${aliceForm.id}`, {
          method: "DELETE",
          cookie: bob.cookie,
          org: bobOrg.slug,
        })
      ).status,
    ).toBe(404);

    // Bob's own project forms list is empty and Alice's form remains intact
    const bobFormsRes = await req(`/api/projects/${bobProject.id}/feedback-forms`, {
      cookie: bob.cookie,
      org: bobOrg.slug,
    });
    expect(bobFormsRes.status).toBe(200);
    expect(await bobFormsRes.json()).toEqual([]);

    const aliceCheckRes = await req(`/api/feedback-forms/${aliceForm.id}`, {
      cookie: alice.cookie,
      org: aliceOrg.slug,
    });
    expect(aliceCheckRes.status).toBe(200);
    expect((await aliceCheckRes.json<FeedbackFormResponse>()).name).toBe("Alice Feedback");
  });

  afterEach(() => {
    setFeedbackAbuseCheckHook(undefined);
  });

  it("renders GET /f/:publicId with Hallmark tokens, light/dark modes, accent colour, embed postMessage mode, and privacy note link", async () => {
    const projectRes = await req("/api/projects", {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: { name: "Widget Project", key: "WDG" },
    });
    const project = await projectRes.json<Project>();

    const createRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "Widget Feedback",
        title: "Share Feedback <Beta>",
        intro: "Tell us what you think & what we can improve.",
        fields: {
          email: "required",
          name: true,
          categories: ["Bug", "Feature Request"],
        },
        turnstile: true,
        accentColor: "#e11d48",
        thankYouText: "We appreciate your input!",
      },
    });
    expect(createRes.status).toBe(201);
    const form = await createRes.json<FeedbackFormResponse>();

    // Unauthenticated GET /f/:publicId (no auth headers, no CSRF header)
    const pageRes = await app.fetch(
      new Request(`${BASE_URL}/f/${form.publicId}`),
      env,
    );
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("content-type")).toContain("text/html");
    const html = await pageRes.text();

    // Escapes title and intro, includes Hallmark tokens, light/dark mode, and accent colour
    expect(html).toContain("Share Feedback &lt;Beta&gt;");
    expect(html).not.toContain("Share Feedback <Beta>");
    expect(html).toContain("Tell us what you think &amp; what we can improve.");
    expect(html).toContain("--color-paper:");
    expect(html).toContain("--color-ink:");
    expect(html).toContain("--color-accent:");
    expect(html).toContain("--font-display:");
    expect(html).toContain("--font-body:");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain("color-scheme: light dark");
    expect(html).toContain("--form-accent: #e11d48");
    expect(html).toContain('data-accent-color="#e11d48"');

    // Includes configured fields, Turnstile, and page chrome
    expect(html).toContain('class="feedback-chrome-header"');
    expect(html).toContain('data-embed="false"');
    expect(html).toContain('name="title"');
    expect(html).toContain('name="body"');
    expect(html).toContain('name="category"');
    expect(html).toContain("Feature Request");
    expect(html).toContain('name="submitterName"');
    expect(html).toContain('name="submitterEmail"');
    expect(html).toContain("https://challenges.cloudflare.com/turnstile/v0/api.js");
    expect(html).not.toContain("bitig:feedback:resize");

    // Links to the privacy note and serves the privacy note page
    expect(html).toContain(`/f/${form.publicId}/privacy`);
    expect(html).toContain("Privacy note");
    const privacyRes = await app.fetch(
      new Request(`${BASE_URL}/f/${form.publicId}/privacy`),
      env,
    );
    expect(privacyRes.status).toBe(200);
    const privacyHtml = await privacyRes.text();
    expect(privacyHtml).toContain("raw IP address is never stored");
    expect(privacyHtml).toContain("30 days");

    // ?embed=1 drops outer page chrome and reports height via postMessage
    const embedRes = await app.fetch(
      new Request(
        `${BASE_URL}/f/${form.publicId}?embed=1&pageUrl=${encodeURIComponent("https://docs.example.com/guide")}`,
      ),
      env,
    );
    expect(embedRes.status).toBe(200);
    const embedHtml = await embedRes.text();
    expect(embedHtml).toContain('data-embed="true"');
    expect(embedHtml).toContain("is-embed");
    expect(embedHtml).not.toContain('class="feedback-chrome-header"');
    expect(embedHtml).toContain("window.parent.postMessage");
    expect(embedHtml).toContain("bitig:feedback:resize");
    expect(embedHtml).toContain('name="pageUrl" value="https://docs.example.com/guide"');
  });

  it("POST /f/:publicId accepts form post and JSON, resolves org, creates pending task, writes feedback_entries, bumps counters, and shows thank-you text", async () => {
    // Create a form inside a non-default organisation to verify org resolution from publicId
    const owner = await registerAndVerify({
      email: "maintainer@bitig.test",
      username: "maintainer",
      displayName: "Maintainer",
      organisationName: "Acme Feedback Org",
    });
    const org = owner.memberships[0]?.organisation;
    expect(org).toBeDefined();
    if (!org) throw new Error("missing org");

    const projRes = await req("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      org: org.slug,
      bodyJson: { name: "Acme Cloud", key: "ACM" },
    });
    expect(projRes.status).toBe(201);
    const project = await projRes.json<Project>();

    const createFormRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      cookie: owner.cookie,
      org: org.slug,
      bodyJson: {
        name: "Docs Widget",
        title: "Docs Feedback",
        fields: {
          email: "optional",
          name: true,
          categories: ["Bug", "Docs", "Idea"],
        },
        turnstile: false,
        defaultLabels: ["docs-portal"],
        defaultPriority: "high",
        thankYouText: "Thank you for helping improve Acme Docs!",
      },
    });
    expect(createFormRes.status).toBe(201);
    const form = await createFormRes.json<FeedbackFormResponse>();

    // 1. Submit via URL-encoded HTML form post (unauthenticated, no CSRF headers needed)
    const formData = new URLSearchParams({
      title: "Broken code snippet on quickstart",
      body: "Step 3 throws a syntax error when copied.\nSee https://docs.acme.test/quickstart",
      category: "Docs",
      submitterName: "Jane Visitor",
      submitterEmail: "jane@visitor.test",
      pageUrl: "https://docs.acme.test/quickstart",
    });
    const postFormRes = await app.fetch(
      new Request(`${BASE_URL}/f/${form.publicId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 TestBrowser/1.0",
        },
        body: formData.toString(),
      }),
      env,
    );
    expect(postFormRes.status).toBe(200);
    expect(postFormRes.headers.get("content-type")).toContain("text/html");
    const thankYouHtml = await postFormRes.text();
    expect(thankYouHtml).toContain("Thank you for helping improve Acme Docs!");

    // 2. Submit via JSON POST
    const postJsonRes = await app.fetch(
      new Request(`${BASE_URL}/f/${form.publicId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "FeedbackWidget/2.0",
        },
        body: JSON.stringify({
          title: "Add dark mode toggle shortcut",
          body: "A keyboard shortcut for dark mode would be handy.",
          category: "Idea",
        }),
      }),
      env,
    );
    expect(postJsonRes.status).toBe(200);
    const jsonResult = await postJsonRes.json<{
      ok: boolean;
      thankYouText: string;
      taskId: string;
      entryId: string;
    }>();
    expect(jsonResult.ok).toBe(true);
    expect(jsonResult.thankYouText).toBe("Thank you for helping improve Acme Docs!");
    expect(jsonResult.taskId).toBeTruthy();
    expect(jsonResult.entryId).toBeTruthy();

    // Verify pending tasks were created in the form's organisation & project
    const tasksRes = await req(`/api/tasks?projectId=${project.id}`, {
      cookie: owner.cookie,
      org: org.slug,
    });
    expect(tasksRes.status).toBe(200);
    const tasks = await tasksRes.json<Task[]>();
    expect(tasks).toHaveLength(2);

    const firstTask = tasks.find((t) => t.title === "Broken code snippet on quickstart");
    expect(firstTask).toBeDefined();
    expect(firstTask?.pendingApproval).toBe(true);
    expect(firstTask?.status).toBe("todo");
    expect(firstTask?.createdBy).toBe("feedback:Docs Widget");
    expect(firstTask?.priority).toBe("high");
    expect(firstTask?.labels).toEqual(["feedback", "docs-portal"]);
    expect(firstTask?.number).toBe(1);
    expect(firstTask?.description).toContain("> Step 3 throws a syntax error when copied.");
    expect(firstTask?.description).toContain("- **Form:** Docs Widget");
    expect(firstTask?.description).toContain("- **Category:** Docs");
    expect(firstTask?.description).toContain("- **Page URL:** https://docs.acme.test/quickstart");
    // Submitter email and name must never be placed in the task description
    expect(firstTask?.description).not.toContain("jane@visitor.test");
    expect(firstTask?.description).not.toContain("Jane Visitor");

    // Default organisation must not see Acme's feedback tasks
    const defaultOrgTasksRes = await req("/api/tasks", {
      authHeader: TEST_AUTH_HEADER,
    });
    expect(await defaultOrgTasksRes.json<Task[]>()).toEqual([]);

    // Verify feedback_entries rows in D1FeedbackStore
    const store = new D1FeedbackStore({ db: env.DB, orgId: org.id });
    const entries = await store.listEntries({ formId: form.id });
    expect(entries).toHaveLength(2);

    const firstEntry = entries.find((e) => e.taskId === firstTask?.id);
    expect(firstEntry).toBeDefined();
    expect(firstEntry?.outcome).toBe("pending");
    expect(firstEntry?.category).toBe("Docs");
    expect(firstEntry?.submitterName).toBe("Jane Visitor");
    expect(firstEntry?.submitterEmail).toBe("jane@visitor.test");
    expect(firstEntry?.pageUrl).toBe("https://docs.acme.test/quickstart");
    expect(firstEntry?.userAgent).toBe("Mozilla/5.0 TestBrowser/1.0");
    expect(firstEntry?.spamScore).toBe(15); // 1 link in body

    // Verify form counters (submissionCount, lastSubmittedAt, pendingCount) were bumped
    const updatedFormRes = await req(`/api/feedback-forms/${form.id}`, {
      cookie: owner.cookie,
      org: org.slug,
    });
    expect(updatedFormRes.status).toBe(200);
    const updatedForm = await updatedFormRes.json<FeedbackFormResponse>();
    expect(updatedForm.submissionCount).toBe(2);
    expect(updatedForm.pendingCount).toBe(2);
    expect(updatedForm.lastSubmittedAt).toBeDefined();

    // Verify abuse-check hook runs before task creation
    setFeedbackAbuseCheckHook(() => ({ status: "drop" }));
    const droppedRes = await app.fetch(
      new Request(`${BASE_URL}/f/${form.publicId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Silently dropped bot submission",
          body: "Should not create a task",
        }),
      }),
      env,
    );
    expect(droppedRes.status).toBe(200);
    expect(await store.listEntries({ formId: form.id })).toHaveLength(2);
  });

  it("returns 404 for unknown or disabled feedback forms on GET and POST /f/:publicId", async () => {
    const projectRes = await req("/api/projects", {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: { name: "Disabled Form Project", key: "DIS" },
    });
    const project = await projectRes.json<Project>();

    const createRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "Disabled Form",
        enabled: false,
      },
    });
    expect(createRes.status).toBe(201);
    const disabledForm = await createRes.json<FeedbackFormResponse>();

    // Unknown publicId (valid format and invalid short format)
    const unknownGet = await app.fetch(
      new Request(`${BASE_URL}/f/unknown_public_id_123456`),
      env,
    );
    expect(unknownGet.status).toBe(404);

    const shortGet = await app.fetch(new Request(`${BASE_URL}/f/short`), env);
    expect(shortGet.status).toBe(404);

    const unknownPost = await app.fetch(
      new Request(`${BASE_URL}/f/unknown_public_id_123456`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Hi", body: "There" }),
      }),
      env,
    );
    expect(unknownPost.status).toBe(404);

    // Disabled form returns 404 on both GET and POST and creates no task
    const disabledGet = await app.fetch(
      new Request(`${BASE_URL}/f/${disabledForm.publicId}`),
      env,
    );
    expect(disabledGet.status).toBe(404);

    const disabledPostForm = await app.fetch(
      new Request(`${BASE_URL}/f/${disabledForm.publicId}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ title: "Attempt", body: "Should fail" }).toString(),
      }),
      env,
    );
    expect(disabledPostForm.status).toBe(404);

    const disabledPostJson = await app.fetch(
      new Request(`${BASE_URL}/f/${disabledForm.publicId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Attempt", body: "Should fail" }),
      }),
      env,
    );
    expect(disabledPostJson.status).toBe(404);

    const tasksRes = await req(`/api/tasks?projectId=${project.id}`, {
      authHeader: TEST_AUTH_HEADER,
    });
    expect(await tasksRes.json<Task[]>()).toEqual([]);
  });

  it("replaces X-Frame-Options: DENY and frame-ancestors 'none' with allowed_origins and challenges.cloudflare.com on /f/* only", async () => {
    const projectRes = await req("/api/projects", {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: { name: "CSP Project", key: "CSP" },
    });
    const project = await projectRes.json<Project>();

    // Form with allowed_origins configured
    const embeddableRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "Embeddable Form",
        allowedOrigins: ["https://app.example.com/", "https://docs.example.com"],
      },
    });
    const embeddableForm = await embeddableRes.json<FeedbackFormResponse>();

    // Form with empty allowed_origins (link-only)
    const linkOnlyRes = await req(`/api/projects/${project.id}/feedback-forms`, {
      method: "POST",
      authHeader: TEST_AUTH_HEADER,
      bodyJson: {
        name: "Link Only Form",
        allowedOrigins: [],
      },
    });
    const linkOnlyForm = await linkOnlyRes.json<FeedbackFormResponse>();

    // 1. /f/:publicId with allowed_origins
    const framedRes = await app.fetch(
      new Request(`${BASE_URL}/f/${embeddableForm.publicId}`),
      env,
    );
    expect(framedRes.status).toBe(200);
    expect(framedRes.headers.get("x-frame-options")).toBeNull();
    const framedCsp = framedRes.headers.get("content-security-policy") ?? "";
    expect(framedCsp).toContain(
      "frame-ancestors https://app.example.com https://docs.example.com",
    );
    expect(framedCsp).not.toContain("frame-ancestors 'none'");
    expect(framedCsp).toContain("challenges.cloudflare.com");

    // 2. /f/:publicId with empty allowed_origins keeps frame-ancestors 'none' and removes X-Frame-Options
    const unframedRes = await app.fetch(
      new Request(`${BASE_URL}/f/${linkOnlyForm.publicId}`),
      env,
    );
    expect(unframedRes.status).toBe(200);
    expect(unframedRes.headers.get("x-frame-options")).toBeNull();
    const unframedCsp = unframedRes.headers.get("content-security-policy") ?? "";
    expect(unframedCsp).toContain("frame-ancestors 'none'");
    expect(unframedCsp).toContain("challenges.cloudflare.com");

    // 3. Non-/f/* routes keep global X-Frame-Options: DENY and frame-ancestors 'none'
    const healthRes = await app.fetch(new Request(`${BASE_URL}/health`), env);
    expect(healthRes.status).toBe(200);
    expect(healthRes.headers.get("x-frame-options")).toBe("DENY");
    const healthCsp = healthRes.headers.get("content-security-policy") ?? "";
    expect(healthCsp).toContain("frame-ancestors 'none'");
    expect(healthCsp).not.toContain("challenges.cloudflare.com");
  });
});
