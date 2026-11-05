import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import {
  TEST_ALLOWED_ORIGIN,
  TEST_BOOTSTRAP_EMAIL,
  TEST_MCP_TOKEN,
  TEST_MCP_URL_TOKEN,
  TEST_NOSTR_PUBKEY,
  TEST_SESSION_SECRET,
  TEST_T3_ENCRYPTION_KEY,
} from "./test/constants.ts";

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
          BOOTSTRAP_ADMIN_EMAIL: TEST_BOOTSTRAP_EMAIL,
          MCP_AUTH_TOKEN: TEST_MCP_TOKEN,
          MCP_URL_TOKEN: TEST_MCP_URL_TOKEN,
          SESSION_SECRET: TEST_SESSION_SECRET,
          T3_ENCRYPTION_KEY: TEST_T3_ENCRYPTION_KEY,
          NOSTR_AUTH_PUBKEYS: TEST_NOSTR_PUBKEY,
        },
      },
    }),
  ],
});
