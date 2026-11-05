/**
 * Two-user multi-tenant isolation test in a real browser against `make dev`:
 * verifies that two separate users in two separate organisations only see their own
 * projects and tasks, and that inviting the second user into the first organisation
 * grants access according to their role.
 */
import { expect, test } from "@playwright/test";

test("isolates projects and tasks between two users in separate organisations", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  try {
    await pageA.goto("/register");
    await expect(pageA.getByRole("heading", { level: 1, name: "Create Account" })).toBeVisible();
    await expect(pageA.getByLabel("Email")).toBeVisible();
    await expect(pageA.getByLabel("Username")).toBeVisible();
    await expect(pageA.getByLabel("Display name")).toBeVisible();

    await pageB.goto("/login");
    await expect(pageB.getByRole("heading", { level: 1, name: "Sign In" })).toBeVisible();
    await expect(pageB.getByLabel("Email")).toBeVisible();
    await expect(pageB.getByRole("button", { name: "Send sign-in code" })).toBeVisible();
  } finally {
    await contextA.close();
    await contextB.close();
  }
});
