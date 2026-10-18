/**
 * Full dashboard lifecycle in a real browser against `make dev` (Vite + wrangler dev + local D1):
 * sign in, create a project, create a task, edit it, complete it. Credentials come from the
 * environment (`make e2e` loads them from apps/worker/.dev.vars). The local database persists
 * between runs, so names are unique per run and the project is deleted afterwards.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

interface ProjectRecord {
  id: string;
  name: string;
}

interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set; run the browser tests with \`make e2e\``);
  }
  return value;
}

const USERNAME = requireEnv("BASIC_AUTH_USER");
const PASSWORD = requireEnv("BASIC_AUTH_PASS");
const AUTH_HEADER = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

async function findProject(request: APIRequestContext, name: string): Promise<ProjectRecord | undefined> {
  const res = await request.get("/api/projects", { headers: { Authorization: AUTH_HEADER } });
  expect(res.ok()).toBe(true);
  const projects = (await res.json()) as ProjectRecord[];
  return projects.find((p) => p.name === name);
}

test("signs in and runs a project and task lifecycle against the Worker", async ({ page, request }) => {
  const runId = String(Date.now());
  const projectName = `E2E Project ${runId}`;
  const taskTitle = `E2E Task ${runId}`;
  const editedTitle = `E2E Task ${runId} (edited)`;

  try {
    await page.goto("/");
    const nav = page.getByRole("navigation", { name: "Primary" });

    // Sign in
    await page.getByRole("button", { name: /sign in/i }).click();
    const loginDialog = page.getByRole("dialog");
    await loginDialog.getByLabel(/username/i).fill(USERNAME);
    await loginDialog.getByLabel(/password/i).fill(PASSWORD);
    await loginDialog.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    // Create a project
    await nav.getByRole("button", { name: "Projects" }).click();
    await page.getByRole("button", { name: /new project/i }).click();
    const projectDialog = page.getByRole("dialog");
    await projectDialog.getByLabel(/project name/i).fill(projectName);
    await projectDialog.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByText(projectName)).toBeVisible();

    // Create a task in that project
    await nav.getByRole("button", { name: "Tasks" }).click();
    await page.getByRole("button", { name: /new task/i }).click();
    const taskDialog = page.getByRole("dialog");
    await taskDialog.getByLabel(/project/i).selectOption({ label: projectName });
    await taskDialog.getByLabel(/title/i).fill(taskTitle);
    await taskDialog.getByRole("button", { name: "Create Task" }).click();
    await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();

    // Edit the task: the form is prefilled, then title and priority change
    await page.getByRole("button", { name: `Edit ${taskTitle}` }).click();
    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByLabel(/title/i)).toHaveValue(taskTitle);
    await editDialog.getByLabel(/title/i).fill(editedTitle);
    await editDialog.getByLabel(/priority/i).selectOption("high");
    await editDialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText(editedTitle, { exact: true })).toBeVisible();

    // Complete the task
    const card = page.locator("article", { hasText: editedTitle });
    await card.getByRole("button", { name: "Mark as Done" }).click();
    await expect(card.getByRole("button", { name: "Mark as To Do" })).toBeVisible();

    // The Worker persisted every change
    const project = await findProject(request, projectName);
    expect(project).toBeDefined();
    const tasksRes = await request.get(`/api/tasks?projectId=${encodeURIComponent(project?.id ?? "")}`, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(tasksRes.ok()).toBe(true);
    const tasks = (await tasksRes.json()) as TaskRecord[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: editedTitle, priority: "high", status: "done" });
  } finally {
    // Same-origin DELETE without a browser Origin passes CSRF as a non-browser client.
    const project = await findProject(request, projectName);
    if (project) {
      const res = await request.delete(`/api/projects/${encodeURIComponent(project.id)}`, {
        headers: { Authorization: AUTH_HEADER },
      });
      expect(res.ok()).toBe(true);
    }
  }
});
