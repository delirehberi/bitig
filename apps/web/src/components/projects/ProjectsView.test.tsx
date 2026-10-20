import type { Project, Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
});
