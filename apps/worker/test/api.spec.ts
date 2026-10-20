import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Comment, Project, Task, TaskWithCode, Webhook } from "@bitig/core";
import { TEST_AUTH_HEADER } from "./constants";

const BASE_URL = "https://bitig.test";

const STATEMENTS = [
  "DROP TABLE IF EXISTS `webhooks`",
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
    \`pending_approval\` integer,
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

function apiRequest(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has("Authorization")) {
    headers.set("Authorization", TEST_AUTH_HEADER);
  }
  return exports.default.fetch(new Request(`${BASE_URL}${path}`, { ...init, headers }));
}

describe("Basic Authentication", () => {
  it("rejects unauthenticated requests to /api/projects with 401", async () => {
    const res = await exports.default.fetch(new Request(`${BASE_URL}/api/projects`));
    expect(res.status).toBe(401);
    // No Basic challenge, so browsers never show their native login prompt.
    expect(res.headers.get("www-authenticate")).toBeNull();
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with invalid credentials", async () => {
    const invalidAuth = `Basic ${btoa("admin:wrongpassword")}`;
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/projects`, {
        headers: { Authorization: invalidAuth },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with malformed Authorization header", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/projects`, {
        headers: { Authorization: "Bearer something" },
      }),
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("REST API: Projects", () => {
  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  it("starts with empty list", async () => {
    const res = await apiRequest("/api/projects");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("creates a project with defaults and retrieves it", async () => {
    const createRes = await apiRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Work" }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<Project>();
    expect(created.name).toBe("Work");
    expect(created.kind).toBe("hobby");
    expect(created.description).toBe("");

    const getRes = await apiRequest(`/api/projects/${created.id}`);
    expect(getRes.status).toBe(200);
    expect(await getRes.json<Project>()).toEqual(created);

    const listRes = await apiRequest("/api/projects");
    expect(listRes.status).toBe(200);
    expect(await listRes.json<Project[]>()).toEqual([created]);
  });

  it("rejects invalid project input", async () => {
    const res = await apiRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "   " }),
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("validation_error");
  });

  it("returns 404 for missing project", async () => {
    const res = await apiRequest("/api/projects/01940000-0000-7000-8fff-ffffffffffff");
    expect(res.status).toBe(404);
  });

  it("updates and deletes a project", async () => {
    const createRes = await apiRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Initial", kind: "personal" }),
    });
    const created = await createRes.json<Project>();

    const updateRes = await apiRequest(`/api/projects/${created.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Updated" }),
    });
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json<Project>();
    expect(updated.name).toBe("Updated");
    expect(updated.kind).toBe("personal");

    const deleteRes = await apiRequest(`/api/projects/${created.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(204);

    const getRes = await apiRequest(`/api/projects/${created.id}`);
    expect(getRes.status).toBe(404);
  });
});

describe("REST API: Tasks", () => {
  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  it("creates, filters, completes and deletes tasks", async () => {
    const pRes = await apiRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Main Project" }),
    });
    const project = await pRes.json<Project>();

    const taskRes = await apiRequest("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        title: "Test Task",
        priority: "urgent",
      }),
    });
    expect(taskRes.status).toBe(201);
    const task = await taskRes.json<Task>();
    expect(task.title).toBe("Test Task");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("urgent");

    // Filter by project
    const filteredRes = await apiRequest(`/api/tasks?projectId=${project.id}`);
    expect(filteredRes.status).toBe(200);
    expect(await filteredRes.json<Task[]>()).toEqual([task]);

    // Complete task
    const completeRes = await apiRequest(`/api/tasks/${task.id}/complete`, {
      method: "POST",
    });
    expect(completeRes.status).toBe(200);
    const completed = await completeRes.json<Task>();
    expect(completed.status).toBe("done");

    // Patch task
    const patchRes = await apiRequest(`/api/tasks/${task.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Patched Title" }),
    });
    expect(patchRes.status).toBe(200);
    const patched = await patchRes.json<Task>();
    expect(patched.title).toBe("Patched Title");

    // Delete task
    const deleteRes = await apiRequest(`/api/tasks/${task.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(204);

    const getRes = await apiRequest(`/api/tasks/${task.id}`);
    expect(getRes.status).toBe(404);
  });

  it("cascades task deletion when project is deleted", async () => {
    const pRes = await apiRequest("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "To Delete" }),
    });
    const project = await pRes.json<Project>();

    const taskRes = await apiRequest("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        title: "Will be deleted",
      }),
    });
    const task = await taskRes.json<Task>();

    await apiRequest(`/api/projects/${project.id}`, { method: "DELETE" });

    const getTaskRes = await apiRequest(`/api/tasks/${task.id}`);
    expect(getTaskRes.status).toBe(404);
  });
});

describe("REST API: Comments", () => {
  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return apiRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("adds, lists and deletes a task's comments", async () => {
    const project = await (await postJson("/api/projects", { name: "Work" })).json<Project>();
    const task = await (await postJson("/api/tasks", { projectId: project.id, title: "Needs a key" })).json<Task>();

    const addRes = await postJson(`/api/tasks/${task.id}/comments`, {
      body: "Which key?",
      authorType: "agent",
      author: "claude",
    });
    expect(addRes.status).toBe(201);
    const comment = await addRes.json<Comment>();
    expect(comment).toMatchObject({ taskId: task.id, body: "Which key?", authorType: "agent", author: "claude" });

    expect((await postJson(`/api/tasks/${task.id}/comments`, { body: " " })).status).toBe(400);
    expect((await postJson(`/api/tasks/${task.id}/comments`, { body: "x", taskId: task.id })).status).toBe(400);
    expect((await postJson("/api/tasks/01940000-0000-7000-8fff-ffffffffffff/comments", { body: "x" })).status).toBe(404);

    const listRes = await apiRequest(`/api/tasks/${task.id}/comments`);
    expect(await listRes.json<Comment[]>()).toEqual([comment]);

    expect((await apiRequest(`/api/comments/${comment.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await apiRequest(`/api/comments/${comment.id}`, { method: "DELETE" })).status).toBe(404);
    expect(await (await apiRequest(`/api/tasks/${task.id}/comments`)).json<Comment[]>()).toEqual([]);
  });
});

describe("REST API & Incoming Receiver: Webhooks", () => {
  beforeEach(async () => {
    await env.DB.batch(STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  async function postJson(path: string, body: unknown): Promise<Response> {
    return apiRequest(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("creates a webhook and saves tasks from incoming Sentry and mapped payloads via POST /webhooks/:token", async () => {
    const project = await (await postJson("/api/projects", { name: "Bitig", key: "BIT" })).json<Project>();

    const createRes = await postJson("/api/webhooks", {
      projectId: project.id,
      name: "Sentry Prod",
      provider: "sentry",
      defaultLabels: ["production"],
    });
    expect(createRes.status).toBe(201);
    const webhook = await createRes.json<Webhook>();
    expect(webhook.provider).toBe("sentry");
    expect(webhook.token).toMatch(/^whk_[0-9a-f]{32,64}$/);

    // Trigger incoming webhook without Basic Auth (uses secret token in URL)
    const hookRes = await exports.default.fetch(
      new Request(`${BASE_URL}/webhooks/${webhook.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: {
            issue: {
              shortId: "SENTRY-99",
              title: "ReferenceError: window is not defined",
              culprit: "apps/worker/src/index.ts",
              level: "fatal",
              permalink: "https://sentry.io/issues/99/",
            },
          },
        }),
      }),
    );
    expect(hookRes.status).toBe(201);
    const createdTask = await hookRes.json<TaskWithCode>();
    expect(createdTask.code).toBe("BIT-1");
    expect(createdTask.title).toBe("[SENTRY-99] ReferenceError: window is not defined");
    expect(createdTask.priority).toBe("urgent");
    expect(createdTask.labels).toEqual(["production", "sentry", "fatal"]);
    expect(createdTask.pendingApproval).toBe(true);

    // Verify triggerCount and lastTriggeredAt updated
    const updatedHook = await (await apiRequest(`/api/webhooks/${webhook.id}`)).json<Webhook>();
    expect(updatedHook.triggerCount).toBe(1);
    expect(updatedHook.lastTriggeredAt).toBeDefined();

    // Disable webhook and verify 403
    await apiRequest(`/api/webhooks/${webhook.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    const disabledRes = await exports.default.fetch(
      new Request(`${BASE_URL}/webhooks/${webhook.token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Should be blocked" }),
      }),
    );
    expect(disabledRes.status).toBe(403);

    // Invalid token returns 404
    const notFoundRes = await exports.default.fetch(
      new Request(`${BASE_URL}/webhooks/whk_00000000000000000000000000000000`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Unknown token" }),
      }),
    );
    expect(notFoundRes.status).toBe(404);
  });
});
