import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { Project, Task } from "@bitig/core";
import { TEST_AUTH_HEADER } from "./constants";

const BASE_URL = "https://bitig.test";

const STATEMENTS = [
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  `CREATE TABLE \`projects\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`kind\` text DEFAULT 'hobby' NOT NULL,
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

