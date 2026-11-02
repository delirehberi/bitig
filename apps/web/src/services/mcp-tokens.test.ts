import { describe, expect, it, vi } from "vitest";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "./mcp-tokens";
import { CREATED_TOKEN, TOKEN_METADATA } from "../test/mcp-token-fixtures";

const INPUT = { label: TOKEN_METADATA.label, transport: TOKEN_METADATA.transport, expiresAt: null };

describe("MCP token service", () => {
  it("validates metadata and opts out of browser caching", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json([TOKEN_METADATA]));
    vi.stubGlobal("fetch", fetcher);
    expect(await listMcpTokens(new AbortController().signal)).toEqual([TOKEN_METADATA]);
    expect(fetcher).toHaveBeenCalledWith("/api/mcp-tokens", expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" }));
  });

  it("creates and revokes through the protected API", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json(CREATED_TOKEN))
      .mockResolvedValueOnce(Response.json({ ...TOKEN_METADATA, revokedAt: TOKEN_METADATA.createdAt }));
    vi.stubGlobal("fetch", fetcher);
    expect(await createMcpToken(INPUT, new AbortController().signal)).toEqual(CREATED_TOKEN);
    expect(fetcher).toHaveBeenNthCalledWith(1, "/api/mcp-tokens", expect.objectContaining({ method: "POST", body: JSON.stringify(INPUT) }));
    expect((await revokeMcpToken(TOKEN_METADATA.id, new AbortController().signal)).revokedAt).not.toBeNull();
    expect(fetcher).toHaveBeenNthCalledWith(2, `/api/mcp-tokens/${TOKEN_METADATA.id}`, expect.objectContaining({ method: "DELETE" }));
  });

  it.each([400, 401, 403, 409, 500, 503])("handles HTTP %s without exposing server error details", async (status) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: CREATED_TOKEN.token }, { status })));
    await expect(listMcpTokens(new AbortController().signal)).rejects.toThrow(/reload the list/);
    await expect(listMcpTokens(new AbortController().signal)).rejects.not.toThrow(CREATED_TOKEN.token);
  });

  it("sanitizes malformed responses without exposing one-time secrets", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...CREATED_TOKEN, credential: {} })));
    await expect(createMcpToken(INPUT, new AbortController().signal)).rejects.toThrow(/invalid token response/);
  });

  it("reports network failure with lost-creation recovery guidance", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
    await expect(createMcpToken(INPUT, new AbortController().signal)).rejects.toThrow(/revoke any token whose secret you did not receive/);
  });

  it("forwards cancellation without replacing the abort error", async () => {
    const controller = new AbortController();
    controller.abort();
    const reason = new DOMException("Cancelled", "AbortError");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(reason);
    vi.stubGlobal("fetch", fetcher);
    await expect(listMcpTokens(controller.signal)).rejects.toBe(reason);
    const options = fetcher.mock.calls[0]?.[1];
    expect(options?.signal?.aborted).toBe(true);
  });
});
