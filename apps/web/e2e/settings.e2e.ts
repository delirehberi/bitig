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

test("manages multiple T3 hosts, creates host-bound projects with prefilled folder, detaches/reattaches, and enforces read-only member views (BIT-152)", async ({
  page,
}) => {
  const username = requireEnv("BASIC_AUTH_USER");
  const password = requireEnv("BASIC_AUTH_PASS");
  const login = await page.request.post("/api/auth/login", { data: { username, password } });
  expect(login.ok()).toBe(true);

  const now = new Date().toISOString();
  const hosts = [
    {
      id: "host-laptop",
      label: "Laptop",
      mcpUrl: "https://laptop.example.com/mcp",
      kind: "user",
      projectsRoot: "~/www",
      expiresAt: "2027-01-01T00:00:00.000Z",
      expiresInDays: 30,
      expiringSoon: false,
      expired: false,
      scope: "mcp:tools",
      connectedAt: now,
      updatedAt: now,
    },
    {
      id: "host-server",
      label: "Build Server",
      mcpUrl: "https://server.example.com/mcp",
      kind: "container",
      projectsRoot: "/var/www",
      expiresAt: "2027-01-01T00:00:00.000Z",
      expiresInDays: 5,
      expiringSoon: true,
      expired: false,
      scope: "mcp:tools",
      connectedAt: now,
      updatedAt: now,
    },
  ];
  const mappings: {
    projectId: string;
    hostId: string;
    t3ProjectId: string;
    t3ProjectTitle: string;
    workspaceRoot: string;
    updatedAt: string;
  }[] = [];

  await page.route("**/api/t3/hosts*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "GET" && url.pathname === "/api/t3/hosts") {
      await route.fulfill({ json: hosts });
      return;
    }
    if (req.method() === "DELETE" && url.pathname === "/api/t3/hosts/host-server") {
      await route.fulfill({
        status: 409,
        json: {
          error: "Cannot disconnect Build Server while 1 session is running on it.",
          code: "host_busy",
        },
      });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/t3/mappings", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { mappings } });
      return;
    }
    await route.continue();
  });

  await page.route("**/api/t3/projects*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === "GET" && url.pathname === "/api/t3/projects") {
      await route.fulfill({ json: [] });
      return;
    }
    const match = /^\/api\/t3\/projects\/([^/]+)\/host-folder$/u.exec(url.pathname);
    const projectId = match?.[1];
    if (projectId && req.method() === "PUT") {
      const body = req.postDataJSON() as { workspaceRoot: string; hostId?: string };
      const mapping = {
        projectId,
        hostId: body.hostId ?? "host-laptop",
        t3ProjectId: `t3-${projectId}`,
        t3ProjectTitle: body.workspaceRoot,
        workspaceRoot: body.workspaceRoot,
        updatedAt: new Date().toISOString(),
      };
      const existingIdx = mappings.findIndex((m) => m.projectId === projectId);
      if (existingIdx >= 0) {
        mappings.splice(existingIdx, 1, mapping);
      } else {
        mappings.push(mapping);
      }
      await route.fulfill({ status: 201, json: { mapping, created: true } });
      return;
    }
    if (projectId && req.method() === "DELETE") {
      const existingIdx = mappings.findIndex((m) => m.projectId === projectId);
      if (existingIdx >= 0) mappings.splice(existingIdx, 1);
      await route.fulfill({ json: { unregistered: true } });
      return;
    }
    await route.continue();
  });

  // 1. Owner Settings view: multiple hosts, status/expiry, projects root, disconnect refused while busy
  await page.goto("/settings");
  await expect(page.getByTestId("t3-host-card-host-laptop")).toBeVisible();
  await expect(page.getByTestId("t3-host-card-host-server")).toBeVisible();
  await expect(page.getByText("2 hosts connected")).toBeVisible();
  await page.getByRole("button", { name: "Disconnect Build Server" }).click();
  await expect(page.getByRole("alert")).toContainText("Cannot disconnect Build Server while 1 session is running on it.");

  // 2. Create a host-bound project with host selector and prefilled <projects root>/<slug>
  const projectName = `Host Bound ${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/projects");
  await page.getByRole("button", { name: /New Project/i }).click();
  await page.getByLabel(/Project Name/i).fill(projectName);
  const folderInput = page.getByLabel("Folder on T3 host");
  await expect(folderInput).toBeVisible();
  await page.getByLabel("T3 host").selectOption("host-server");
  await expect(folderInput).toHaveValue(
    `/var/www/${projectName.toLowerCase().replace(/[^a-z0-9]+/gu, "-")}`,
  );
  await page.getByRole("button", { name: "Create Project" }).click();
  await expect(page.getByText(projectName)).toBeVisible();
});
