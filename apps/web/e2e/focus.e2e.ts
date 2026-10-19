/**
 * Keyboard focus in the task detail dialog, in a real browser against `make dev`: focus moves into the
 * dialog on open, Tab stays inside it, and focus returns to the task title after Esc, the X button, the
 * backdrop, and the Edit and Delete hand-offs, in both board and list views. Credentials come from the
 * environment (`make e2e` loads them from apps/worker/.dev.vars); the project is deleted afterwards.
 */
import { expect, test, type Locator } from "@playwright/test";

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
const TAB_PRESSES = 12;

async function expectFocusInside(dialog: Locator) {
  await expect(dialog.locator(":focus")).toHaveCount(1);
}

test("keeps focus inside the task detail dialog and returns it on close", async ({ page, request }) => {
  const runId = String(Date.now());
  const projectName = `E2E Focus ${runId}`;
  const taskTitle = `E2E Focus Task ${runId}`;
  let projectId: string | undefined;

  try {
    const projectRes = await request.post("/api/projects", {
      headers: { Authorization: AUTH_HEADER },
      data: { name: projectName, kind: "hobby" },
    });
    expect(projectRes.ok()).toBe(true);
    projectId = ((await projectRes.json()) as { id: string }).id;
    const taskRes = await request.post("/api/tasks", {
      headers: { Authorization: AUTH_HEADER },
      data: { projectId, title: taskTitle, description: "Focus check" },
    });
    expect(taskRes.ok()).toBe(true);

    await page.goto(`/tasks?project=${projectId}`);
    await expect(page).toHaveURL(/\/login/);
    await page.getByLabel(/username/i).fill(USERNAME);
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /^sign in$/i }).click();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

    for (const view of ["Board view", "List view"]) {
      await page.getByRole("button", { name: view }).click();
      const title = page.getByRole("button", { name: taskTitle, exact: true });
      const dialog = page.getByRole("dialog");

      const closers: [string, () => Promise<void>][] = [
        ["Escape", () => page.keyboard.press("Escape")],
        ["X", () => dialog.getByRole("button", { name: "Close dialog" }).click()],
        ["backdrop", () => dialog.click({ position: { x: 5, y: 5 } })],
      ];
      for (const [how, close] of closers) {
        await title.click();
        await expect(dialog).toBeVisible();
        await expectFocusInside(dialog);
        for (let i = 0; i < TAB_PRESSES; i++) {
          await page.keyboard.press(i % 3 === 2 ? "Shift+Tab" : "Tab");
          await expectFocusInside(dialog);
        }
        await close();
        await expect(dialog, `closed with ${how} in ${view}`).toBeHidden();
        await expect(title, `focus back after ${how} in ${view}`).toBeFocused();
      }

      // Edit hands off to the task form; closing it returns to the title
      await title.click();
      await dialog.getByRole("button", { name: "Edit" }).click();
      const form = page.getByRole("dialog", { name: "Edit Task" });
      await expect(form).toBeVisible();
      await expectFocusInside(form);
      await form.getByRole("button", { name: "Close dialog" }).click();
      await expect(title).toBeFocused();

      // Delete hands off to the confirmation; cancelling returns to the title
      await title.click();
      await dialog.getByRole("button", { name: "Delete" }).click();
      const confirm = page.getByRole("dialog", { name: "Delete Task" });
      await expect(confirm).toBeVisible();
      await expectFocusInside(confirm);
      await confirm.getByRole("button", { name: "Cancel" }).click();
      await expect(title).toBeFocused();
    }

    // Complete removes its own button; Tab still lands inside the dialog
    await page.getByRole("button", { name: taskTitle, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Complete" }).click();
    await expect(dialog.getByRole("button", { name: "Complete" })).toBeHidden();
    await page.keyboard.press("Tab");
    await expectFocusInside(dialog);
    await page.keyboard.press("Escape");
  } finally {
    if (projectId) {
      await request.delete(`/api/projects/${projectId}`, { headers: { Authorization: AUTH_HEADER } });
    }
  }
});
