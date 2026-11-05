import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@bitig/core";
import { D1Storage } from "./d1-storage";
import { D1UserStore } from "./user-store";
import { D1OrganisationStore } from "./organisation-store";
import { D1SessionStore } from "./session-store";
import { D1AuthCodeStore } from "./auth-code-store";
import { D1AccessTokenStore } from "./access-token-store";
import { D1InvitationStore } from "./invitation-store";

const STATEMENTS = [
  "DROP TABLE IF EXISTS `access_tokens`",
  "DROP TABLE IF EXISTS `invitations`",
  "DROP TABLE IF EXISTS `auth_codes`",
  "DROP TABLE IF EXISTS `sessions`",
  "DROP TABLE IF EXISTS `memberships`",
  "DROP TABLE IF EXISTS `webhooks`",
  "DROP TABLE IF EXISTS `attachments`",
  "DROP TABLE IF EXISTS `checkpoints`",
  "DROP TABLE IF EXISTS `comments`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  "DROP TABLE IF EXISTS `organisations`",
  "DROP TABLE IF EXISTS `users`",
  `CREATE TABLE \`users\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`email\` text NOT NULL,
    \`email_verified_at\` integer,
    \`username\` text NOT NULL,
    \`display_name\` text NOT NULL,
    \`avatar_url\` text,
    \`platform_role\` text DEFAULT 'user' NOT NULL,
    \`status\` text DEFAULT 'active' NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`last_login_at\` integer,
    \`deleted_at\` integer
  )`,
  "CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`)",
  "CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`)",
  `CREATE TABLE \`organisations\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`slug\` text NOT NULL,
    \`name\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    \`deleted_at\` integer
  )`,
  "CREATE UNIQUE INDEX `organisations_slug_unique` ON `organisations` (`slug`)",
  `CREATE TABLE \`memberships\` (
    \`org_id\` text NOT NULL,
    \`user_id\` text NOT NULL,
    \`role\` text DEFAULT 'viewer' NOT NULL,
    \`created_at\` integer NOT NULL,
    FOREIGN KEY (\`org_id\`) REFERENCES \`organisations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `memberships_org_user_unique` ON `memberships` (`org_id`, `user_id`)",
  "CREATE INDEX `memberships_user_id_idx` ON `memberships` (`user_id`)",
  `CREATE TABLE \`sessions\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`user_id\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`last_seen_at\` integer NOT NULL,
    \`user_agent\` text,
    \`ip\` text,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`)",
  `CREATE TABLE \`auth_codes\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`email\` text NOT NULL,
    \`code_hash\` text NOT NULL,
    \`purpose\` text DEFAULT 'sign_in' NOT NULL,
    \`payload\` text,
    \`attempts\` integer DEFAULT 0 NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`consumed_at\` integer
  )`,
  "CREATE INDEX `auth_codes_email_purpose_idx` ON `auth_codes` (`email`, `purpose`)",
  `CREATE TABLE \`invitations\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`org_id\` text NOT NULL,
    \`email\` text NOT NULL,
    \`role\` text DEFAULT 'viewer' NOT NULL,
    \`token_hash\` text NOT NULL,
    \`invited_by\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`expires_at\` integer NOT NULL,
    \`accepted_at\` integer,
    \`revoked_at\` integer,
    FOREIGN KEY (\`org_id\`) REFERENCES \`organisations\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`invited_by\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`)",
  `CREATE TABLE \`access_tokens\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`user_id\` text NOT NULL,
    \`org_id\` text NOT NULL,
    \`name\` text NOT NULL,
    \`token_hash\` text NOT NULL,
    \`prefix\` text NOT NULL,
    \`created_at\` integer NOT NULL,
    \`last_used_at\` integer,
    \`expires_at\` integer,
    \`revoked_at\` integer,
    FOREIGN KEY (\`user_id\`) REFERENCES \`users\`(\`id\`) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (\`org_id\`) REFERENCES \`organisations\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX `access_tokens_token_hash_unique` ON `access_tokens` (`token_hash`)",
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
];

describe("D1 multi-user stores and org isolation", () => {
  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  it("manages users, organisations, memberships, sessions, auth codes, invitations, and access tokens", async () => {
    const userStore = new D1UserStore(env.DB);
    const orgStore = new D1OrganisationStore(env.DB);
    const sessionStore = new D1SessionStore(env.DB);
    const authCodeStore = new D1AuthCodeStore(env.DB);
    const tokenStore = new D1AccessTokenStore(env.DB);
    const inviteStore = new D1InvitationStore(env.DB);

    const alice = await userStore.create({
      email: "Alice@Example.com",
      username: "alice",
      displayName: "Alice",
      platformRole: "admin",
    });
    expect(alice.email).toBe("alice@example.com");

    const bob = await userStore.create({
      email: "bob@example.com",
      username: "bob",
      displayName: "Bob",
      platformRole: "user",
    });

    // Cannot demote last admin
    await expect(userStore.update(alice.id, { platformRole: "user" })).rejects.toBeInstanceOf(ValidationError);

    // Create organisation
    const org = await orgStore.create({ name: "Acme", slug: "acme" }, alice.id);
    expect(org.slug).toBe("acme");
    await expect(orgStore.create({ name: "Acme 2", slug: "acme" }, alice.id)).rejects.toBeInstanceOf(ValidationError);

    // Cannot remove last owner
    await expect(orgStore.removeMember(org.id, alice.id)).rejects.toBeInstanceOf(ValidationError);

    // Invite Bob and accept
    const invite = await inviteStore.create({
      orgId: org.id,
      email: bob.email,
      role: "editor",
      tokenHash: "invite-hash-1",
      invitedBy: alice.id,
    });
    const lookedUpInvite = await inviteStore.getByTokenHash("invite-hash-1");
    expect(lookedUpInvite?.orgSlug).toBe("acme");

    const accepted = await inviteStore.accept(invite.id);
    expect(accepted?.acceptedAt).toBeDefined();
    await orgStore.addMember(org.id, bob.id, "editor");

    const members = await orgStore.listMembers(org.id);
    expect(members).toHaveLength(2);

    // Sessions
    const session = await sessionStore.create({
      id: "sess-hash-1",
      userId: alice.id,
      expiresAt: Date.now() + 60_000,
      userAgent: "TestAgent/1.0",
      ip: "127.0.0.1",
    });
    expect(session.userId).toBe(alice.id);
    const withUser = await sessionStore.getWithUser("sess-hash-1");
    expect(withUser?.user.email).toBe("alice@example.com");

    // Auth codes
    await authCodeStore.issue({
      email: "alice@example.com",
      codeHash: "correct-hash",
      purpose: "sign_in",
    });
    const badVerify = await authCodeStore.verifyAndConsume({
      email: "alice@example.com",
      codeHash: "wrong-hash",
    });
    expect(badVerify).toEqual({ ok: false, reason: "invalid" });

    const goodVerify = await authCodeStore.verifyAndConsume({
      email: "alice@example.com",
      codeHash: "correct-hash",
    });
    expect(goodVerify.ok).toBe(true);

    // Replay fails
    const replayVerify = await authCodeStore.verifyAndConsume({
      email: "alice@example.com",
      codeHash: "correct-hash",
    });
    expect(replayVerify).toEqual({ ok: false, reason: "invalid" });

    // Access tokens
    const token = await tokenStore.create({
      userId: bob.id,
      orgId: org.id,
      name: "Bob Laptop",
      tokenHash: "tok-hash-bob",
      prefix: "btg_1234",
    });
    expect(token.name).toBe("Bob Laptop");

    const verified = await tokenStore.verifyByHash("tok-hash-bob");
    expect(verified?.user.id).toBe(bob.id);
    expect(verified?.orgId).toBe(org.id);
    expect(verified?.orgRole).toBe("editor");

    await tokenStore.revokeAllForUserInOrg(bob.id, org.id);
    expect(await tokenStore.verifyByHash("tok-hash-bob")).toBeNull();
  });

  it("isolates projects, tasks, comments, and duplicate project keys across organisations", async () => {
    const orgA = "01a10000-0000-7000-8000-0000000000a1";
    const orgB = "01a10000-0000-7000-8000-0000000000b2";

    const storageA = new D1Storage({ db: env.DB, orgId: orgA });
    const storageB = new D1Storage({ db: env.DB, orgId: orgB });

    // Both orgs can create a project with the same key 'BIT'
    const projA = await storageA.createProject({ name: "Bitig A", key: "BIT" });
    const projB = await storageB.createProject({ name: "Bitig B", key: "BIT" });
    expect(projA.key).toBe("BIT");
    expect(projB.key).toBe("BIT");

    // Org A only sees projA; Org B only sees projB
    expect((await storageA.getProjects()).map((p) => p.id)).toEqual([projA.id]);
    expect((await storageB.getProjects()).map((p) => p.id)).toEqual([projB.id]);
    expect(await storageA.getProject(projB.id)).toBeNull();

    // Tasks and comments in Org A are invisible to Org B
    const taskA = await storageA.saveTask(
      { projectId: projA.id, title: "Secret Task A" },
      { actor: "Alice", userId: "01a10000-0000-7000-8000-000000000000" },
    );
    const commentA = await storageA.addComment(
      { taskId: taskA.id, body: "Secret Comment", authorType: "human", author: "Alice" },
      { actor: "Alice", userId: "01a10000-0000-7000-8000-000000000000" },
    );
    expect(commentA.authorId).toBe("01a10000-0000-7000-8000-000000000000");

    expect(await storageB.getTask(taskA.id)).toBeNull();
    expect(await storageB.getTasks()).toEqual([]);
    expect(await storageB.getTasks({ projectId: projA.id })).toEqual([]);
    expect(await storageB.getComments(taskA.id)).toEqual([]);
    await expect(storageB.updateTask(taskA.id, { title: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(storageB.deleteTask(taskA.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(storageB.deleteComment(commentA.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});
