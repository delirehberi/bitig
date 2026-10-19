/**
 * Ordering in a real browser against `make dev`: the projects page lists the project worked on
 * most recently first, and dragging a card on the board changes the task order, which survives a
 * reload. Credentials come from the environment (`make e2e` loads them from apps/worker/.dev.vars).
 */
import { expect, test, type Page } from "@playwright/test";

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

async function createProject(page: Page, name: string) {
  await page.getByRole("button", { name: /new project/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/project name/i).fill(name);
  await dialog.getByRole("button", { name: "Create Project" }).click();
  await expect(dialog).toBeHidden();
}

async function createTask(page: Page, projectName: string, title: string) {
  await page.getByRole("button", { name: /new task/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/project/i).selectOption({ label: projectName });
  await dialog.getByLabel(/title/i).fill(title);
  await dialog.getByRole("button", { name: "Create Task" }).click();
  await expect(dialog).toBeHidden();
}

test("orders projects by activity and tasks by drag and drop", async ({ page, request }) => {
  const runId = String(Date.now());
  const older = `E2E Older ${runId}`;
  const newer = `E2E Newer ${runId}`;
  const projectHeadings = page.getByRole("heading", { level: 3, name: new RegExp(`E2E (Older|Newer) ${runId}`) });

  try {
    await page.goto("/projects");
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

    await createProject(page, older);
    await createProject(page, newer);
    await expect(projectHeadings).toHaveText([newer, older]);

    // Adding tasks to the older project makes it the most recently worked on
    const nav = page.getByRole("navigation", { name: "Primary" });
    await nav.getByRole("link", { name: "Tasks" }).click();
    await createTask(page, older, `First ${runId}`);
    await createTask(page, older, `Second ${runId}`);
    await nav.getByRole("link", { name: "Projects" }).click();
    await expect(projectHeadings).toHaveText([older, newer]);

    // Drag the second card above the first; the order is stored, so it survives a reload
    await nav.getByRole("link", { name: "Tasks" }).click();
    const todo = page.getByTestId("column-todo");
    const titles = todo.getByRole("heading", { level: 4 }).filter({ hasText: runId });
    await expect(titles).toHaveText([`First ${runId}`, `Second ${runId}`]);
    const first = todo.locator("[data-task-id]").filter({ hasText: `First ${runId}` });
    const second = todo.locator("[data-task-id]").filter({ hasText: `Second ${runId}` });
    await second.dragTo(first, { targetPosition: { x: 20, y: 5 } });
    await expect(titles).toHaveText([`Second ${runId}`, `First ${runId}`]);
    await page.reload();
    await expect(titles).toHaveText([`Second ${runId}`, `First ${runId}`]);

    // The keyboard moves it back down
    await page.getByRole("button", { name: `Reorder Second ${runId}` }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(titles).toHaveText([`First ${runId}`, `Second ${runId}`]);
    await expect(page.getByRole("button", { name: `Reorder Second ${runId}` })).toBeFocused();
  } finally {
    const res = await request.get("/api/projects", { headers: { Authorization: AUTH_HEADER } });
    const projects = (await res.json()) as { id: string; name: string }[];
    for (const project of projects.filter((p) => p.name === older || p.name === newer)) {
      await request.delete(`/api/projects/${project.id}`, { headers: { Authorization: AUTH_HEADER } });
    }
  }
});
