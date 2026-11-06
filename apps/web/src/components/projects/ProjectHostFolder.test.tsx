import type { CreateProjectInput, Project, T3ConnectionStatus, T3ProjectMapping } from "@bitig/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { T3ApiError, fetchT3Connection, registerT3HostFolder, unregisterT3HostFolder } from "../../services/t3";
import { ProjectHostFolder } from "./ProjectHostFolder";
import { ProjectModal } from "./ProjectModal";
import { ProjectsView } from "./ProjectsView";

vi.mock("../../services/t3", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    fetchT3Connection: vi.fn(),
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
