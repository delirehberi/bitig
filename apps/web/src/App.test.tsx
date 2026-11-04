import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { MODE_COPY } from "./domain/modes";

function urlOf(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof Request ? input.url : input.href;
}

function stubFetch(impl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(impl));
}

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app");
  });

  it("shows the worker as online with its version", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = urlOf(input);
        if (url.includes("/health")) {
          return Promise.resolve(Response.json({ status: "ok", version: "0.4.1", storageMode: "cloudflare" }));
        }
        if (url.includes("/api/auth/session")) return Promise.resolve(Response.json({ user: "admin" }));
        if (url.includes("/api/t3/runs")) return Promise.resolve(Response.json({ runs: [], activeSessions: [] }));
        // Projects, tasks and webhooks are lists.
        return Promise.resolve(Response.json([]));
      }),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();
    expect(await screen.findByText("Worker online · v0.4.1 · Cloudflare storage")).toBeInTheDocument();
    expect(screen.getAllByText("v0.4.1").length).toBeGreaterThan(0);
  });

  it("shows the worker as unreachable when the request fails", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    render(<App />);

    expect(
      await screen.findByText("Worker unreachable · worker did not respond · Cloudflare storage"),
    ).toBeInTheDocument();
  });

  it("falls back to the default storage mode when the worker is unreachable", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));

    render(<App />);

    expect(await screen.findByText(new RegExp(`${MODE_COPY.cloudflare.label} storage$`))).toBeInTheDocument();
  });

  it("shows a loading state until the worker reports its storage mode", () => {
    stubFetch(() => new Promise<Response>(() => undefined));

    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Loading workspace");
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
  });

  it("uses the D1 storage mode the worker reports, with no switcher", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => Promise.resolve(
        urlOf(input).includes("/api/auth/session")
          ? Response.json({ error: "unauthorized" }, { status: 401 })
          : Response.json({ status: "ok", version: "0.4.1", storageMode: "cloudflare" }),
      )),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sign in with nostr/i })).toBeInTheDocument();
  });

  it("asks for sign-in on its own page in cloudflare mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) =>
        Promise.resolve(
          urlOf(input).includes("/api/auth/session")
            ? Response.json({ error: "unauthorized" }, { status: 401 })
            : Response.json({ status: "ok", version: "0.4.1", storageMode: "cloudflare" }),
        ),
      ),
    );

    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

});
