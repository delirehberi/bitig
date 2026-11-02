import { expect, test } from "@playwright/test";

test.use({ trace: "off", video: "off", screenshot: "off" });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set; run this test with make e2e`);
  }
  return value;
}

test("generates a one-time client token and revokes it from Settings", async ({ page, request }) => {
  const username = requireEnv("BASIC_AUTH_USER");
  const password = requireEnv("BASIC_AUTH_PASS");
  const label = `E2E MCP ${crypto.randomUUID()}`;
  const headers = { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  const login = await page.request.post("/api/auth/login", { data: { username, password } });
  expect(login.ok()).toBe(true);

  try {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "MCP Tokens" }).click();
    await expect(page.getByRole("button", { name: "Reload tokens" })).toBeEnabled();
    await page.getByLabel("Client name", { exact: true }).fill(label);
    await page.getByRole("button", { name: "Generate token" }).click();
    const secret = page.getByLabel(`New token for ${label}`, { exact: true });
    await expect(secret).toBeVisible();
    const token = await secret.inputValue();
    expect(/^bitig_mcp_[0-9a-f]{64}$/.test(token)).toBe(true);
    const listing = await request.get("/api/mcp-tokens", { headers });
    expect(listing.ok()).toBe(true);
    expect((await listing.text()).includes(token)).toBe(false);

    await page.getByRole("tab", { name: "T3 Code" }).click();
    await page.getByRole("tab", { name: "MCP Tokens" }).click();
    await expect(page.getByRole("heading", { name: "Save your token now" })).toBeHidden();
    await page.getByRole("button", { name: `Revoke ${label}`, exact: true }).click();
    await expect(page.getByRole("group", { name: `Confirm revoke ${label}`, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Confirm revoke", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText(`Revoked token for ${label}. Other clients are unchanged.`);
    await expect(page.getByRole("button", { name: `Revoke ${label}`, exact: true })).toBeHidden();
  } finally {
    const response = await request.get("/api/mcp-tokens", { headers });
    expect(response.ok()).toBe(true);
    const credentials = await response.json() as { id: string; label: string; revokedAt: string | null }[];
    for (const credential of credentials.filter((item) => item.label === label && item.revokedAt === null)) {
      const revoked = await request.delete(`/api/mcp-tokens/${credential.id}`, { headers });
      expect(revoked.ok()).toBe(true);
    }
  }
});
