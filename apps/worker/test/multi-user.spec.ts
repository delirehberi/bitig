import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Comment, Organisation, Project, Task, User } from "@bitig/core";
import { createApp } from "../src/index";
import { FakeMailer } from "../src/mailer";
import { TEST_AUTH_HEADER, TEST_BOOTSTRAP_EMAIL } from "./constants";

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
    \`priority\` text,\`labels\` text,
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
    \`source\` text NOT NULL,
    \`token\` text NOT NULL,
    \`secret\` text,
    \`enabled\` integer DEFAULT 1 NOT NULL,
    \`default_status\` text DEFAULT 'todo' NOT NULL,
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
  return `192.0.2.${String(ipCounter)}`;
}

function cookiePair(res: Response): string {
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("multi-user organisations, permissions, tokens, invitations, profile and admin", () => {
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    mailer = new FakeMailer();
    app = createApp({ mailer });
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  function req(
    path: string,
    init: RequestInit & { cookie?: string; token?: string; org?: string; bodyJson?: unknown } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("cf-connecting-ip", uniqueIp());
    headers.set("Origin", BASE_URL);
    headers.set("X-Bitig-Request", "true");
    if (init.cookie) headers.set("Cookie", init.cookie);
    if (init.token) headers.set("Authorization", `Bearer ${init.token}`);
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

  it("isolates projects, tasks, comments, webhooks and project keys per organisation", async () => {
    const alice = await registerAndVerify({
      email: "alice@bitig.test",
      username: "alice",
      displayName: "Alice",
      organisationName: "Alice Co",
    });
    const bob = await registerAndVerify({
      email: "bob@bitig.test",
      username: "bob",
      displayName: "Bob",
      organisationName: "Bob Co",
    });

    const aliceOrg = alice.memberships[0]?.organisation;
    const bobOrg = bob.memberships[0]?.organisation;
    expect(aliceOrg).toBeDefined();
    expect(bobOrg).toBeDefined();
    if (!aliceOrg || !bobOrg) throw new Error("missing orgs");

    // Both organisations can use the same project key "BIT"
    const p1Res = await req("/api/projects", {
      method: "POST",
      cookie: alice.cookie,
      org: aliceOrg.slug,
      bodyJson: { name: "Alice Project", key: "BIT" },
    });
    expect(p1Res.status).toBe(201);
    const p1 = await p1Res.json<Project>();

    const p2Res = await req("/api/projects", {
      method: "POST",
      cookie: bob.cookie,
      org: bobOrg.slug,
      bodyJson: { name: "Bob Project", key: "BIT" },
    });
    expect(p2Res.status).toBe(201);
    const p2 = await p2Res.json<Project>();

    // Duplicate key inside the same organisation fails with 400
    const dupRes = await req("/api/projects", {
      method: "POST",
      cookie: alice.cookie,
      org: aliceOrg.slug,
      bodyJson: { name: "Second Alice Project", key: "BIT" },
    });
    expect(dupRes.status).toBe(400);

    // Bob cannot see Alice's project or switch to Alice's org
    const bobProjects = await (await req("/api/projects", { cookie: bob.cookie, org: bobOrg.slug })).json<Project[]>();
    expect(bobProjects.map((p) => p.id)).toEqual([p2.id]);
    expect((await req(`/api/projects/${p1.id}`, { cookie: bob.cookie, org: bobOrg.slug })).status).toBe(404);
    expect((await req("/api/projects", { cookie: bob.cookie, org: aliceOrg.slug })).status).toBe(404);
    expect((await req(`/api/orgs/${aliceOrg.slug}`, { cookie: bob.cookie })).status).toBe(404);
  });

  it("invites a member, enforces viewer/editor/owner roles, and prevents removing the last owner", async () => {
    const owner = await registerAndVerify({
      email: "owner@bitig.test",
      username: "owner",
      displayName: "Org Owner",
      organisationName: "Acme Org",
    });
    const org = owner.memberships[0]?.organisation;
    expect(org).toBeDefined();
    if (!org) throw new Error("missing org");

    // Invite a viewer
    const invRes = await req(`/api/orgs/${org.slug}/invitations`, {
      method: "POST",
      cookie: owner.cookie,
      bodyJson: { email: "viewer@bitig.test", role: "viewer" },
    });
    expect(invRes.status).toBe(201);
    const { token: inviteToken } = await invRes.json<{ token: string }>();

    // Public invitation info preview works before sign-in
    const infoRes = await req(`/api/invitations/info?token=${encodeURIComponent(inviteToken)}`);
    expect(infoRes.status).toBe(200);
    expect(await infoRes.json()).toMatchObject({
      invitation: { orgId: org.id, orgName: "Acme Org", email: "viewer@bitig.test", role: "viewer" },
    });

    // Register viewer with the invite token
    const viewer = await registerAndVerify({
      email: "viewer@bitig.test",
      username: "viewer",
      displayName: "Org Viewer",
      inviteToken,
    });
    expect(viewer.needsOnboarding).toBe(false);
    expect(viewer.memberships).toHaveLength(1);
    expect(viewer.memberships[0]?.role).toBe("viewer");

    // Owner creates a project
    const projRes = await req("/api/projects", {
      method: "POST",
      cookie: owner.cookie,
      org: org.slug,
      bodyJson: { name: "Shared Project", key: "SHR" },
    });
    expect(projRes.status).toBe(201);
    const project = await projRes.json<Project>();

    // Viewer can read projects and tasks
    expect((await req("/api/projects", { cookie: viewer.cookie, org: org.slug })).status).toBe(200);
    // Viewer gets 403 on write operations
    expect(
      (
        await req("/api/tasks", {
          method: "POST",
          cookie: viewer.cookie,
          org: org.slug,
          bodyJson: { projectId: project.id, title: "Blocked write" },
        })
      ).status,
    ).toBe(403);

    // Promote viewer to editor
    const promoteRes = await req(`/api/orgs/${org.slug}/members/${viewer.profile.id}`, {
      method: "PATCH",
      cookie: owner.cookie,
      bodyJson: { role: "editor" },
    });
    expect(promoteRes.status).toBe(200);

    // Editor can now create tasks, but cannot rename/delete the org or restore backups
    const taskRes = await req("/api/tasks", {
      method: "POST",
      cookie: viewer.cookie,
      org: org.slug,
      bodyJson: { projectId: project.id, title: "Editor task" },
    });
    expect(taskRes.status).toBe(201);
    expect(
      (
        await req(`/api/orgs/${org.slug}`, {
          method: "PATCH",
          cookie: viewer.cookie,
          bodyJson: { name: "Hijacked" },
        })
      ).status,
    ).toBe(403);

    // Owner cannot downgrade or remove themselves as the last owner
    expect(
      (
        await req(`/api/orgs/${org.slug}/members/${owner.profile.id}`, {
          method: "PATCH",
          cookie: owner.cookie,
          bodyJson: { role: "editor" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`/api/orgs/${org.slug}/members/${owner.profile.id}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(400);
  });

  it("issues per-user personal access tokens scoped to an organisation and revokes them on removal", async () => {
    const user = await registerAndVerify({
      email: "dev@bitig.test",
      username: "devuser",
      displayName: "Dev User",
      organisationName: "Dev Org",
    });
    const org = user.memberships[0]?.organisation;
    expect(org).toBeDefined();
    if (!org) throw new Error("missing org");

    const createTokenRes = await req("/api/me/tokens", {
      method: "POST",
      cookie: user.cookie,
      bodyJson: { orgId: org.id, name: "CLI Token" },
    });
    expect(createTokenRes.status).toBe(201);
    const { token, credential } = await createTokenRes.json<{
      token: string;
      credential: { id: string; prefix: string };
    }>();
    expect(token.startsWith("btg_")).toBe(true);

    // Token authenticates REST API and attributes human actions to the user
    const projRes = await req("/api/projects", {
      method: "POST",
      token,
      bodyJson: { name: "Token Project", key: "TKN" },
    });
    expect(projRes.status).toBe(201);
    const proj = await projRes.json<Project>();

    const taskRes = await req("/api/tasks", {
      method: "POST",
      token,
      headers: { "X-Bitig-Actor": "spoofed-actor" },
      bodyJson: { projectId: proj.id, title: "Attributed task" },
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json<Task>();
    expect(task.createdBy).toBe("Dev User");
    expect(task.activity?.[0]?.actor).toBe("Dev User");
    expect(task.activity?.[0]?.userId).toBe(user.profile.id);

    const commentRes = await req(`/api/tasks/${task.id}/comments`, {
      method: "POST",
      token,
      bodyJson: {
        body: "Hello from token",
        authorType: "agent",
        author: "spoofed",
        authorId: "01940000-0000-7000-8000-000000000999",
      },
    });
    expect(commentRes.status).toBe(201);
    const comment = await commentRes.json<Comment>();
    expect(comment.authorType).toBe("human");
    expect(comment.author).toBe("Dev User");
    expect(comment.authorId).toBe(user.profile.id);

    // Revoking token immediately stops it from working
    const revokeRes = await req(`/api/me/tokens/${credential.id}`, {
      method: "DELETE",
      cookie: user.cookie,
    });
    expect(revokeRes.status).toBe(204);
    expect((await req("/api/projects", { token })).status).toBe(401);
  });

  it("supports profile updates, verified email change, and soft-delete account deletion", async () => {
    const user = await registerAndVerify({
      email: "profile@bitig.test",
      username: "profuser",
      displayName: "Original Name",
      organisationName: "Solo Org",
    });

    // Update profile
    const patchRes = await req("/api/me", {
      method: "PATCH",
      cookie: user.cookie,
      bodyJson: {
        displayName: "Updated Name",
        username: "profuser2",
        avatarUrl: "https://example.com/avatar.png",
      },
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<{ user: User }>();
    expect(patched.user.displayName).toBe("Updated Name");
    expect(patched.user.username).toBe("profuser2");
    expect(patched.user.avatarUrl).toBe("https://example.com/avatar.png");

    // Change email via verification code
    const emailReq = await req("/api/me/email", {
      method: "POST",
      cookie: user.cookie,
      bodyJson: { email: "newemail@bitig.test" },
    });
    expect(emailReq.status).toBe(200);
    const emailCode = mailer.extractLastCode("newemail@bitig.test");
    expect(emailCode).toMatch(/^\d{6}$/);

    const emailVerify = await req("/api/me/email/verify", {
      method: "POST",
      cookie: user.cookie,
      bodyJson: { email: "newemail@bitig.test", code: emailCode },
    });
    expect(emailVerify.status).toBe(200);
    const emailUpdated = await emailVerify.json<{ user: User }>();
    expect(emailUpdated.user.email).toBe("newemail@bitig.test");

    // Soft-delete account
    const delCodeRes = await req("/api/me/delete/code", {
      method: "POST",
      cookie: user.cookie,
    });
    expect(delCodeRes.status).toBe(200);
    const delCode = mailer.extractLastCode("newemail@bitig.test");
    expect(delCode).toMatch(/^\d{6}$/);

    const delConfirm = await req("/api/me/delete/confirm", {
      method: "POST",
      cookie: user.cookie,
      bodyJson: { code: delCode },
    });
    expect(delConfirm.status).toBe(204);

    // Session is now invalid, and the email/username are freed for re-registration
    expect((await req("/api/me", { cookie: user.cookie })).status).toBe(401);
    const reregistered = await registerAndVerify({
      email: "newemail@bitig.test",
      username: "profuser2",
      displayName: "Reborn User",
    });
    expect(reregistered.profile.username).toBe("profuser2");
  });

  it("enforces platform-admin permissions on /api/admin/* and protects the last admin", async () => {
    const regular = await registerAndVerify({
      email: "regular@bitig.test",
      username: "regular",
      displayName: "Regular User",
      organisationName: "Regular Org",
    });

    // Regular user gets 403 on /api/admin/users
    expect((await req("/api/admin/users", { cookie: regular.cookie })).status).toBe(403);

    // Bootstrap admin can list users, create users, and inspect organisations
    const listRes = await req("/api/admin/users", {
      headers: { Authorization: TEST_AUTH_HEADER },
    });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json<{ users: (User & { orgCount: number })[]; total: number }>();
    expect(listBody.total).toBeGreaterThanOrEqual(2);

    const createRes = await req("/api/admin/users", {
      method: "POST",
      headers: { Authorization: TEST_AUTH_HEADER },
      bodyJson: {
        email: "invited-by-admin@bitig.test",
        username: "admincreated",
        displayName: "Admin Created",
        platformRole: "user",
      },
    });
    expect(createRes.status).toBe(201);
    expect(mailer.extractLastCode("invited-by-admin@bitig.test")).toMatch(/^\d{6}$/);

    // Cannot demote or delete the last platform admin
    const bootstrapAdmin = listBody.users.find((u) => u.email === TEST_BOOTSTRAP_EMAIL);
    expect(bootstrapAdmin).toBeDefined();
    const adminId = bootstrapAdmin?.id ?? "";
    expect(
      (
        await req(`/api/admin/users/${adminId}`, {
          method: "PATCH",
          headers: { Authorization: TEST_AUTH_HEADER },
          bodyJson: { platformRole: "user" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await req(`/api/admin/users/${adminId}`, {
          method: "DELETE",
          headers: { Authorization: TEST_AUTH_HEADER },
        })
      ).status,
    ).toBe(400);
  });

  it("migrates an existing single-user D1 schema in-place into Default Organisation without losing any data", async () => {
    // 1. Simulate the pre-0020 single-user schema (no org_id on projects, no author_id on comments)
    await env.DB.batch([
      env.DB.prepare("DROP TABLE IF EXISTS `feedback_entries`"),
      env.DB.prepare("DROP TABLE IF EXISTS `feedback_forms`"),
      env.DB.prepare("DROP TABLE IF EXISTS `t3_oauth_states`"),
      env.DB.prepare("DROP TABLE IF EXISTS `t3_connections`"),
      env.DB.prepare("DROP TABLE IF EXISTS `mcp_tokens`"),
      env.DB.prepare("DROP TABLE IF EXISTS `webhooks`"),
      env.DB.prepare("DROP TABLE IF EXISTS `attachments`"),
      env.DB.prepare("DROP TABLE IF EXISTS `checkpoints`"),
      env.DB.prepare("DROP TABLE IF EXISTS `comments`"),
      env.DB.prepare("DROP TABLE IF EXISTS `tasks`"),
      env.DB.prepare("DROP TABLE IF EXISTS `projects`"),
      env.DB.prepare("DROP TABLE IF EXISTS `invitations`"),
      env.DB.prepare("DROP TABLE IF EXISTS `access_tokens`"),
      env.DB.prepare("DROP TABLE IF EXISTS `auth_codes`"),
      env.DB.prepare("DROP TABLE IF EXISTS `sessions`"),
      env.DB.prepare("DROP TABLE IF EXISTS `memberships`"),
      env.DB.prepare("DROP TABLE IF EXISTS `organisations`"),
      env.DB.prepare("DROP TABLE IF EXISTS `users`"),
      env.DB.prepare("CREATE TABLE `attachments` (`id` text PRIMARY KEY NOT NULL, `task_id` text NOT NULL, `name` text NOT NULL, `mime_type` text NOT NULL, `size` integer NOT NULL, `created_at` integer NOT NULL, `created_by` text)"),
      env.DB.prepare(`CREATE TABLE \`projects\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`name\` text NOT NULL,
        \`description\` text DEFAULT '' NOT NULL,
        \`kind\` text DEFAULT 'hobby' NOT NULL,
        \`resources\` text,
        \`key\` text,
        \`archived\` integer,
        \`created_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE \`tasks\` (
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
      )`),
      env.DB.prepare(`CREATE TABLE \`comments\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`task_id\` text NOT NULL,
        \`body\` text NOT NULL,
        \`author_type\` text NOT NULL,
        \`author\` text,
        \`created_at\` integer NOT NULL,
        FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
      )`),
      env.DB.prepare(`CREATE TABLE \`checkpoints\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`task_id\` text NOT NULL,
        \`step_index\` integer NOT NULL,
        \`status\` text NOT NULL,
        \`state_snapshot\` text NOT NULL,
        \`created_at\` integer NOT NULL,
        \`created_by\` text,
        FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
      )`),
      env.DB.prepare(`CREATE TABLE \`webhooks\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`project_id\` text NOT NULL,
        \`name\` text NOT NULL,
        \`source\` text NOT NULL,
        \`token\` text NOT NULL,
        \`secret\` text,
        \`enabled\` integer DEFAULT 1 NOT NULL,
        \`default_status\` text DEFAULT 'todo' NOT NULL,
        \`default_priority\` text,
        \`default_labels\` text,
        \`trigger_count\` integer DEFAULT 0 NOT NULL,
        \`last_triggered_at\` integer,
        \`created_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL,
        FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
      )`),
      env.DB.prepare(`CREATE TABLE \`t3_connections\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`mcp_url\` text NOT NULL,
        \`issuer\` text NOT NULL,
        \`client_id\` text NOT NULL,
        \`encrypted_access_token\` text NOT NULL,
        \`token_iv\` text NOT NULL,
        \`scope\` text NOT NULL,
        \`expires_at\` integer NOT NULL,
        \`connected_at\` integer NOT NULL,
        \`updated_at\` integer NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE \`t3_oauth_states\` (
        \`state\` text PRIMARY KEY NOT NULL,
        \`mcp_url\` text NOT NULL,
        \`issuer\` text NOT NULL,
        \`token_endpoint\` text NOT NULL,
        \`client_id\` text NOT NULL,
        \`code_verifier\` text NOT NULL,
        \`redirect_uri\` text NOT NULL,
        \`created_at\` integer NOT NULL,
        \`expires_at\` integer NOT NULL
      )`),
      env.DB.prepare(`CREATE TABLE \`mcp_tokens\` (
        \`id\` text PRIMARY KEY NOT NULL,
        \`label\` text NOT NULL,
        \`transport\` text NOT NULL,
        \`digest\` text NOT NULL UNIQUE,
        \`created_at\` text NOT NULL,
        \`expires_at\` text,
        \`revoked_at\` text
      )`),
    ]);

    const legacyProjectId = "01a14ecf-281e-7436-8c52-a524c5fabc2f";
    const legacyTaskId = "01a15b6b-1111-7000-8000-000000000041";
    const legacyCommentId = "01a15b6b-2222-7000-8000-000000000042";
    const legacyMcpTokenId = "01a15b6b-3333-7000-8000-000000000043";
    const now = 1791723553130;
    const futureExpiry = Date.now() + 14 * 24 * 60 * 60 * 1000;

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO `projects` (`id`, `name`, `description`, `kind`, `key`, `created_at`, `updated_at`) VALUES (?, 'Bitig Production', 'Existing prod project', 'internal', 'BIT', ?, ?)",
      ).bind(legacyProjectId, now, now),
      env.DB.prepare(
        "INSERT INTO `tasks` (`id`, `project_id`, `title`, `description`, `status`, `number`, `created_at`, `updated_at`) VALUES (?, ?, 'Multi User', 'Umbrella task', 'in_progress', 41, ?, ?)",
      ).bind(legacyTaskId, legacyProjectId, now, now),
      env.DB.prepare(
        "INSERT INTO `comments` (`id`, `task_id`, `body`, `author_type`, `author`, `created_at`) VALUES (?, ?, 'Legacy comment', 'human', 'Emre', ?)",
      ).bind(legacyCommentId, legacyTaskId, now),
      env.DB.prepare(
        "INSERT INTO `t3_connections` (`id`, `mcp_url`, `issuer`, `client_id`, `encrypted_access_token`, `token_iv`, `scope`, `expires_at`, `connected_at`, `updated_at`) VALUES ('default', 'https://t3.prod.test/mcp', 'https://t3.prod.test', 'client-prod', 'cipher', 'iv', 'mcp:tools', ?, ?, ?)",
      ).bind(futureExpiry, now, now),
      env.DB.prepare(
        "INSERT INTO `mcp_tokens` (`id`, `label`, `transport`, `digest`, `created_at`, `expires_at`, `revoked_at`) VALUES (?, 'Prod Claude Desktop', 'bearer', 'prod-digest-hex', '2026-11-01T00:00:00.000Z', NULL, NULL)",
      ).bind(legacyMcpTokenId),
    ]);

    // 2. Apply the 0020_multi_user.sql migration statements in-place
    await req("/api/auth/code", { method: "POST", bodyJson: { email: TEST_BOOTSTRAP_EMAIL } });
    await env.DB.batch([
      env.DB.prepare(
        "ALTER TABLE `projects` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL",
      ),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS `projects_org_id_idx` ON `projects` (`org_id`)"),
      env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS `projects_org_key_unique` ON `projects` (`org_id`,`key`)"),
      env.DB.prepare("ALTER TABLE `comments` ADD `author_id` text"),
      env.DB.prepare("ALTER TABLE `comments` ADD `author_avatar_url` text"),
      env.DB.prepare(
        "ALTER TABLE `t3_connections` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL",
      ),
      env.DB.prepare("ALTER TABLE `t3_connections` ADD `label` text"),
      env.DB.prepare("ALTER TABLE `t3_connections` ADD `kind` text DEFAULT 'user' NOT NULL"),
      env.DB.prepare("ALTER TABLE `t3_connections` ADD `projects_root` text DEFAULT '~/www' NOT NULL"),
      env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS `t3_connections_org_id_idx` ON `t3_connections` (`org_id`)",
      ),
      env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS `t3_connections_org_mcp_url_unique` ON `t3_connections` (`org_id`, `mcp_url`)",
      ),
      env.DB.prepare(
        "ALTER TABLE `t3_oauth_states` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL",
      ),
      env.DB.prepare("ALTER TABLE `t3_oauth_states` ADD `host_id` text"),
      env.DB.prepare("ALTER TABLE `t3_oauth_states` ADD `label` text"),
      env.DB.prepare("ALTER TABLE `t3_oauth_states` ADD `kind` text DEFAULT 'user' NOT NULL"),
      env.DB.prepare("ALTER TABLE `t3_oauth_states` ADD `projects_root` text DEFAULT '~/www' NOT NULL"),
      env.DB.prepare(
        "ALTER TABLE `mcp_tokens` ADD `org_id` text DEFAULT '01a10000-0000-7000-8000-000000000001' NOT NULL",
      ),
      env.DB.prepare("CREATE INDEX IF NOT EXISTS `mcp_tokens_org_id_idx` ON `mcp_tokens` (`org_id`)"),
    ]);

    // 3. Sign in as bootstrap admin and verify existing project, task, comment, t3_connections, and mcp_tokens are bound to Default Organisation
    await req("/api/auth/code", { method: "POST", bodyJson: { email: TEST_BOOTSTRAP_EMAIL } });
    const adminCode = mailer.extractLastCode(TEST_BOOTSTRAP_EMAIL);
    const verifyRes = await req("/api/auth/verify", {
      method: "POST",
      bodyJson: { email: TEST_BOOTSTRAP_EMAIL, code: adminCode },
    });
    expect(verifyRes.status).toBe(200);
    const adminCookie = cookiePair(verifyRes);

    const projectsRes = await req("/api/projects", { cookie: adminCookie });
    expect(projectsRes.status).toBe(200);
    const projects = await projectsRes.json<Project[]>();
    expect(projects.map((p) => p.id)).toContain(legacyProjectId);
    expect(projects.find((p) => p.id === legacyProjectId)?.name).toBe("Bitig Production");
    expect(projects.find((p) => p.id === legacyProjectId)?.key).toBe("BIT");

    const tasksRes = await req(`/api/tasks?projectId=${legacyProjectId}`, { cookie: adminCookie });
    expect(tasksRes.status).toBe(200);
    const tasks = await tasksRes.json<Task[]>();
    expect(tasks.map((t) => t.id)).toEqual([legacyTaskId]);

    const commentsRes = await req(`/api/tasks/${legacyTaskId}/comments`, { cookie: adminCookie });
    expect(commentsRes.status).toBe(200);
    const comments = await commentsRes.json<Comment[]>();
    expect(comments.map((c) => c.id)).toEqual([legacyCommentId]);
    expect(comments[0]?.body).toBe("Legacy comment");

    const t3ConnRes = await req("/api/t3/connection", { cookie: adminCookie });
    expect(t3ConnRes.status).toBe(200);
    const t3Conn = await t3ConnRes.json<{ connected: boolean; mcpUrl?: string }>();
    expect(t3Conn.connected).toBe(true);
    expect(t3Conn.mcpUrl).toBe("https://t3.prod.test/mcp");

    const mcpTokensRes = await req("/api/mcp-tokens", { cookie: adminCookie });
    expect(mcpTokensRes.status).toBe(200);
    const mcpTokens = await mcpTokensRes.json<{ id: string; label: string }[]>();
    expect(mcpTokens.map((t) => t.id)).toEqual([legacyMcpTokenId]);
    expect(mcpTokens[0]?.label).toBe("Prod Claude Desktop");

    // 4. Verify another organisation does not see Default Organisation's t3_connections or mcp_tokens
    const otherUser = await registerAndVerify({
      email: "other-org@bitig.test",
      username: "otherorguser",
      displayName: "Other Org User",
      organisationName: "Separate Org",
    });
    const otherOrgSlug = otherUser.memberships[0]?.organisation.slug ?? "";
    const otherT3Res = await req("/api/t3/connection", { cookie: otherUser.cookie, org: otherOrgSlug });
    expect(otherT3Res.status).toBe(200);
    expect(await otherT3Res.json()).toEqual({ connected: false });

    const otherMcpRes = await req("/api/mcp-tokens", { cookie: otherUser.cookie, org: otherOrgSlug });
    expect(otherMcpRes.status).toBe(200);
    expect(await otherMcpRes.json()).toEqual([]);
  });
});

