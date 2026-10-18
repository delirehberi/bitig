import { defineConfig, devices } from "@playwright/test";

// The Vite dev server; it proxies /api and /health to `wrangler dev` (see vite.config.ts).
const DASHBOARD_URL = "http://localhost:5173";
// `make dev` applies local D1 migrations and starts both servers; the first run downloads workerd.
const DEV_SERVER_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 60_000;

/** Browser lifecycle tests against the real Worker. Run with `make e2e`, not part of `make check`. */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  timeout: TEST_TIMEOUT_MS,
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: DASHBOARD_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "make dev",
    cwd: "../..",
    url: `${DASHBOARD_URL}/health`,
    // A dev stack you already started is reused instead of failing on the taken ports.
    reuseExistingServer: true,
    timeout: DEV_SERVER_TIMEOUT_MS,
    stdout: "ignore",
    stderr: "pipe",
  },
});
