import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { MockWebSocket } from "./test/setup";

const TEST_USER = "admin";

function stubApi(responses: {
  health?: { status: string; version: string; storageMode: string };
  projects?: unknown[];
  tasks?: unknown[];
  webhooks?: unknown[];
  /** Whether the browser starts with a valid session cookie; defaults to signed in. */
  signedIn?: boolean;
}) {
  vi.stubGlobal("nostr", {
    signEvent: vi.fn((event: Record<string, unknown>) =>
      Promise.resolve({ ...event, id: "a".repeat(64), pubkey: TEST_USER, sig: "b".repeat(128) }),
    ),
  });
  let signedIn = responses.signedIn ?? true;
  const healthData = responses.health ?? { status: "ok", version: "0.4.1", storageMode: "cloudflare" };
  const projectsData = responses.projects ?? [];
  const tasksData = responses.tasks ?? [];
  const webhooksData = [...(responses.webhooks ?? [])] as Record<string, unknown>[];

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.includes("/health")) {
        return Promise.resolve(Response.json(healthData, { status: 200 }));
      }

      if (url.includes("/api/auth/session")) {
        return Promise.resolve(
          signedIn
            ? Response.json({ user: TEST_USER })
            : Response.json({ error: "unauthorized" }, { status: 401 }),
        );
      }
      if (url.includes("/api/auth/challenge")) {
        return Promise.resolve(Response.json({
          event: { kind: 22242, created_at: 1, content: "Sign in to Bitig", tags: [["challenge", "nonce"]] },
        }));
      }
      if (url.includes("/api/auth/nostr")) {
        signedIn = true;
        return Promise.resolve(Response.json({ user: TEST_USER }));
      }
      if (url.includes("/api/auth/logout")) {
        signedIn = false;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes("/api/") && !signedIn) {
        return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
      }

      if (url.includes("/api/t3/runs")) {
        return Promise.resolve(Response.json({ runs: [], activeSessions: [] }, { status: 200 }));
      }

      if (url.includes("/api/projects")) {
        if (init?.method === "PATCH") {
          const id = decodeURIComponent(url.split("/").pop() ?? "");
          const existing = (projectsData as { id: string }[]).find((p) => p.id === id);
          if (!existing) return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
          const patch = JSON.parse(init.body as string) as Record<string, unknown>;
          return Promise.resolve(
            Response.json({ ...existing, ...patch, updatedAt: new Date().toISOString() }, { status: 200 }),
          );
        }
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as { name: string; kind?: string };
          const newProj = {
            id: "01940000-0000-7000-8000-000000000001",
            name: body.name,
            description: "",
            kind: body.kind ?? "hobby",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          return Promise.resolve(Response.json(newProj, { status: 201 }));
        }
        return Promise.resolve(Response.json(projectsData, { status: 200 }));
      }

      if (url.includes("/api/tasks")) {
        if (url.endsWith("/comments") || url.endsWith("/checkpoints")) {
          return Promise.resolve(Response.json([], { status: 200 }));
        }
        if (url.endsWith("/attachments")) {
          if (init?.method === "POST") {
            const parts = url.split("/");
            const taskId = decodeURIComponent(parts[parts.length - 2] ?? "");
            const body = JSON.parse(init.body as string) as { name: string; mimeType?: string; data: string };
            return Promise.resolve(
              Response.json(
                {
                  id: "01940000-0000-7000-8000-000000000088",
                  taskId,
                  name: body.name,
                  mimeType: body.mimeType ?? "text/plain",
                  size: Math.max(1, body.data.length),
                  createdAt: new Date().toISOString(),
                  createdBy: "you",
                },
                { status: 201 },
              ),
            );
          }
          return Promise.resolve(Response.json([], { status: 200 }));
        }
        if (init?.method === "PATCH") {
          const id = decodeURIComponent(url.split("/").pop() ?? "");
          const existing = (tasksData as { id: string }[]).find((t) => t.id === id);
          if (!existing) return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
          const patch = JSON.parse(init.body as string) as Record<string, unknown>;
          // Like the server, null clears a field.
          const merged = Object.fromEntries(
            Object.entries<unknown>({ ...existing, ...patch }).filter(([, value]) => value !== null),
          );
          return Promise.resolve(
            Response.json({ ...merged, updatedAt: new Date().toISOString() }, { status: 200 }),
          );
        }
        if (init?.method === "POST" && url.endsWith("/complete")) {
          return Promise.resolve(
            Response.json(
              {
                id: "01940000-0000-7000-8000-000000000002",
                projectId: "01940000-0000-7000-8000-000000000001",
                title: "Test Task",
                description: "",
                status: "done",
                isPublic: false,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              { status: 200 },
            ),
          );
        }
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as { title: string; projectId: string };
          const newTask = {
            id: "01940000-0000-7000-8000-000000000002",
            projectId: body.projectId,
            title: body.title,
            description: "",
            status: "todo",
            isPublic: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          return Promise.resolve(Response.json(newTask, { status: 201 }));
        }
        return Promise.resolve(Response.json(tasksData, { status: 200 }));
      }

      if (url.includes("/api/webhooks")) {
        if (init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (init?.method === "PATCH") {
          const id = decodeURIComponent(url.split("/").pop() ?? "");
          const index = webhooksData.findIndex((w) => w.id === id);
          const existing = webhooksData[index];
          if (index === -1 || !existing) {
            return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
          }
          const patch = JSON.parse(init.body as string) as Record<string, unknown>;
          const updated: Record<string, unknown> = {
            ...existing,
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.regenerateToken === true
              ? { token: "whk_ffffffffffffffffffffffffffffffff" }
              : {}),
            updatedAt: new Date().toISOString(),
          };
          if ("defaultPriority" in patch) {
            if (patch.defaultPriority === null) delete updated.defaultPriority;
            else updated.defaultPriority = patch.defaultPriority;
          }
          if ("defaultLabels" in patch) {
            if (patch.defaultLabels === null) delete updated.defaultLabels;
            else updated.defaultLabels = patch.defaultLabels;
          }
          if ("mapping" in patch) {
            if (patch.mapping === null) delete updated.mapping;
            else updated.mapping = patch.mapping;
          }
          webhooksData[index] = updated;
          return Promise.resolve(Response.json(updated, { status: 200 }));
        }
        if (init?.method === "POST") {
          const body = JSON.parse(init.body as string) as Record<string, unknown>;
          const created = {
            id: "01940000-0000-7000-8000-000000000099",
            projectId: body.projectId,
            name: body.name,
            provider: body.provider ?? "generic",
            token: "whk_0123456789abcdef0123456789abcdef",
            enabled: body.enabled ?? true,
            ...(body.defaultPriority ? { defaultPriority: body.defaultPriority } : {}),
            ...(body.defaultLabels ? { defaultLabels: body.defaultLabels } : {}),
            ...(body.mapping ? { mapping: body.mapping } : {}),
            triggerCount: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          webhooksData.push(created);
          return Promise.resolve(Response.json(created, { status: 201 }));
        }
        return Promise.resolve(Response.json(webhooksData, { status: 200 }));
      }

      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
}

describe("Dashboard Phase 4 Integration", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app");
    vi.restoreAllMocks();
  });

  it("navigates between Overview, Projects, and Tasks tabs", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });

    // Initially in Overview
    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();

    // Click Projects tab in primary nav
    await user.click(within(nav).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();

    // Click Tasks tab in primary nav
    await user.click(within(nav).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new task/i })).toBeInTheDocument();

    // Click Webhooks tab in primary nav
    await user.click(within(nav).getByRole("link", { name: "Webhooks" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Webhooks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new webhook/i })).toBeInTheDocument();

    // Click back to Overview
    await user.click(within(nav).getByRole("link", { name: "Overview" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
  });

  it("opens a completed task from the Needs you inbox without leaving the overview and archives it", async () => {
    const projectId = "01940000-0000-7000-8000-000000000041";
    const taskId = "01940000-0000-7000-8000-000000000042";
    const secondTaskId = "01940000-0000-7000-8000-000000000043";
    const createdAt = "2026-10-01T10:00:00.000Z";
    stubApi({
      projects: [{ id: projectId, key: "REV", name: "Review project", description: "", kind: "hobby", createdAt, updatedAt: createdAt }],
      tasks: [
        { id: taskId, projectId, number: 7, title: "Check completed work", description: "", status: "done", isPublic: false, createdAt, updatedAt: createdAt, completedAt: createdAt },
        { id: secondTaskId, projectId, number: 8, title: "Second completed work", description: "", status: "done", isPublic: false, createdAt, updatedAt: createdAt, completedAt: createdAt },
      ],
    });
    const user = userEvent.setup();
    render(<App />);

    const review = await screen.findByRole("region", { name: /Needs you/ });
    const link = await within(review).findByRole("link", { name: "REV-7 Check completed work" });
    await user.click(link);

    expect(window.location.pathname).toBe("/app");
    expect(new URLSearchParams(window.location.search).get("task")).toBe("REV-7");
    const dialog = await screen.findByRole("dialog", { name: "Check completed work" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Overview" })).toBeInTheDocument();

    // Archive from the task detail modal
    await user.click(within(dialog).getByRole("button", { name: "Archive" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/app");
    expect(new URLSearchParams(window.location.search).get("task")).toBeNull();
    await waitFor(() => {
      expect(within(review).queryByText("Check completed work")).not.toBeInTheDocument();
    });

    // Archive directly from the inbox
    await user.click(within(review).getByRole("button", { name: "Archive Second completed work" }));
    await waitFor(() => {
      expect(within(review).getByText("Nothing needs you right now.")).toBeInTheDocument();
    });
  });

  it("sends signed-out visitors to /login and back to where they were", async () => {
    window.history.replaceState(null, "", "/projects");
    stubApi({ signedIn: false });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/projects");
    expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /sign in with nostr/i }));

    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/projects");
    expect(screen.getByText(TEST_USER)).toBeInTheDocument();

    // Signing out returns to the sign-in page
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });

  it("shows an error when no NIP-07 extension is available", async () => {
    window.history.replaceState(null, "", "/login");
    stubApi({ signedIn: false });
    vi.stubGlobal("nostr", undefined);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: /sign in with nostr/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("NIP-07 Nostr extension");
    expect(window.location.pathname).toBe("/login");
  });

  it("restores an existing session without asking to sign in", async () => {
    stubApi({});
    render(<App />);

    expect(await screen.findByText(TEST_USER)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/app");
  });

  it("moves a signed-in visitor off /login", async () => {
    window.history.replaceState(null, "", "/login?next=%2Ftasks");
    stubApi({});
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/tasks");
  });

  it("ignores a next parameter that points to another site", async () => {
    window.history.replaceState(null, "", "/login?next=%2F%2Fevil.test");
    stubApi({});
    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/app");
  });

  it("sends the visitor to sign in when the API rejects the session", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    // The cookie expires server-side while the page is open
    vi.mocked(fetch).mockImplementation(() =>
      Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 })),
    );
    await user.click(within(nav).getByRole("link", { name: "Projects" }));
    await user.click(await screen.findByRole("button", { name: /new project/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/project name/i), "Late project");
    await user.click(within(dialog).getByRole("button", { name: "Create Project" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("next")).toBe("/projects");
  });

  it("supports creating a project", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });

    // Navigate to Projects
    await user.click(within(nav).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();

    // Click New Project
    await user.click(screen.getByRole("button", { name: /new project/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New Project" })).toBeInTheDocument();

    // Fill project form
    await user.type(within(dialog).getByLabelText(/project name/i), "Bitig Core");
    await user.type(within(dialog).getByLabelText(/description/i), "Domain types and schemas");

    // Submit form
    await user.click(within(dialog).getByRole("button", { name: "Create Project" }));

    // Project card should appear
    expect(await screen.findByText("Bitig Core")).toBeInTheDocument();
    expect(screen.getByText("hobby")).toBeInTheDocument();
  });

  it("supports creating and completing a task", async () => {
    const existingProject = {
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig App",
      description: "App description",
      kind: "hobby",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    stubApi({
      projects: [existingProject],
    });

    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });

    // Go to Tasks
    await user.click(within(nav).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();

    // Click New Task
    await user.click(screen.getByRole("button", { name: /new task/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New Task" })).toBeInTheDocument();

    // Fill task form
    await user.type(within(dialog).getByLabelText(/title/i), "Deploy to Cloudflare");
    await user.click(within(dialog).getByRole("button", { name: "Create Task" }));

    // Task card should appear
    expect(await screen.findByText("Deploy to Cloudflare")).toBeInTheDocument();

    // Complete the task
    const completeBtn = screen.getByTitle("Mark as Done");
    await user.click(completeBtn);

    // Status is updated
    await waitFor(() => {
      expect(screen.getByTitle("Mark as To Do")).toBeInTheDocument();
    });

    // Reopening "New Task" resets form fields to clean defaults
    await user.click(screen.getByRole("button", { name: /new task/i }));
    const freshDialog = await screen.findByRole("dialog");
    expect(within(freshDialog).getByLabelText(/title/i)).toHaveValue("");
    expect(within(freshDialog).getByLabelText(/description/i)).toHaveValue("");
  });

  it("uploads staged attachments when creating a task from the New Task modal", async () => {
    const existingProject = {
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig App",
      description: "App description",
      kind: "hobby",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    stubApi({ projects: [existingProject] });
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Tasks" }));

    await user.click(await screen.findByRole("button", { name: /new task/i }));
    const dialog = await screen.findByRole("dialog");

    await user.type(within(dialog).getByLabelText(/title/i), "Task with Spec");
    const fileInput = within(dialog).getByLabelText("Attach files");
    const specFile = new File(["# Spec\n\nDetails.\n"], "spec.md", { type: "text/markdown" });
    await user.upload(fileInput, specFile);

    expect(await within(dialog).findByText("spec.md")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Create Task" }));

    expect(await screen.findByText("Task with Spec")).toBeInTheDocument();
    expect(await screen.findByTitle("1 attachment")).toBeInTheDocument();
  });

  it("supports editing a project", async () => {
    const existingProject = {
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig App",
      description: "App description",
      kind: "hobby",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    stubApi({ projects: [existingProject] });

    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Projects" }));

    // Open the edit dialog prefilled with the project
    await user.click(await screen.findByRole("button", { name: "Edit Bitig App" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Edit Project" })).toBeInTheDocument();
    const nameInput = within(dialog).getByLabelText(/project name/i);
    expect(nameInput).toHaveValue("Bitig App");

    await user.clear(nameInput);
    await user.type(nameInput, "Bitig Platform");
    await user.click(within(dialog).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    const patchCall = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall?.[0]).toContain(`/api/projects/${existingProject.id}`);
    expect(JSON.parse(patchCall?.[1]?.body as string)).toMatchObject({ name: "Bitig Platform" });
    expect(await screen.findByText("Bitig Platform")).toBeInTheDocument();
  });

  it("supports editing a task", async () => {
    const existingProject = {
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig App",
      description: "App description",
      kind: "hobby",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const existingTask = {
      id: "01940000-0000-7000-8000-000000000002",
      projectId: existingProject.id,
      title: "Write documentation",
      description: "Docs for users",
      status: "todo",
      priority: "low",
      isPublic: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    stubApi({ projects: [existingProject], tasks: [existingTask] });

    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Tasks" }));

    // Open the edit dialog prefilled with the task
    await user.click(await screen.findByRole("button", { name: "Edit Write documentation" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Edit Task" })).toBeInTheDocument();
    const titleInput = within(dialog).getByLabelText(/title/i);
    expect(titleInput).toHaveValue("Write documentation");
    // Task visibility is a Nostr concept; Cloudflare mode hides it.
    expect(within(dialog).queryByLabelText(/public task/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle("Private task (NIP-44 encrypted)")).not.toBeInTheDocument();

    // Change title and priority, then save
    await user.clear(titleInput);
    await user.type(titleInput, "Write user guide");
    await user.selectOptions(within(dialog).getByLabelText(/priority/i), "high");
    await user.click(within(dialog).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // The PATCH carries the edited fields
    const patchCall = vi
      .mocked(fetch)
      .mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall?.[0]).toContain(`/api/tasks/${existingTask.id}`);
    expect(JSON.parse(patchCall?.[1]?.body as string)).toMatchObject({
      title: "Write user guide",
      priority: "high",
    });

    // The board shows the updated task
    expect(await screen.findByText("Write user guide")).toBeInTheDocument();
    expect(screen.queryByText("Write documentation")).not.toBeInTheDocument();
  });

  it("toggles between Kanban board and List views", async () => {
    const existingProject = {
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig App",
      description: "App description",
      kind: "hobby",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const existingTask = {
      id: "01940000-0000-7000-8000-000000000002",
      projectId: existingProject.id,
      title: "Write documentation",
      description: "Docs for users",
      status: "todo",
      priority: "high",
      isPublic: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    stubApi({
      projects: [existingProject],
      tasks: [existingTask],
    });

    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Tasks" }));

    // Board view has active Kanban columns and compact archive toggle icon
    expect(await screen.findByText("To Do")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByTestId("column-archived")).not.toBeInTheDocument();
    expect(screen.getByTestId("toggle-archived-tasks")).toBeInTheDocument();
    expect(screen.getByText("Write documentation")).toBeInTheDocument();

    // Switch to List view
    await user.click(screen.getByLabelText("List view"));

    // Table view with headers
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByText("Write documentation")).toBeInTheDocument();
  });

  it("supports creating, editing, toggling, regenerating token, and deleting a webhook", async () => {
    const existingProject = {
      id: "01940000-0000-7000-8000-000000000001",
      name: "Bitig App",
      key: "BIT",
      description: "App description",
      kind: "hobby",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    stubApi({ projects: [existingProject] });
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Webhooks" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Webhooks" })).toBeInTheDocument();

    // Open New Webhook modal
    await user.click(screen.getByRole("button", { name: /new webhook/i }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "New Webhook" })).toBeInTheDocument();

    // Fill webhook form with provider and custom mapping
    await user.selectOptions(within(dialog).getByLabelText(/provider/i), "jira");
    await user.type(within(dialog).getByLabelText(/webhook name/i), "Jira Issues");
    await user.selectOptions(within(dialog).getByLabelText(/default priority/i), "high");
    await user.type(within(dialog).getByLabelText(/default labels/i), "jira, incoming");
    await user.type(within(dialog).getByLabelText("bitig.title"), "issue.fields.summary");
    await user.click(within(dialog).getByRole("button", { name: "Create Webhook" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    // Created webhook card appears with provider, mapping, and masked URL
    expect(await screen.findByText("Jira Issues")).toBeInTheDocument();
    expect(screen.getByText("issue.fields.summary")).toBeInTheDocument();
    expect(screen.getByText(/whk_0123••••••••cdef/)).toBeInTheDocument();

    // Reveal full URL
    await user.click(screen.getByRole("button", { name: "Reveal URL for Jira Issues" }));
    expect(screen.getByText(/whk_0123456789abcdef0123456789abcdef/)).toBeInTheDocument();

    // Regenerate token
    await user.click(screen.getByRole("button", { name: "Regenerate token for Jira Issues" }));
    expect(await screen.findByText(/whk_ffffffffffffffffffffffffffffffff/)).toBeInTheDocument();

    // Toggle enabled -> disabled
    await user.click(screen.getByRole("button", { name: "Disable Jira Issues" }));
    expect(await screen.findByText("Disabled")).toBeInTheDocument();

    // Edit webhook name
    await user.click(screen.getByRole("button", { name: "Edit Jira Issues" }));
    const editDialog = await screen.findByRole("dialog");
    const nameInput = within(editDialog).getByLabelText(/webhook name/i);
    await user.clear(nameInput);
    await user.type(nameInput, "Jira Cloud Issues");
    await user.click(within(editDialog).getByRole("button", { name: "Save Changes" }));

    expect(await screen.findByText("Jira Cloud Issues")).toBeInTheDocument();

    // Delete webhook
    await user.click(screen.getByRole("button", { name: "Delete Jira Cloud Issues" }));
    const deleteDialog = await screen.findByRole("dialog");
    expect(within(deleteDialog).getByRole("heading", { name: "Delete Webhook" })).toBeInTheDocument();
    await user.click(within(deleteDialog).getByRole("button", { name: "Delete Webhook" }));

    await waitFor(() => {
      expect(screen.queryByText("Jira Cloud Issues")).not.toBeInTheDocument();
    });
  });
});

describe("Dashboard routing", () => {
  const PROJECT_A = {
    id: "01940000-0000-7000-8000-00000000000a",
    name: "Alpha",
    description: "",
    kind: "hobby",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const PROJECT_B = { ...PROJECT_A, id: "01940000-0000-7000-8000-00000000000b", name: "Beta" };
  const TASK_A = {
    id: "01940000-0000-7000-8000-0000000000a1",
    projectId: PROJECT_A.id,
    title: "Alpha task",
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const TASK_B = { ...TASK_A, id: "01940000-0000-7000-8000-0000000000b1", projectId: PROJECT_B.id, title: "Beta task" };

  beforeEach(() => {
    window.history.replaceState(null, "", "/app");
    vi.restoreAllMocks();
  });

  it("keeps the page after a reload", async () => {
    window.history.replaceState(null, "", "/projects");
    stubApi({});
    render(<App />);

    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "page");
  });

  it("puts the nav section in the URL", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    expect(within(nav).getByRole("link", { name: "Tasks" })).toHaveAttribute("href", "/tasks");

    await user.click(within(nav).getByRole("link", { name: "Tasks" }));
    expect(window.location.pathname).toBe("/tasks");
  });

  it("restores the project filter from the URL and keeps it in sync", async () => {
    window.history.replaceState(null, "", `/tasks?project=${PROJECT_A.id}`);
    stubApi({ projects: [PROJECT_A, PROJECT_B], tasks: [TASK_A, TASK_B] });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Alpha task")).toBeInTheDocument();
    expect(screen.queryByText("Beta task")).not.toBeInTheDocument();
    // Filtered to a single project: the card does not repeat the project name badge
    const card = screen.getByText("Alpha task").closest("article");
    if (!card) throw new Error("expected task card article");
    expect(within(card).queryByText("Alpha")).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/project:/i), PROJECT_B.id);
    expect(await screen.findByText("Beta task")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("project")).toBe(PROJECT_B.id);

    // Selecting "All Projects" shows the project name badge on cards again
    await user.selectOptions(screen.getByLabelText(/project:/i), "");
    const allCard = screen.getByText("Alpha task").closest("article");
    if (!allCard) throw new Error("expected task card article");
    expect(within(allCard).getByText("Alpha")).toBeInTheDocument();
  });

  it("filters to tasks that need a human, from the URL and the toggle", async () => {
    const flagged = { ...TASK_B, needsHuman: "Pick a launch date" };
    window.history.replaceState(null, "", "/tasks?needs=human");
    stubApi({ projects: [PROJECT_A, PROJECT_B], tasks: [TASK_A, flagged] });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Beta task")).toBeInTheDocument();
    expect(screen.queryByText("Alpha task")).not.toBeInTheDocument();
    expect(screen.getByText("Pick a launch date")).toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: /needs you \(1\)/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(await screen.findByText("Alpha task")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("needs")).toBeNull();
  });

  it("lists tasks that need a human in the overview inbox and opens them", async () => {
    stubApi({ projects: [PROJECT_A], tasks: [TASK_A, { ...TASK_A, id: "01940000-0000-7000-8000-0000000000a2", title: "Blocked task", needsHuman: "Approve the plan" }] });
    const user = userEvent.setup();
    render(<App />);

    const inbox = await screen.findByRole("region", { name: /Needs you/ });
    expect(await within(inbox).findByText("Approve the plan")).toBeInTheDocument();
    expect(within(inbox).queryByText("Alpha task")).not.toBeInTheDocument();
    await user.click(within(inbox).getByRole("link", { name: "Answer: Blocked task" }));
    expect(window.location.pathname).toBe("/app");
    expect(new URLSearchParams(window.location.search).get("task")).toBe("01940000-0000-7000-8000-0000000000a2");
    expect(await screen.findByRole("dialog", { name: "Blocked task" })).toBeInTheDocument();
  });

  it("filters to tasks awaiting approval, from the URL and the toggle, and approves one", async () => {
    const pending = { ...TASK_B, pendingApproval: true };
    window.history.replaceState(null, "", "/tasks?awaiting=approval");
    stubApi({ projects: [PROJECT_A, PROJECT_B], tasks: [TASK_A, pending] });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Beta task")).toBeInTheDocument();
    expect(screen.queryByText("Alpha task")).not.toBeInTheDocument();

    const card = screen.getByText("Beta task").closest("article");
    if (!card) throw new Error("expected task card article");
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      const patchCall = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patchCall?.[0]).toContain(`/api/tasks/${TASK_B.id}`);
      expect(JSON.parse(patchCall?.[1]?.body as string)).toEqual({ pendingApproval: null, status: "todo" });
    });

    const toggle = screen.getByRole("button", { name: /awaiting approval \(\d\)/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    await user.click(toggle);
    expect(await screen.findByText("Alpha task")).toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("awaiting")).toBeNull();
  });

  it("keeps Backlog tasks out of the overview inbox", async () => {
    stubApi({
      projects: [PROJECT_A],
      tasks: [
        { ...TASK_A, status: "done", completedAt: new Date().toISOString() },
        { ...TASK_A, id: "01940000-0000-7000-8000-0000000000a3", title: "Agent idea", pendingApproval: true, needsHuman: "Worth it?" },
      ],
    });
    render(<App />);

    const inbox = await screen.findByRole("region", { name: /Needs you/ });
    expect(await within(inbox).findByText("Alpha task")).toBeInTheDocument();
    expect(within(inbox).queryByText("Agent idea")).not.toBeInTheDocument();
  });

  it("opens a project's tasks from the Projects page", async () => {
    window.history.replaceState(null, "", "/projects");
    stubApi({ projects: [PROJECT_A, PROJECT_B], tasks: [TASK_A, TASK_B] });
    const user = userEvent.setup();
    render(<App />);

    const [, betaViewTasks] = await screen.findAllByRole("button", { name: /view tasks/i });
    if (!betaViewTasks) throw new Error("expected a View tasks button for Beta");
    await user.click(betaViewTasks);

    expect(await screen.findByText("Beta task")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/tasks");
    expect(new URLSearchParams(window.location.search).get("project")).toBe(PROJECT_B.id);
  });

  it("opens a task from its code in the URL without forcing a project filter, and keeps the URL in sync", async () => {
    const coded = { ...PROJECT_B, key: "BET" };
    window.history.replaceState(null, "", "/tasks?task=bet-7");
    stubApi({ projects: [PROJECT_A, coded], tasks: [TASK_A, { ...TASK_B, number: 7, description: "Beta details" }] });
    const user = userEvent.setup();
    render(<App />);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Beta details")).toBeInTheDocument();
    // Opening a task without ?project= keeps the All Projects view behind it.
    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    expect(screen.getByLabelText(/project:/i)).toHaveValue("");

    await user.click(within(dialog).getByRole("button", { name: /close/i }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    const params = new URLSearchParams(window.location.search);
    expect(params.get("task")).toBeNull();
    expect(params.get("project")).toBeNull();

    await user.click(screen.getByText("Beta task"));
    expect(window.location.pathname).toBe("/tasks/BET-7");
    expect(await screen.findByRole("heading", { level: 1, name: "Beta task" })).toBeInTheDocument();
    expect(screen.getByText("Beta details")).toBeInTheDocument();
  });

  it("opens and edits a task from Pick up where you left off while staying on Overview", async () => {
    const coded = { ...PROJECT_B, key: "BET" };
    stubApi({
      projects: [PROJECT_A, coded],
      tasks: [
        TASK_A,
        {
          ...TASK_B,
          number: 7,
          status: "in_progress",
          description: "Beta details",
          startedAt: new Date().toISOString(),
        },
      ],
    });
    const user = userEvent.setup();
    render(<App />);

    const inProgress = await screen.findByTestId("left-off-recent");
    await user.click(within(inProgress).getByRole("link", { name: /BET-7\s*Beta task/ }));

    expect(window.location.pathname).toBe("/app");
    expect(new URLSearchParams(window.location.search).get("task")).toBe("BET-7");
    const detailDialog = await screen.findByRole("dialog", { name: "Beta task" });
    expect(within(detailDialog).getByText("Beta details")).toBeInTheDocument();
    expect(within(detailDialog).getByRole("link", { name: "Open full page" })).toHaveAttribute(
      "href",
      "/tasks/BET-7",
    );

    // Clicking Edit opens the Edit Task modal on Overview
    await user.click(within(detailDialog).getByRole("button", { name: "Edit" }));
    const editDialog = await screen.findByRole("dialog", { name: "Edit Task" });
    expect(window.location.pathname).toBe("/app");
    expect(new URLSearchParams(window.location.search).get("task")).toBeNull();

    const titleInput = within(editDialog).getByLabelText(/title/i);
    await user.clear(titleInput);
    await user.type(titleInput, "Beta task updated");
    await user.click(within(editDialog).getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/app");
    expect(await within(inProgress).findByRole("link", { name: /BET-7\s*Beta task updated/ })).toBeInTheDocument();
  });

  it("links a task without a code by its ID", async () => {
    window.history.replaceState(null, "", "/tasks");
    stubApi({ projects: [PROJECT_A], tasks: [TASK_A] });
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByText("Alpha task"));
    expect(window.location.pathname).toBe(`/tasks/${TASK_A.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Alpha task" })).toBeInTheDocument();
  });

  it("shows linked tasks in both directions and opens them", async () => {
    const coded = { ...PROJECT_A, key: "BIT" };
    const target = { ...TASK_A, number: 64, title: "Signup", description: "After #BIT-63" };
    const dependency = { ...TASK_A, id: "01940000-0000-7000-8000-0000000000a5", number: 63, title: "Schema", status: "done" };
    const mentioner = {
      ...TASK_A,
      id: "01940000-0000-7000-8000-0000000000a6",
      number: 70,
      title: "Launch",
      checklist: [{ text: "Wait for #BIT-64", done: false }],
    };
    window.history.replaceState(null, "", "/tasks?task=BIT-64");
    stubApi({ projects: [coded], tasks: [target, dependency, mentioner] });
    const user = userEvent.setup();
    render(<App />);

    const dialog = await screen.findByRole("dialog");
    const mentions = within(dialog).getByRole("list", { name: "Mentions" });
    expect(within(mentions).getByRole("link")).toHaveTextContent("BIT-63Schema");
    const mentionedIn = within(dialog).getByRole("list", { name: "Mentioned in" });
    await user.click(within(mentionedIn).getByRole("link", { name: /BIT-70\s*Launch/ }));

    expect(new URLSearchParams(window.location.search).get("task")).toBe("BIT-70");
    expect(await within(screen.getByRole("dialog")).findByRole("list", { name: "Mentions" })).toHaveTextContent("Signup");
  });

  it("says when a linked task does not exist", async () => {
    window.history.replaceState(null, "", "/tasks?task=BIT-999");
    stubApi({ projects: [PROJECT_A], tasks: [TASK_A] });
    const user = userEvent.setup();
    render(<App />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No task BIT-999 was found");
    expect(screen.getByText("Alpha task")).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(new URLSearchParams(window.location.search).get("task")).toBeNull();
  });

  it("follows the browser back button", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();

    window.history.back();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
  });

  it("redirects unknown paths to the overview", async () => {
    window.history.replaceState(null, "", "/no-such-page");
    stubApi({});
    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/app");
  });

  it("updates the project tasks board and detail modal in realtime when MCP broadcasts events", async () => {
    window.history.replaceState(null, "", `/tasks?project=${PROJECT_A.id}`);
    stubApi({ projects: [PROJECT_A], tasks: [TASK_A] });
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText("Alpha task")).toBeInTheDocument();
    const ws = MockWebSocket.instances.at(-1);
    expect(ws?.url).toContain("/api/realtime");
    ws?.open();

    const todoColumn = screen.getByTestId("column-todo");
    const inProgressColumn = screen.getByTestId("column-in_progress");

    expect(within(todoColumn).getByText("Alpha task")).toBeInTheDocument();

    // 1. MCP moves TASK_A from todo -> in_progress
    act(() => {
      ws?.receiveMessage({
        type: "task.updated",
        task: { ...TASK_A, status: "in_progress", updatedAt: "2026-10-20T12:05:00.000Z" },
      });
    });

    expect(within(todoColumn).queryByText("Alpha task")).not.toBeInTheDocument();
    expect(within(inProgressColumn).getByText("Alpha task")).toBeInTheDocument();

    // 2. MCP adds a new task to the project
    const NEW_TASK = {
      id: "01940000-0000-7000-8000-0000000000a9",
      projectId: PROJECT_A.id,
      title: "Agent created task",
      description: "Created by MCP",
      status: "todo" as const,
      isPublic: false,
      number: 2,
      createdAt: "2026-10-20T12:06:00.000Z",
      updatedAt: "2026-10-20T12:06:00.000Z",
    };
    act(() => {
      ws?.receiveMessage({
        type: "task.created",
        task: NEW_TASK,
      });
    });
    expect(within(todoColumn).getByText("Agent created task")).toBeInTheDocument();

    // 3. Click Alpha task on the board to open its full page and receive a live comment + completion
    await user.click(screen.getByText("Alpha task"));
    expect(window.location.pathname).toBe(`/tasks/${TASK_A.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Alpha task" })).toBeInTheDocument();
    expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);

    act(() => {
      ws?.receiveMessage({
        type: "comment.created",
        comment: {
          id: "01940000-0000-7000-8000-0000000000c1",
          taskId: TASK_A.id,
          body: "Finished implementation",
          authorType: "agent",
          author: "antigravity",
          createdAt: "2026-10-20T12:07:00.000Z",
        },
      });
      ws?.receiveMessage({
        type: "task.updated",
        task: { ...TASK_A, status: "done", updatedAt: "2026-10-20T12:08:00.000Z" },
      });
    });

    expect(await screen.findByText("Finished implementation")).toBeInTheDocument();
    expect(screen.getByLabelText("Change status")).toHaveValue("done");

    // Return to Tasks board to verify board column and comment badge
    await user.click(screen.getByRole("link", { name: /^Tasks$/i }));
    const doneColumnAfter = await screen.findByTestId("column-done");
    expect(within(doneColumnAfter).getByText("Alpha task")).toBeInTheDocument();
    expect(within(doneColumnAfter).getByTitle("1 comment")).toHaveTextContent("1");

    // 4. MCP deletes the comment and the badge disappears from the card
    act(() => {
      ws?.receiveMessage({
        type: "comment.deleted",
        id: "01940000-0000-7000-8000-0000000000c1",
        taskId: TASK_A.id,
      });
    });
    expect(within(doneColumnAfter).queryByTitle("1 comment")).not.toBeInTheDocument();

    // 5. MCP deletes the second task
    act(() => {
      ws?.receiveMessage({
        type: "task.deleted",
        id: NEW_TASK.id,
      });
    });
    expect(screen.queryByText("Agent created task")).not.toBeInTheDocument();
  });
});
