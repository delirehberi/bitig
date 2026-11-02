import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreatedMcpToken, McpTokenMetadata } from "@bitig/core";
import { McpTokensPanel } from "./McpTokensPanel";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "../../services/mcp-tokens";
import { CREATED_TOKEN, TOKEN_METADATA } from "../../test/mcp-token-fixtures";

vi.mock("../../services/mcp-tokens", () => ({
  createMcpToken: vi.fn(), listMcpTokens: vi.fn(), revokeMcpToken: vi.fn(),
}));

function deferred<Value>() {
  let complete: (value: Value) => void = () => { throw new Error("Promise is not initialized"); };
  const promise = new Promise<Value>((resolve) => { complete = resolve; });
  return { promise, resolve: (value: Value) => { complete(value); } };
}

async function generate() {
  const user = userEvent.setup();
  await screen.findByText(/No generated tokens yet/);
  await user.type(screen.getByRole("textbox", { name: "Client name" }), TOKEN_METADATA.label);
  await user.click(screen.getByRole("button", { name: "Generate token" }));
  return user;
}

describe("MCP tokens panel", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(listMcpTokens).mockResolvedValue([]);
    vi.mocked(createMcpToken).mockResolvedValue(CREATED_TOKEN);
    vi.mocked(revokeMcpToken).mockResolvedValue({ ...TOKEN_METADATA, revokedAt: TOKEN_METADATA.createdAt });
  });

  it("loads metadata and explains that existing tokens are untouched", async () => {
    render(<McpTokensPanel />);
    await screen.findByText(/No generated tokens yet/);
    expect(screen.getByText(/Existing environment tokens remain unchanged/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate token" })).toBeDisabled();
  });

  it("reveals once, copies, dismisses, and never stores the secret in browser storage", async () => {
    const persistentStorage = { setItem: vi.fn() };
    const tabStorage = { setItem: vi.fn() };
    vi.stubGlobal("localStorage", persistentStorage);
    vi.stubGlobal("sessionStorage", tabStorage);
    render(<McpTokensPanel />);
    const user = await generate();
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    const field = await screen.findByLabelText(`New token for ${TOKEN_METADATA.label}`);
    expect(field).toHaveValue(CREATED_TOKEN.token);
    expect(screen.getByRole("button", { name: "Generate token" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(copy).toHaveBeenCalledWith(CREATED_TOKEN.token);
    await user.click(screen.getByRole("button", { name: "I saved it — dismiss" }));
    expect(screen.queryByText("Save your token now")).not.toBeInTheDocument();
    expect(persistentStorage.setItem).not.toHaveBeenCalled();
    expect(tabStorage.setItem).not.toHaveBeenCalled();
  });

  it("reports clipboard failures and keeps the secret available for manual copy", async () => {
    render(<McpTokensPanel />);
    const user = await generate();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/copy it manually/);
    expect(screen.getByLabelText(`New token for ${TOKEN_METADATA.label}`)).toHaveValue(CREATED_TOKEN.token);
  });

  it("warns about URL tokens and passes the selected transport", async () => {
    render(<McpTokensPanel />);
    const user = userEvent.setup();
    await screen.findByText(/No generated tokens yet/);
    await user.selectOptions(screen.getByLabelText("Authentication"), "query");
    expect(screen.getByText(/URL tokens can appear in client history/)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Client name" }), TOKEN_METADATA.label);
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    expect(createMcpToken).toHaveBeenCalledWith(expect.objectContaining({ transport: "query", expiresAt: null }), expect.any(AbortSignal));
  });

  it("rejects past expiry and converts a future local time to ISO", async () => {
    render(<McpTokensPanel />);
    const user = userEvent.setup();
    await screen.findByText(/No generated tokens yet/);
    await user.type(screen.getByRole("textbox", { name: "Client name" }), TOKEN_METADATA.label);
    const expiry = screen.getByLabelText("Expires at (optional, local time)");
    await user.type(expiry, "2020-01-01T12:00");
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/future/);
    expect(createMcpToken).not.toHaveBeenCalled();
    await user.clear(expiry);
    await user.type(expiry, "2099-01-01T12:00");
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    expect(createMcpToken).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: new Date("2099-01-01T12:00").toISOString() }), expect.any(AbortSignal));
  });

  it("requires confirmation, supports cancel, and revokes only the selected client", async () => {
    const other = { ...TOKEN_METADATA, id: "01940000-0000-7000-8000-000000000002", label: "Other client" };
    vi.mocked(listMcpTokens).mockResolvedValue([TOKEN_METADATA, other]);
    render(<McpTokensPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `Revoke ${TOKEN_METADATA.label}` }));
    expect(revokeMcpToken).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Confirm revoke" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: `Revoke ${TOKEN_METADATA.label}` }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    await waitFor(() => { expect(revokeMcpToken).toHaveBeenCalledTimes(1); });
    expect(revokeMcpToken).toHaveBeenCalledWith(TOKEN_METADATA.id, expect.any(AbortSignal));
    expect(await screen.findByText("Revoked")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Revoke Other client" })).toBeEnabled();
  });

  it("recovers a failed list on reload and shows expired metadata", async () => {
    vi.mocked(listMcpTokens).mockRejectedValueOnce(new Error("Storage unavailable"))
      .mockResolvedValueOnce([{ ...TOKEN_METADATA, expiresAt: "2020-01-01T00:00:00.000Z" }]);
    render(<McpTokensPanel />);
    const user = userEvent.setup();
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
    await user.click(screen.getByRole("button", { name: "Reload tokens" }));
    expect(await screen.findByText("Expired")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows mutation errors and does not automatically retry creation", async () => {
    vi.mocked(createMcpToken).mockRejectedValue(new Error("Reload the list before retrying."));
    render(<McpTokensPanel />);
    const user = await generate();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Reload the list/);
    expect(createMcpToken).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Generate token" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Reload tokens" }));
    await waitFor(() => { expect(screen.getByRole("button", { name: "Generate token" })).toBeEnabled(); });
  });

  it("shows failed revocation without falsely marking the credential revoked", async () => {
    vi.mocked(listMcpTokens).mockResolvedValue([TOKEN_METADATA]);
    vi.mocked(revokeMcpToken).mockRejectedValue(new Error("Could not revoke"));
    render(<McpTokensPanel />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: `Revoke ${TOKEN_METADATA.label}` }));
    await user.click(screen.getByRole("button", { name: "Confirm revoke" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not revoke");
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("aborts list loading when unmounted", () => {
    const pending = deferred<McpTokenMetadata[]>();
    vi.mocked(listMcpTokens).mockReturnValue(pending.promise);
    const view = render(<McpTokensPanel />);
    const signal = vi.mocked(listMcpTokens).mock.calls[0]?.[0];
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("prevents duplicate creation and aborts a pending mutation on unmount", async () => {
    const pending = deferred<CreatedMcpToken>();
    vi.mocked(createMcpToken).mockReturnValue(pending.promise);
    const view = render(<McpTokensPanel />);
    const user = await generate();
    const button = screen.getByRole("button", { name: "Working…" });
    await user.click(button);
    expect(createMcpToken).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(createMcpToken).mock.calls[0]?.[1];
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(CREATED_TOKEN); await pending.promise; });
    expect(within(document.body).queryByText("Save your token now")).not.toBeInTheDocument();
  });
});
