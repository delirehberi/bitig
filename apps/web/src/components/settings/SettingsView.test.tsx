import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "./SettingsView";
import { CREATED_TOKEN, TOKEN_METADATA } from "../../test/mcp-token-fixtures";

describe("Settings tabs", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.includes("/api/t3/connection")) return Promise.resolve(Response.json({ connected: false }));
      if (url.includes("/api/mcp-tokens") && init?.method === "POST") return Promise.resolve(Response.json(CREATED_TOKEN));
      return Promise.resolve(Response.json([]));
    }));
  });

  it("preserves the T3 tab and supports keyboard tab navigation", async () => {
    render(<SettingsView mode="cloudflare" projects={[]} />);
    const user = userEvent.setup();
    const t3Tab = screen.getByRole("tab", { name: "T3 Code" });
    expect(t3Tab).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("T3 Code Host")).toBeInTheDocument();
    t3Tab.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "MCP Tokens" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "settings-tab-mcp");
    await user.keyboard("{Home}");
    expect(t3Tab).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "MCP Tokens" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(t3Tab).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Notifications" })).toHaveFocus();
    expect(screen.getByRole("tabpanel")).toHaveAttribute("aria-labelledby", "settings-tab-notifications");
  });

  it("clears the one-time secret when leaving the MCP tab", async () => {
    render(<SettingsView mode="cloudflare" projects={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "MCP Tokens" }));
    await screen.findByText(/No generated tokens yet/);
    await user.type(screen.getByRole("textbox", { name: "Client name" }), TOKEN_METADATA.label);
    await user.click(screen.getByRole("button", { name: "Generate token" }));
    expect(await screen.findByLabelText(`New token for ${TOKEN_METADATA.label}`)).toHaveValue(CREATED_TOKEN.token);
    await user.click(screen.getByRole("tab", { name: "T3 Code" }));
    await user.click(screen.getByRole("tab", { name: "MCP Tokens" }));
    await screen.findByText(/No generated tokens yet/);
    expect(screen.queryByText("Save your token now")).not.toBeInTheDocument();
  });

  it("preserves OAuth callback messaging on the default T3 tab", async () => {
    window.history.replaceState(null, "", "/settings?t3=connected");
    render(<SettingsView mode="cloudflare" projects={[]} />);
    expect(await screen.findByText("Connected to T3 Code host.")).toBeInTheDocument();
    await waitFor(() => { expect(screen.getByRole("tab", { name: "T3 Code" })).toHaveAttribute("aria-selected", "true"); });
  });

  it("explains unsupported local storage without requesting token data", async () => {
    render(<SettingsView mode="local" projects={[]} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "MCP Tokens" }));
    expect(screen.getByRole("note")).toHaveTextContent(/requires the Cloudflare Worker storage mode/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
