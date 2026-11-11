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

describe("T3 multi-host settings and owner vs member views (BIT-152)", () => {
  const TIMESTAMP = "2026-11-10T10:00:00.000Z";
  const PROJECT_WEB = {
    id: "01940000-0000-7000-8000-000000000001",
    name: "Bitig Web",
    description: "",
    kind: "hobby" as const,
    key: "WEB",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const PROJECT_API = {
    id: "01940000-0000-7000-8000-000000000002",
    name: "Worker API",
    description: "",
    kind: "hobby" as const,
    key: "API",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const PROJECTS = [PROJECT_WEB, PROJECT_API];

  const HOST_LAPTOP = {
    id: "host-laptop",
    label: "Laptop",
    mcpUrl: "https://laptop.example.com/mcp",
    kind: "user" as const,
    projectsRoot: "~/www",
    expiresAt: "2026-12-01T00:00:00.000Z",
    expiresInDays: 20,
    expiringSoon: false,
    expired: false,
    scope: "mcp:tools",
    connectedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const HOST_SERVER = {
    id: "host-server",
    label: "Build Server",
    mcpUrl: "https://server.example.com/mcp",
    kind: "container" as const,
    projectsRoot: "/var/www",
    expiresAt: "2026-11-12T00:00:00.000Z",
    expiresInDays: 2,
    expiringSoon: true,
    expired: false,
    scope: "mcp:tools",
    connectedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
  const HOSTS = [HOST_LAPTOP, HOST_SERVER];

  const MAPPINGS = [
    {
      projectId: PROJECT_WEB.id,
      hostId: "host-laptop",
      t3ProjectId: "t3-web",
      t3ProjectTitle: "Bitig Web",
      workspaceRoot: "~/www/bitig-web",
      updatedAt: TIMESTAMP,
    },
  ];

  function requestUrl(input: RequestInfo | URL): string {
    return input instanceof Request ? input.url : input.toString();
  }

  function parseJsonBody(body: BodyInit | null | undefined): Record<string, unknown> {
    return typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {};
  }

  beforeEach(() => {
    window.history.replaceState(null, "", "/settings");
  });

  it("shows empty state when no hosts are connected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = requestUrl(input);
        if (url.includes("/api/t3/hosts")) return Promise.resolve(Response.json([]));
        if (url.includes("/api/t3/connection")) return Promise.resolve(Response.json({ connected: false }));
        if (url.includes("/api/t3/mappings")) return Promise.resolve(Response.json([]));
        return Promise.resolve(Response.json([]));
      }),
    );

    render(<SettingsView mode="cloudflare" projects={PROJECTS} role="owner" />);
    expect(await screen.findByText(/No T3 Code hosts connected yet/u)).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
  });

  it("renders owner multi-host list with status, expiry, projectsRoot, edit, reauthorise, and disconnect", async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { search: "", assign: assignSpy },
    });

    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/api/t3/hosts") && method === "GET") {
        return Promise.resolve(Response.json(HOSTS));
      }
      if (url.includes("/api/t3/hosts/host-laptop") && method === "PATCH") {
        const body = parseJsonBody(init?.body) as {
          label?: string;
          kind?: "user" | "container";
          projectsRoot?: string;
        };
        return Promise.resolve(
          Response.json({
            ...HOST_LAPTOP,
            label: body.label ?? HOST_LAPTOP.label,
            kind: body.kind ?? HOST_LAPTOP.kind,
            projectsRoot: body.projectsRoot ?? HOST_LAPTOP.projectsRoot,
          }),
        );
      }
      if (url.includes("/api/t3/hosts/host-server") && method === "DELETE") {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: "Cannot disconnect Build Server while 1 session is running on it.",
              code: "host_busy",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      if (url.includes("/api/t3/oauth/start") && method === "POST") {
        return Promise.resolve(Response.json({ authorizationUrl: "https://auth.example.com/authorize" }));
      }
      if (url.includes("/api/t3/mappings")) {
        return Promise.resolve(Response.json(MAPPINGS));
      }
      if (url.includes("/api/t3/projects")) {
        return Promise.resolve(Response.json([]));
      }
      return Promise.resolve(Response.json([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<SettingsView mode="cloudflare" projects={PROJECTS} role="owner" />);

    expect(await screen.findByTestId("t3-host-card-host-laptop")).toBeInTheDocument();
    expect(screen.getByTestId("t3-host-card-host-server")).toBeInTheDocument();
    expect(screen.getByText("2 hosts connected")).toBeInTheDocument();
    expect(screen.getByText("Connected (20d left)")).toBeInTheDocument();
    expect(screen.getByText("Expiring in 2d")).toBeInTheDocument();
    expect(screen.getByText("~/www")).toBeInTheDocument();
    expect(screen.getByText("/var/www")).toBeInTheDocument();

    // Edit host projectsRoot & label
    await user.click(screen.getByRole("button", { name: "Edit Laptop" }));
    const rootInput = screen.getByLabelText("Projects root");
    await user.clear(rootInput);
    await user.type(rootInput, "~/code");
    await user.click(screen.getByRole("button", { name: "Save host" }));
    expect(await screen.findByText("~/code")).toBeInTheDocument();

    // Disconnect refused while sessions run (409 host_busy)
    await user.click(screen.getByRole("button", { name: "Disconnect Build Server" }));
    expect(
      await screen.findByText(/Cannot disconnect Build Server while 1 session is running on it/u),
    ).toBeInTheDocument();
    expect(screen.getByTestId("t3-host-card-host-server")).toBeInTheDocument();

    // Reauthorise host passes hostId and projectsRoot
    await user.click(screen.getByRole("button", { name: "Reauthorise Build Server" }));
    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith("https://auth.example.com/authorize");
    });
    const oauthCall = fetchMock.mock.calls.find(([u]) => requestUrl(u).includes("/api/t3/oauth/start"));
    expect(parseJsonBody(oauthCall?.[1]?.body)).toEqual({
      mcpUrl: "https://server.example.com/mcp",
      hostId: "host-server",
      label: "Build Server",
      kind: "container",
      projectsRoot: "/var/www",
    });
  });

  it("auto-updates default projects root when switching host kind in the connect form", async () => {
    const assignSpy = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { search: "", assign: assignSpy },
    });

    const fetchMock = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.includes("/api/t3/oauth/start")) {
        return Promise.resolve(Response.json({ authorizationUrl: "https://auth.example.com/new" }));
      }
      if (url.includes("/api/t3/connection")) {
        return Promise.resolve(Response.json({ connected: false }));
      }
      return Promise.resolve(Response.json([]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(<SettingsView mode="cloudflare" projects={PROJECTS} role="owner" />);

    await screen.findByText("T3 Code Host");
    const rootInput = screen.getByLabelText("Projects root on host");
    expect(rootInput).toHaveValue("~/www");

    await user.selectOptions(screen.getByLabelText("Host kind"), "container");
    expect(rootInput).toHaveValue("/var/www");

    await user.type(screen.getByLabelText("T3 MCP Endpoint URL"), "https://new-host.example.com/mcp");
    await user.type(screen.getByLabelText(/Host label/u), "Staging Box");
    await user.click(screen.getByRole("button", { name: "Connect T3" }));

    await waitFor(() => {
      expect(assignSpy).toHaveBeenCalledWith("https://auth.example.com/new");
    });
    const oauthCall = fetchMock.mock.calls.find(([u]) => requestUrl(u).includes("/api/t3/oauth/start"));
    expect(parseJsonBody(oauthCall?.[1]?.body)).toEqual({
      mcpUrl: "https://new-host.example.com/mcp",
      label: "Staging Box",
      kind: "container",
      projectsRoot: "/var/www",
    });
  });

  it("shows read-only project hosts for non-owner members and hides host management controls", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input) => {
        const url = requestUrl(input);
        if (url.includes("/api/t3/hosts")) return Promise.resolve(Response.json(HOSTS));
        if (url.includes("/api/t3/mappings")) return Promise.resolve(Response.json(MAPPINGS));
        return Promise.resolve(Response.json([]));
      }),
    );

    render(<SettingsView mode="cloudflare" projects={PROJECTS} role="editor" />);

    expect(await screen.findByText("Project T3 Hosts")).toBeInTheDocument();
    expect(screen.getByText("Read-only (editor)")).toBeInTheDocument();
    const webRow = await screen.findByTestId(`member-project-host-${PROJECT_WEB.id}`);
    expect(webRow).toHaveTextContent("Bitig Web");
    expect(webRow).toHaveTextContent("~/www/bitig-web");
    expect(webRow).toHaveTextContent("Laptop");

    const apiRow = screen.getByTestId(`member-project-host-${PROJECT_API.id}`);
    expect(apiRow).toHaveTextContent("Not bound to a T3 host");

    expect(screen.queryByRole("button", { name: /Connect T3/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Disconnect/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reauthorise/u })).not.toBeInTheDocument();
    expect(screen.queryByText("Project Mapping")).not.toBeInTheDocument();
  });
});
