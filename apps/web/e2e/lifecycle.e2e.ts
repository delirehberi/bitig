/**
 * Full dashboard lifecycle in a real browser against `make dev` (Vite + wrangler dev + local D1):
 * sign in on /login, create a project with a link, create a task, edit it and add subtasks, check one,
 * complete it. Credentials come from the
 * environment (`make e2e` loads them from apps/worker/.dev.vars). The local database persists
 * between runs, so names are unique per run and the project is deleted afterwards.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

interface ProjectRecord {
  id: string;
  name: string;
  resources?: { type: string; label: string; url: string }[];
}

interface TaskRecord {
  id: string;
  title: string;
  status: string;
  priority?: string;
  checklist?: { text: string; done: boolean }[];
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
    // Signed-out visitors land on /login and return to the page they asked for
    await page.goto("/projects");
    await expect(page).toHaveURL(/\/login\?next=%2Fprojects$/);
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await expect(page).toHaveURL(/\/projects$/);

    // The session cookie and the URL survive a reload
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Primary" });

    // Create a project
    await page.getByRole("button", { name: /new project/i }).click();
    const projectDialog = page.getByRole("dialog");
    await projectDialog.getByLabel(/project name/i).fill(projectName);
    await projectDialog.getByRole("button", { name: "Add link" }).click();
    await projectDialog.getByLabel("Link 1 type").selectOption("repository");
    await projectDialog.getByLabel("Link 1 URL").fill("https://github.com/acme/e2e");
    await projectDialog.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByText(projectName)).toBeVisible();
    await expect(page.getByRole("link", { name: "github.com" })).toHaveAttribute(
      "href",
      "https://github.com/acme/e2e",
    );

    // Create a task in that project
    await nav.getByRole("link", { name: "Tasks" }).click();
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
    await editDialog.getByLabel("New subtask").fill("Draft");
    await editDialog.getByLabel("New subtask").press("Enter");
    await editDialog.getByLabel("New subtask").fill("Review");
    await editDialog.getByLabel("New subtask").press("Enter");
    await editDialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(page.getByText(editedTitle, { exact: true })).toBeVisible();

    // Check a subtask from the detail view; the card shows the progress
    await page.getByRole("button", { name: editedTitle, exact: true }).click();
    const detail = page.getByRole("dialog");
    await detail.getByLabel("Draft").check();
    await expect(detail.getByTitle("1 of 2 subtasks done")).toBeVisible();
    await detail.getByRole("button", { name: "Close dialog" }).click();

    // Complete the task
    const card = page.locator("article", { hasText: editedTitle });
    await card.getByRole("button", { name: "Mark as Done" }).click();
    await expect(card.getByRole("button", { name: "Mark as To Do" })).toBeVisible();

    // The Worker persisted every change
    const project = await findProject(request, projectName);
    expect(project?.resources).toEqual([
      { type: "repository", label: "github.com", url: "https://github.com/acme/e2e" },
    ]);
    const tasksRes = await request.get(`/api/tasks?projectId=${encodeURIComponent(project?.id ?? "")}`, {
      headers: { Authorization: AUTH_HEADER },
    });
    expect(tasksRes.ok()).toBe(true);
    const tasks = (await tasksRes.json()) as TaskRecord[];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: editedTitle,
      priority: "high",
      status: "done",
      checklist: [
        { text: "Draft", done: true },
        { text: "Review", done: false },
      ],
    });
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
