import type { AgentRun, Project, Task } from "@bitig/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import { hrefFor, parseRoute } from "../../routing/router";
import { ProjectsView } from "./ProjectsView";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT_PAID: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha SaaS",
  description: "Paid product",
  kind: "paid",
  key: "ALP",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PROJECT_OSS: Project = {
  id: "01940000-0000-7000-8000-000000000002",
  name: "Beta CLI",
  description: "Open-source CLI",
  kind: "open_source",
  key: "BET",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PROJECT_PERSONAL: Project = {
  id: "01940000-0000-7000-8000-000000000003",
  name: "Gamma Notes",
  description: "Personal notes",
  kind: "personal",
  key: "GAM",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PROJECTS: Project[] = [PROJECT_PAID, PROJECT_OSS, PROJECT_PERSONAL];

const TASKS: Task[] = [
  {
    id: "01940000-0000-7000-8000-000000000011",
    projectId: PROJECT_PAID.id,
    title: "Configure billing",
    description: "",
    status: "todo",
    needsHuman: "Approve Stripe plan",
    number: 1,
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  {
    id: "01940000-0000-7000-8000-000000000012",
    projectId: PROJECT_OSS.id,
    title: "Publish npm package",
    description: "",
    status: "done",
    number: 2,
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
];

function renderProjectsView(searchQuery = "") {
  render(
    <ProjectsView
      projects={PROJECTS}
      tasks={TASKS}
      isLoading={false}
      error={null}
      onCreateProject={vi.fn()}
      onUpdateProject={vi.fn()}
      onDeleteProject={vi.fn()}
      onSelectProject={vi.fn()}
      searchQuery={searchQuery}
      agentRuns={[]}
    />,
  );
}

describe("ProjectsView filtering and detail modal", () => {
  it("filters projects by kind, task status, and Needs you", async () => {
    const user = userEvent.setup();
    renderProjectsView();

    expect(screen.getByRole("button", { name: "Alpha SaaS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta CLI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gamma Notes" })).toBeInTheDocument();

    // Filter by Kind: open_source
    await user.selectOptions(screen.getByLabelText(/kind:/i), "open_source");
    expect(screen.getByRole("button", { name: "Beta CLI" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alpha SaaS" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gamma Notes" })).not.toBeInTheDocument();

    // Reset Kind and filter by Tasks: No tasks
    await user.selectOptions(screen.getByLabelText(/kind:/i), "");
    await user.selectOptions(screen.getByLabelText(/tasks:/i), "empty");
    expect(screen.getByRole("button", { name: "Gamma Notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alpha SaaS" })).not.toBeInTheDocument();

    // Filter by Needs you
    await user.selectOptions(screen.getByLabelText(/tasks:/i), "");
    await user.click(screen.getByRole("button", { name: /needs you \(1\)/i }));
    expect(screen.getByRole("button", { name: "Alpha SaaS" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Beta CLI" })).not.toBeInTheDocument();
  });

  it("shows empty state with Clear filters when no project matches active filters", async () => {
    const user = userEvent.setup();
    renderProjectsView();

    await user.selectOptions(screen.getByLabelText(/kind:/i), "internal");
    expect(screen.getByText("No matching projects found")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("button", { name: "Alpha SaaS" })).toBeInTheDocument();
  });

  it("opens ProjectDetailModal when clicking a project name", async () => {
    const user = userEvent.setup();
    renderProjectsView();

    await user.click(screen.getByRole("button", { name: "Alpha SaaS" }));
    expect(screen.getByRole("dialog", { name: "Alpha SaaS" })).toBeInTheDocument();
  });

  it("opens the project's T3 message panel from the card's Message action (BIT-127)", async () => {
    const user = userEvent.setup();
    renderProjectsView();

    await user.click(screen.getByRole("button", { name: "Message Alpha SaaS in T3" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Alpha SaaS" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "Message T3 (no task)" })).toBeInTheDocument();
  });

  it("hides archived projects from the main view, archives active projects, and recovers archived projects", async () => {
    const user = userEvent.setup();
    const onUpdateProject = vi.fn().mockResolvedValue(PROJECT_PAID);
    const archivedProject: Project = {
      ...PROJECT_PERSONAL,
      archived: true,
      description: "Archived description that must stay hidden",
      resources: [{ type: "repository", label: "Old Repo", url: "https://github.com/acme/old" }],
    };

    render(
      <ProjectsView
        projects={[PROJECT_PAID, PROJECT_OSS, archivedProject]}
        tasks={TASKS}
        isLoading={false}
        error={null}
        onCreateProject={vi.fn()}
        onUpdateProject={onUpdateProject}
        onDeleteProject={vi.fn()}
        onSelectProject={vi.fn()}
        searchQuery=""
        agentRuns={[]}
      />,
    );

    // Active view shows active projects only
    expect(screen.getByRole("button", { name: "Alpha SaaS" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta CLI" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gamma Notes" })).not.toBeInTheDocument();

    // Archive an active project from its card button
    await user.click(screen.getByRole("button", { name: "Archive Alpha SaaS" }));
    expect(onUpdateProject).toHaveBeenCalledWith(PROJECT_PAID.id, { archived: true });

    // Navigate to Archived (1) view
    await user.click(screen.getByRole("button", { name: /archived \(1\)/i }));
    expect(screen.getByRole("heading", { level: 1, name: "Archived Projects" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gamma Notes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Alpha SaaS" })).not.toBeInTheDocument();

    // Archived project card omits description and resource links, and uses skinny hover-expanding layout
    expect(screen.queryByText("Archived description that must stay hidden")).not.toBeInTheDocument();
    expect(screen.queryByText("Old Repo")).not.toBeInTheDocument();
    const card = screen.getByRole("article");
    expect(card.className).toContain("w-4/5");
    expect(card.className).toContain("hover:w-full");

    // Recover the archived project
    await user.click(screen.getByRole("button", { name: "Recover Gamma Notes" }));
    expect(onUpdateProject).toHaveBeenCalledWith(archivedProject.id, { archived: false });

    // Return to active projects
    await user.click(screen.getByRole("button", { name: /back to projects/i }));
    expect(screen.getByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
  });

  it("parses and formats the /projects?archived=true route", () => {
    expect(parseRoute("/projects", "")).toEqual({ name: "projects" });
    expect(parseRoute("/projects", "?archived=true")).toEqual({ name: "projects", archived: true });
    expect(hrefFor({ name: "projects" })).toBe("/projects");
    expect(hrefFor({ name: "projects", archived: true })).toBe("/projects?archived=true");
    expect(parseRoute("/tasks", "?awaiting=approval")).toEqual({ name: "tasks", awaitingApproval: true });
    expect(hrefFor({ name: "tasks", awaitingApproval: true })).toBe("/tasks?awaiting=approval");
  });

  it("shows active T3 sessions (working and waiting_for_approval) on project cards and filters by T3 session state", async () => {
    const user = userEvent.setup();
    const runs: AgentRun[] = [
      {
        id: "01940000-0000-7000-8000-000000000091",
        taskId: "01940000-0000-7000-8000-000000000011",
        t3ProjectId: "t3-alpha",
        threadId: "thread-alpha-1",
        link: "<https://t3.example.test/threads/thread-alpha-1>",
        state: "waiting_for_approval",
        model: "claude-opus-4-7",
        startedAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      {
        id: "01940000-0000-7000-8000-000000000092",
        taskId: "01940000-0000-7000-8000-000000000012",
        t3ProjectId: "t3-beta",
        threadId: "thread-beta-1",
        state: "finished",
        startedAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    render(
      <ProjectsView
        projects={PROJECTS}
        tasks={TASKS}
        isLoading={false}
        error={null}
        onCreateProject={vi.fn()}
        onUpdateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onSelectProject={vi.fn()}
        searchQuery=""
        agentRuns={runs}
      />,
    );

    // Alpha SaaS shows its waiting T3 session with ticket code, title, model, and stripped link
    const alphaSessions = screen.getByTestId(`project-t3-sessions-${PROJECT_PAID.id}`);
    expect(within(alphaSessions).getByText("Active T3 session")).toBeInTheDocument();
    expect(within(alphaSessions).getByText("ALP-1")).toBeInTheDocument();
    expect(within(alphaSessions).getByText("Configure billing")).toBeInTheDocument();
    expect(within(alphaSessions).getByText(/waiting for approval · claude-opus-4-7/)).toBeInTheDocument();
    expect(within(alphaSessions).getByRole("link", { name: "Open ALP-1 in T3" })).toHaveAttribute(
      "href",
      "https://t3.example.test/threads/thread-alpha-1",
    );

    // Beta CLI has a finished run, so no active T3 session block is shown
    expect(screen.queryByTestId(`project-t3-sessions-${PROJECT_OSS.id}`)).not.toBeInTheDocument();

    // Filter by T3: Active in T3 (1)
    await user.selectOptions(screen.getByLabelText(/t3:/i), "active");
    expect(screen.getByRole("button", { name: "Alpha SaaS" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Beta CLI" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Gamma Notes" })).not.toBeInTheDocument();

    // Filter by T3: No active session (to pick an idle project to work on next)
    await user.selectOptions(screen.getByLabelText(/t3:/i), "idle");
    expect(screen.queryByRole("button", { name: "Alpha SaaS" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Beta CLI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gamma Notes" })).toBeInTheDocument();

    // Reset filter and open Alpha SaaS detail modal to verify active sessions appear there too
    await user.selectOptions(screen.getByLabelText(/t3:/i), "");
    await user.click(screen.getByRole("button", { name: "Alpha SaaS" }));
    const dialog = screen.getByRole("dialog", { name: "Alpha SaaS" });
    expect(within(dialog).getByText("Configure billing")).toBeInTheDocument();
    expect(within(dialog).getByText(/waiting for approval · claude-opus-4-7/)).toBeInTheDocument();
  });

  it("fetches /api/t3/runs on mount and updates live when agent_run.updated realtime events arrive", async () => {
    const initialRun: AgentRun = {
      id: "01940000-0000-7000-8000-000000000093",
      taskId: "01940000-0000-7000-8000-000000000011",
      t3ProjectId: "t3-alpha",
      threadId: "thread-alpha-live",
      state: "working",
      model: "gemini-4-argon",
      startedAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
    };

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(
          Response.json({
            runs: [initialRun],
            activeSessions: [
              {
                threadId: "thread-gamma-direct",
                projectId: PROJECT_PERSONAL.id,
                t3ProjectId: "t3-gamma",
                state: "working",
                title: "Ad-hoc Gamma session",
              },
            ],
          }),
        ),
      ),
    );

    render(
      <ProjectsView
        projects={PROJECTS}
        tasks={TASKS}
        isLoading={false}
        error={null}
        onCreateProject={vi.fn()}
        onUpdateProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onSelectProject={vi.fn()}
        searchQuery=""
      />,
    );

    const alphaSessions = await screen.findByTestId(`project-t3-sessions-${PROJECT_PAID.id}`);
    expect(within(alphaSessions).getByText(/working · gemini-4-argon/)).toBeInTheDocument();

    const gammaSessions = await screen.findByTestId(`project-t3-sessions-${PROJECT_PERSONAL.id}`);
    expect(within(gammaSessions).getByText("Ad-hoc Gamma session")).toBeInTheDocument();

    // Realtime event transitions Alpha's run to finished -> removes active session indicator
    act(() => {
      dispatchRealtimeEvent({
        type: "agent_run.updated",
        run: { ...initialRun, state: "finished" },
      });
    });

    expect(screen.queryByTestId(`project-t3-sessions-${PROJECT_PAID.id}`)).not.toBeInTheDocument();
  });
});
