/**
 * Ticket codes in a real browser against `make dev`: a project created with a key shows it on its
 * card, and its tasks show BIT-1-style codes on the board, in the list and in the detail dialog.
 * Credentials come from the environment (`make e2e` loads them from apps/worker/.dev.vars). The
 * local database persists between runs, so the key is unique per run and the project is deleted.
 */
import { expect, test } from "@playwright/test";

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

test("shows project keys and task codes", async ({ page, request }) => {
  const runId = String(Date.now());
  const projectName = `E2E Codes ${runId}`;
  const key = `E${runId.slice(-6)}`;

  try {
    await page.goto("/projects");
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Projects" })).toBeVisible();

    // The key field suggests the derived key and uppercases what is typed
    await page.getByRole("button", { name: /new project/i }).click();
    const projectDialog = page.getByRole("dialog");
    await projectDialog.getByLabel(/project name/i).fill(projectName);
    await expect(projectDialog.getByLabel("Key")).toHaveAttribute("placeholder", "E2E");
    await projectDialog.getByLabel("Key").fill(key.toLowerCase());
    await expect(projectDialog.getByLabel("Key")).toHaveValue(key);
    await projectDialog.getByRole("button", { name: "Create Project" }).click();
    await expect(page.getByTitle("Key for ticket codes").filter({ hasText: key })).toBeVisible();

    // Two tasks number 1 and 2
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Tasks" }).click();
    for (const title of ["First", "Second"]) {
      await page.getByRole("button", { name: /new task/i }).click();
      const taskDialog = page.getByRole("dialog");
      await taskDialog.getByLabel(/project/i).selectOption({ label: projectName });
      await taskDialog.getByLabel(/title/i).fill(`${title} ${runId}`);
      await taskDialog.getByRole("button", { name: "Create Task" }).click();
      await expect(taskDialog).toBeHidden();
    }
    await expect(page.getByText(`${key}-1`, { exact: true })).toBeVisible();
    await expect(page.getByText(`${key}-2`, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "List view" }).click();
    await expect(page.getByRole("row").filter({ hasText: `Second ${runId}` })).toContainText(`${key}-2`);

    await page.getByRole("button", { name: `Second ${runId}`, exact: true }).click();
    await expect(page.getByRole("dialog").getByTitle("Ticket code")).toHaveText(`${key}-2`);
    await page.keyboard.press("Escape");
  } finally {
    const res = await request.get("/api/projects", { headers: { Authorization: AUTH_HEADER } });
    const projects = (await res.json()) as { id: string; name: string }[];
    const project = projects.find((p) => p.name === projectName);
    if (project) {
      await request.delete(`/api/projects/${project.id}`, { headers: { Authorization: AUTH_HEADER } });
    }
  }
});
