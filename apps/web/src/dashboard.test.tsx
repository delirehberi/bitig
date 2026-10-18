import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { clearStoredAuth, setStoredAuth } from "./auth/auth-storage";

function stubApi(responses: {
  health?: { status: string; version: string; storageMode: string };
  projects?: unknown[];
  tasks?: unknown[];
}) {
  const healthData = responses.health ?? { status: "ok", version: "0.4.1", storageMode: "cloudflare" };
  const projectsData = responses.projects ?? [];
  const tasksData = responses.tasks ?? [];

  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();

      if (url.includes("/health")) {
        return Promise.resolve(Response.json(healthData, { status: 200 }));
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
        if (init?.method === "PATCH") {
          const id = decodeURIComponent(url.split("/").pop() ?? "");
          const existing = (tasksData as { id: string }[]).find((t) => t.id === id);
          if (!existing) return Promise.resolve(Response.json({ error: "not_found" }, { status: 404 }));
          const patch = JSON.parse(init.body as string) as Record<string, unknown>;
          return Promise.resolve(
            Response.json({ ...existing, ...patch, updatedAt: new Date().toISOString() }, { status: 200 }),
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

      return Promise.resolve(new Response(null, { status: 404 }));
    }),
  );
}

describe("Dashboard Phase 4 Integration", () => {
  beforeEach(() => {
    clearStoredAuth();
    vi.restoreAllMocks();
  });

  it("navigates between Overview, Projects, and Tasks tabs", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });

    // Initially in Overview
    expect(
      await screen.findByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();

    // Click Projects tab in primary nav
    await user.click(within(nav).getByRole("button", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();

    // Click Tasks tab in primary nav
    await user.click(within(nav).getByRole("button", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new task/i })).toBeInTheDocument();

    // Click back to Overview
    await user.click(within(nav).getByRole("button", { name: "Overview" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();
  });

  it("handles user authentication flow", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    // Header has Sign In button
    const signInButton = await screen.findByRole("button", { name: /sign in/i });
    expect(signInButton).toBeInTheDocument();

    // Open login modal
    await user.click(signInButton);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Sign In" })).toBeInTheDocument();

    // Fill in username and password inside dialog
    const usernameInput = within(dialog).getByLabelText(/username/i);
    const passwordInput = within(dialog).getByLabelText(/password/i);
    await user.type(usernameInput, "admin");
    await user.type(passwordInput, "secret123");

    // Submit login button inside dialog
    const submitBtn = within(dialog).getByRole("button", { name: /^sign in$/i });
    await user.click(submitBtn);

    // Modal closes and username appears in header
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.getByText("admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();

    // Click sign out
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("button", { name: /sign in/i })).toBeInTheDocument();
  });

  it("shows already authenticated user from session storage", async () => {
    setStoredAuth("admin", "secret123");
    stubApi({});
    render(<App />);

    expect(await screen.findByText("admin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });

  it("supports creating a project", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });

    // Navigate to Projects
    await user.click(within(nav).getByRole("button", { name: "Projects" }));
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
    await user.click(within(nav).getByRole("button", { name: "Tasks" }));
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
    await user.click(within(nav).getByRole("button", { name: "Projects" }));

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
    await user.click(within(nav).getByRole("button", { name: "Tasks" }));

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
    await user.click(within(nav).getByRole("button", { name: "Tasks" }));

    // Board view has Kanban columns
    expect(await screen.findByText("To Do")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.getByText("Archived")).toBeInTheDocument();
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
});
