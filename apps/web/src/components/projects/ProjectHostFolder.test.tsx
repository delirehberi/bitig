import type {
  CreateProjectInput,
  Project,
  T3ConnectionStatus,
  T3HostConnectionStatus,
  T3ProjectMapping,
} from "@bitig/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  T3ApiError,
  checkT3HostFolder,
  fetchT3Connection,
  fetchT3Hosts,
  fetchT3ProjectMappings,
  registerT3HostFolder,
  unregisterT3HostFolder,
} from "../../services/t3";
import { ProjectHostFolder } from "./ProjectHostFolder";
import { ProjectModal } from "./ProjectModal";
import { ProjectsView } from "./ProjectsView";

vi.mock("../../services/t3", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkT3HostFolder: vi.fn(),
    fetchT3Connection: vi.fn(),
    fetchT3Hosts: vi.fn(),
    fetchT3ProjectMappings: vi.fn(),
    registerT3HostFolder: vi.fn(),
    unregisterT3HostFolder: vi.fn(),
  };
});

const TIMESTAMP = "2026-11-06T10:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Website Redesign",
  description: "",
  kind: "hobby",
  key: "WEB",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const MAPPING: T3ProjectMapping = {
  projectId: PROJECT.id,
  t3ProjectId: "t3-proj-1",
  t3ProjectTitle: "Website Redesign",
  updatedAt: TIMESTAMP,
};

const CONNECTED: T3ConnectionStatus = { connected: true, expired: false };

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProjectHostFolder (BIT-148)", () => {
  it("registers a suggested folder and reports the new link", async () => {
    const user = userEvent.setup();
    vi.mocked(registerT3HostFolder).mockResolvedValue({ mapping: MAPPING, created: true });
    const onMappingChange = vi.fn();
    render(<ProjectHostFolder project={PROJECT} mapping={undefined} onMappingChange={onMappingChange} />);

    await user.click(screen.getByRole("button", { name: "/var/www/website-redesign" }));
    await user.click(screen.getByRole("button", { name: "Register" }));

    expect(registerT3HostFolder).toHaveBeenCalledWith(
      PROJECT.id,
      "/var/www/website-redesign",
      expect.any(AbortSignal),
    );
    expect(onMappingChange).toHaveBeenCalledWith(MAPPING);
    expect(await screen.findByRole("status")).toHaveTextContent("Registered /var/www/website-redesign in T3.");
  });

  it("rejects an invalid path without calling the API", async () => {
    const user = userEvent.setup();
    render(<ProjectHostFolder project={PROJECT} mapping={undefined} onMappingChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Folder on T3 host"), "www/app");
    await user.click(screen.getByRole("button", { name: "Register" }));

    expect(screen.getByRole("alert")).toHaveTextContent("absolute");
    expect(registerT3HostFolder).not.toHaveBeenCalled();
  });

  it("shows the server's actionable error", async () => {
    const user = userEvent.setup();
    vi.mocked(registerT3HostFolder).mockRejectedValue(
      new T3ApiError(422, "T3 could not register /var/www/x: does not exist. Check that the folder exists on the host."),
    );
    render(<ProjectHostFolder project={PROJECT} mapping={undefined} onMappingChange={vi.fn()} />);

    await user.type(screen.getByLabelText("Folder on T3 host"), "/var/www/x");
    await user.click(screen.getByRole("button", { name: "Register" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Check that the folder exists on the host");
  });

  it("unregisters after confirmation, with force only when ticked", async () => {
    const user = userEvent.setup();
    vi.mocked(unregisterT3HostFolder).mockResolvedValue({ unregistered: true });
    const onMappingChange = vi.fn();
    render(<ProjectHostFolder project={PROJECT} mapping={MAPPING} onMappingChange={onMappingChange} />);

    await user.click(screen.getByRole("button", { name: "Unregister folder" }));
    expect(screen.getByText(/files stay on the host/u)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Unregister" }));

    expect(unregisterT3HostFolder).toHaveBeenCalledWith(PROJECT.id, expect.objectContaining({ force: true }));
    expect(vi.mocked(unregisterT3HostFolder).mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(onMappingChange).toHaveBeenCalledWith(undefined);
  });
});

describe("ProjectModal host folder field (BIT-148)", () => {
  it("is hidden unless enabled and when editing", () => {
    const { rerender } = render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByLabelText("Folder on T3 host")).not.toBeInTheDocument();
    rerender(<ProjectModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} project={PROJECT} hostFolderEnabled />);
    expect(screen.queryByLabelText("Folder on T3 host")).not.toBeInTheDocument();
  });

  it("passes a valid folder with the new project and blocks an invalid one", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(input: CreateProjectInput, extras?: { hostFolderPath?: string }) => Promise<void>>();
    onSubmit.mockResolvedValue(undefined);
    render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={onSubmit} hostFolderEnabled />);

    await user.type(screen.getByLabelText(/Project Name/u), "Website Redesign");
    const folder = screen.getByLabelText("Folder on T3 host");
    await user.type(folder, "--force");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(screen.getByRole("alert")).toHaveTextContent("absolute");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.clear(folder);
    await user.click(screen.getByRole("button", { name: "~/www/website-redesign" }));
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "Website Redesign" }), {
      hostFolderPath: "~/www/website-redesign",
    });
  });

  it("creates the project without a folder when the field is left empty", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<(input: CreateProjectInput, extras?: { hostFolderPath?: string }) => Promise<void>>();
    onSubmit.mockResolvedValue(undefined);
    render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={onSubmit} hostFolderEnabled />);

    await user.type(screen.getByLabelText(/Project Name/u), "No folder");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "No folder" }));
  });
});

describe("ProjectsView host folder registration (BIT-148)", () => {
  function renderView(onCreateProject: (input: CreateProjectInput) => Promise<Project>) {
    render(
      <ProjectsView
        projects={[]}
        tasks={[]}
        isLoading={false}
        error={null}
        onCreateProject={onCreateProject}
        onUpdateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onSelectProject={vi.fn()}
        searchQuery=""
        agentRuns={[]}
        activeSessions={[]}
        hostFolderEnabled
      />,
    );
  }

  it("keeps the created project and explains a registration failure", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchT3Connection).mockResolvedValue(CONNECTED);
    vi.mocked(registerT3HostFolder).mockRejectedValue(new T3ApiError(503, "Could not reach the T3 host."));
    const onCreateProject = vi.fn((input: CreateProjectInput) => Promise.resolve({ ...PROJECT, name: input.name }));
    renderView(onCreateProject);

    await user.click(screen.getByRole("button", { name: /New Project/u }));
    await user.type(screen.getByLabelText(/Project Name/u), "Website Redesign");
    await user.type(await screen.findByLabelText("Folder on T3 host"), "/var/www/site");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(onCreateProject).toHaveBeenCalledTimes(1);
    expect(registerT3HostFolder).toHaveBeenCalledWith(PROJECT.id, "/var/www/site");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('"Website Redesign" was created, but its folder was not registered');
    expect(alert).toHaveTextContent("retry from the project's T3 panel");
    // The dialog closed, so a second submit cannot create a duplicate project.
    expect(screen.queryByRole("button", { name: "Create Project" })).not.toBeInTheDocument();
  });

  it("hides the folder field when no T3 host is connected", async () => {
    const user = userEvent.setup();
    vi.mocked(fetchT3Connection).mockResolvedValue({ connected: false });
    renderView(vi.fn());

    await user.click(screen.getByRole("button", { name: /New Project/u }));
    await waitFor(() => {
      expect(fetchT3Connection).toHaveBeenCalled();
    });
    expect(screen.queryByLabelText("Folder on T3 host")).not.toBeInTheDocument();
  });
});

describe("Multi-host project creation, detach/reattach, and error states (BIT-152)", () => {
  const HOSTS: T3HostConnectionStatus[] = [
    {
      id: "host-laptop",
      label: "Laptop",
      mcpUrl: "https://laptop.example.com/mcp",
      issuer: "https://laptop.example.com",
      connected: true,
      kind: "user",
      projectsRoot: "~/www",
      expiresAt: "2026-12-01T00:00:00.000Z",
      expiresInDays: 20,
      expiringSoon: false,
      expired: false,
      scope: "mcp:tools",
      connectedAt: TIMESTAMP,
    },
    {
      id: "host-server",
      label: "Build Server",
      mcpUrl: "https://server.example.com/mcp",
      issuer: "https://server.example.com",
      connected: true,
      kind: "container",
      projectsRoot: "/var/www",
      expiresAt: "2026-12-01T00:00:00.000Z",
      expiresInDays: 20,
      expiringSoon: false,
      expired: false,
      scope: "mcp:tools",
      connectedAt: TIMESTAMP,
    },
  ];

  it("picks a host, prefills <projects root>/<project-slug>, explains cloned repo requirement, and checks already-registered folders", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn<
      (input: CreateProjectInput, extras?: { hostFolderPath?: string; hostId?: string }) => Promise<void>
    >();
    onSubmit.mockResolvedValue(undefined);
    vi.mocked(checkT3HostFolder).mockResolvedValueOnce({
      workspaceRoot: "/var/www/website-redesign",
      mappedProjectId: "other-project-id",
    });

    render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={onSubmit} hostFolderEnabled hosts={HOSTS} />);

    // Explains that the repository must already be cloned on the host and Git cloning UI is deferred
    expect(
      screen.getByText(/The repository must already be cloned at an existing folder on the host/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/Git cloning from the web UI is deferred/u)).toBeInTheDocument();

    // Typing project name prefills <projects root>/<slug> for default host (~/www)
    await user.type(screen.getByLabelText(/Project Name/u), "Website Redesign");
    const folderInput = screen.getByLabelText("Folder on T3 host");
    expect(folderInput).toHaveValue("~/www/website-redesign");

    // Switching host updates prefilled path to that host's projectsRoot (/var/www)
    await user.selectOptions(screen.getByLabelText("T3 host"), "host-server");
    expect(folderInput).toHaveValue("/var/www/website-redesign");

    // Check folder shows already-registered conflict when mapped to another Bitig project
    await user.click(screen.getByRole("button", { name: "Check folder" }));
    expect(checkT3HostFolder).toHaveBeenCalledWith(
      "/var/www/website-redesign",
      undefined,
      "host-server",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /already registered in T3 and bound to another Bitig project/u,
    );

    // Submitting passes both hostFolderPath and hostId
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ name: "Website Redesign" }), {
      hostFolderPath: "/var/www/website-redesign",
      hostId: "host-server",
    });
  });

  it("blocks detaching or reattaching while sessions are running on the project", () => {
    render(
      <ProjectHostFolder
        project={PROJECT}
        mapping={{ ...MAPPING, hostId: "host-laptop", workspaceRoot: "~/www/website-redesign" }}
        hosts={HOSTS}
        activeSessionsCount={2}
        onMappingChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("project-bound-host-badge")).toHaveTextContent("Laptop");
    expect(screen.getByTestId("project-host-busy-notice")).toHaveTextContent(/2 T3 sessions are running/u);
    expect(screen.getByRole("button", { name: "Unregister folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reattach on another host" })).toBeDisabled();
  });

  it("lets an owner reattach a bound project onto another host and surfaces missing-folder / offline-host errors", async () => {
    const user = userEvent.setup();
    const onMappingChange = vi.fn();
    const reattachedMapping: T3ProjectMapping = {
      projectId: PROJECT.id,
      hostId: "host-server",
      t3ProjectId: "t3-proj-2",
      t3ProjectTitle: "Website Redesign",
      workspaceRoot: "/var/www/website-redesign",
      updatedAt: TIMESTAMP,
    };

    vi.mocked(registerT3HostFolder)
      .mockRejectedValueOnce(new T3ApiError(503, "Could not reach the T3 host."))
      .mockResolvedValueOnce({ mapping: reattachedMapping, created: false });

    render(
      <ProjectHostFolder
        project={PROJECT}
        mapping={{ ...MAPPING, hostId: "host-laptop", workspaceRoot: "~/www/website-redesign" }}
        hosts={HOSTS}
        activeSessionsCount={0}
        onMappingChange={onMappingChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reattach on another host" }));
    const targetHostSelect = screen.getByLabelText("Target T3 host");
    expect(targetHostSelect).toHaveValue("host-server");
    const folderInput = screen.getByLabelText("Folder on target host");
    expect(folderInput).toHaveValue("/var/www/website-redesign");

    // First attempt: offline host error
    await user.click(screen.getByRole("button", { name: "Reattach" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the T3 host.");

    // Second attempt: succeeds and reports already-registered folder linked (`created: false`)
    await user.click(screen.getByRole("button", { name: "Reattach" }));
    expect(registerT3HostFolder).toHaveBeenLastCalledWith(
      PROJECT.id,
      "/var/www/website-redesign",
      expect.any(AbortSignal),
      "host-server",
    );
    expect(onMappingChange).toHaveBeenCalledWith(reattachedMapping);
    expect(await screen.findByRole("status")).toHaveTextContent(
      /\/var\/www\/website-redesign was already registered in T3; linked it\./u,
    );
  });

  it("displays bound host on ProjectCard in ProjectsView", async () => {
    vi.mocked(fetchT3Hosts).mockResolvedValue(HOSTS);
    vi.mocked(fetchT3ProjectMappings).mockResolvedValue([
      {
        projectId: PROJECT.id,
        hostId: "host-laptop",
        t3ProjectId: "t3-proj-1",
        t3ProjectTitle: "Website Redesign",
        workspaceRoot: "~/www/website-redesign",
        updatedAt: TIMESTAMP,
      },
    ]);

    render(
      <ProjectsView
        projects={[PROJECT]}
        tasks={[]}
        isLoading={false}
        error={null}
        onCreateProject={vi.fn()}
        onUpdateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onSelectProject={vi.fn()}
        searchQuery=""
        agentRuns={[]}
        activeSessions={[]}
        hostFolderEnabled
      />,
    );

    const badge = await screen.findByTestId(`project-card-host-${PROJECT.id}`);
    expect(badge).toHaveTextContent("Laptop");
    expect(badge).toHaveTextContent("~/www/website-redesign");
  });
});
