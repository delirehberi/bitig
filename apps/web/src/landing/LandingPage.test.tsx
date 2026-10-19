import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";

describe("Landing page", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(Response.json({ status: "ok", version: "0.4.1", storageMode: "nostr" })),
      ),
    );
  });

  it("is served at / without calling the Worker", () => {
    render(<App />);

    expect(
      screen.getByRole("heading", { level: 1, name: "One task list for every AI you work with." }),
    ).toBeInTheDocument();
    expect(screen.getByText("AI-first task manager")).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("covers the managed, self-hosted and free-tier messages", () => {
    render(<App />);

    expect(screen.getByRole("heading", { level: 2, name: "Run it our way, or yours." })).toBeInTheDocument();
    expect(screen.getByText("“I built it for myself, and it can be yours.”")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start free: 100 MCP requests" })).toHaveAttribute("href", "/app");

    const pricing = screen.getByRole("region", { name: "Free to start. Free forever to self-host." });
    expect(within(pricing).getByText("100 MCP requests a month")).toBeInTheDocument();
    expect(within(pricing).getByText("Unlimited MCP requests")).toBeInTheDocument();
  });

  it("opens the dashboard from the sign-in link without a reload", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("link", { name: "Sign in" }));

    expect(window.location.pathname).toBe("/app");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();
  });
});
