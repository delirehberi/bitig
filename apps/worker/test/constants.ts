/** Origin allowlisted for CORS in the test runtime (see vitest.config.ts). */
export const TEST_ALLOWED_ORIGIN = "https://allowed.bitig.test";

export const TEST_AUTH_USER = "admin";
export const TEST_AUTH_PASS = "secret123";
export const TEST_AUTH_HEADER = `Basic ${btoa(`${TEST_AUTH_USER}:${TEST_AUTH_PASS}`)}`;

export const TEST_MCP_TOKEN = "test-mcp-bearer-token-secret";
export const TEST_MCP_AUTH_HEADER = `Bearer ${TEST_MCP_TOKEN}`;
