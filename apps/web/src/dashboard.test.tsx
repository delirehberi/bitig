import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

const TEST_USER = "admin";
const TEST_PASSWORD = "secret123";

function stubApi(responses: {
  health?: { status: string; version: string; storageMode: string };
  projects?: unknown[];
  tasks?: unknown[];
  /** Whether the browser starts with a valid session cookie; defaults to signed in. */
  signedIn?: boolean;
}) {
  let signedIn = responses.signedIn ?? true;
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

      if (url.includes("/api/auth/session")) {
        return Promise.resolve(
          signedIn
            ? Response.json({ user: TEST_USER })
            : Response.json({ error: "unauthorized" }, { status: 401 }),
        );
      }
      if (url.includes("/api/auth/login")) {
        const body = JSON.parse(init?.body as string) as { username: string; password: string };
        signedIn = body.username === TEST_USER && body.password === TEST_PASSWORD;
        return Promise.resolve(
          signedIn
            ? Response.json({ user: TEST_USER })
            : Response.json({ error: "unauthorized" }, { status: 401 }),
        );
      }
      if (url.includes("/api/auth/logout")) {
        signedIn = false;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url.includes("/api/") && !signedIn) {
        return Promise.resolve(Response.json({ error: "unauthorized" }, { status: 401 }));
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
      await screen.findByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();

    // Click Projects tab in primary nav
    await user.click(within(nav).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new project/i })).toBeInTheDocument();

    // Click Tasks tab in primary nav
    await user.click(within(nav).getByRole("link", { name: "Tasks" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new task/i })).toBeInTheDocument();

    // Click back to Overview
    await user.click(within(nav).getByRole("link", { name: "Overview" }));
    expect(
      screen.getByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();
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

    await user.type(screen.getByLabelText(/username/i), TEST_USER);
    await user.type(screen.getByLabelText(/password/i), TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/projects");
    expect(screen.getByText(TEST_USER)).toBeInTheDocument();

    // Signing out returns to the sign-in page
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign In" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/login");
  });

  it("shows an error for wrong credentials", async () => {
    window.history.replaceState(null, "", "/login");
    stubApi({ signedIn: false });
    const user = userEvent.setup();
    render(<App />);

    await user.type(await screen.findByLabelText(/username/i), TEST_USER);
    await user.type(screen.getByLabelText(/password/i), "wrong");
    await user.click(screen.getByRole("button", { name: /^sign in$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid username or password");
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
      await screen.findByRole("heading", { level: 1, name: "Your agents keep the record." }),
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

  it("counts tasks that need a human on the overview and opens them", async () => {
    stubApi({ projects: [PROJECT_A], tasks: [TASK_A, { ...TASK_A, id: "01940000-0000-7000-8000-0000000000a2", title: "Blocked task", needsHuman: "Approve" }] });
    const user = userEvent.setup();
    render(<App />);

    const tile = await screen.findByRole("button", { name: /needs you\s*1/i });
    await user.click(tile);
    expect(window.location.pathname).toBe("/tasks");
    expect(new URLSearchParams(window.location.search).get("needs")).toBe("human");
    expect(await screen.findByText("Blocked task")).toBeInTheDocument();
    expect(screen.queryByText("Alpha task")).not.toBeInTheDocument();
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

  it("follows the browser back button", async () => {
    stubApi({});
    const user = userEvent.setup();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Primary" });
    await user.click(within(nav).getByRole("link", { name: "Projects" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();

    window.history.back();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();
  });

  it("redirects unknown paths to the overview", async () => {
    window.history.replaceState(null, "", "/no-such-page");
    stubApi({});
    render(<App />);

    expect(
      await screen.findByRole("heading", { level: 1, name: "Your agents keep the record." }),
    ).toBeInTheDocument();
    expect(window.location.pathname).toBe("/app");
  });
});
