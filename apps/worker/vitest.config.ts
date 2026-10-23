import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { TEST_ALLOWED_ORIGIN, TEST_AUTH_PASS, TEST_AUTH_USER, TEST_MCP_TOKEN, TEST_MCP_URL_TOKEN, TEST_SESSION_SECRET } from "./test/constants.ts";

// The Workers runtime cold-starts per test file; with several files starting in
// parallel, a file's first request can wait well past Vitest's 5s default.
const WORKER_TEST_TIMEOUT_MS = 15_000;

export default defineConfig({
  test: {
    testTimeout: WORKER_TEST_TIMEOUT_MS,
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ALLOWED_ORIGINS: TEST_ALLOWED_ORIGIN,
          BASIC_AUTH_USER: TEST_AUTH_USER,
          BASIC_AUTH_PASS: TEST_AUTH_PASS,
          MCP_AUTH_TOKEN: TEST_MCP_TOKEN,
          MCP_URL_TOKEN: TEST_MCP_URL_TOKEN,
          SESSION_SECRET: TEST_SESSION_SECRET,
        },
      },
    }),
  ],
});
