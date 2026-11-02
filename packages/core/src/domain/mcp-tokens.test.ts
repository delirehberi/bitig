import { describe, expect, it } from "vitest";
import { CreateMcpTokenSchema, MCP_TOKEN_LABEL_MAX_LENGTH } from "./mcp-tokens";

describe("MCP credential input", () => {
  it("normalizes labels and supports both transports", () => {
    for (const transport of ["bearer", "query"]) {
      expect(CreateMcpTokenSchema.parse({ label: " Client ", transport, expiresAt: null }))
        .toEqual({ label: "Client", transport, expiresAt: null });
    }
  });

  it.each([
    { label: " ", transport: "bearer", expiresAt: null },
    { label: "x".repeat(MCP_TOKEN_LABEL_MAX_LENGTH + 1), transport: "bearer", expiresAt: null },
    { label: "Client", transport: "invalid", expiresAt: null },
    { label: "Client", transport: "bearer", expiresAt: "invalid" },
    { label: "Client", transport: "bearer", expiresAt: null, token: "not-allowed" },
  ])("rejects invalid input %j", (input) => {
    expect(CreateMcpTokenSchema.safeParse(input).success).toBe(false);
  });
});
