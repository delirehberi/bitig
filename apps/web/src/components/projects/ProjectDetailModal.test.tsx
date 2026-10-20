import type { Project, Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectCard } from "./ProjectCard";
import { ProjectDetailModal } from "./ProjectDetailModal";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: " Manage **MCP** and web tasks",
  kind: "open_source",
  key: "BIT",
  resources: [{ type: "repository", label: "GitHub", url: "https://github.com/acme/bitig" }],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const TASKS: Task[] = [
  {
    id: "01940000-0000-7000-8000-000000000011",
    projectId: PROJECT.id,
    title: "Ship v1",
    description: "",
    status: "done",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
  {
    id: "01940000-0000-7000-8000-000000000012",
    projectId: PROJECT.id,
    title: "Approve release",
    description: "",
    status: "todo",
    needsHuman: "Sign off on changelog",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  },
];

describe("ProjectDetailModal", () => {
  it("renders nothing without a project", () => {
    render(
      <ProjectDetailModal
        project={null}
        tasks={TASKS}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onSelectTasks={vi.fn()}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows project details, Markdown description, links, and task summary", () => {
    render(
      <ProjectDetailModal
        project={PROJECT}
        tasks={TASKS}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onSelectTasks={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Bitig App" })).toBeInTheDocument();
    expect(screen.getByText("open source")).toBeInTheDocument();
    expect(screen.getAllByText("BIT").length).toBeGreaterThan(0);
    expect(screen.getByText("MCP")).toHaveProperty("tagName", "STRONG");
    expect(screen.getByRole("link", { name: "GitHub" })).toHaveAttribute("href", "https://github.com/acme/bitig");
    expect(screen.getByText(/1 task/i)).toBeInTheDocument();
  });

  it("invokes Edit, Delete, View tasks, and Close handlers", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onSelectTasks = vi.fn();

    render(
      <ProjectDetailModal
        project={PROJECT}
        tasks={TASKS}
        onClose={onClose}
        onEdit={onEdit}
        onDelete={onDelete}
        onSelectTasks={onSelectTasks}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledWith(PROJECT);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith(PROJECT);

    await user.click(screen.getByRole("button", { name: "View tasks" }));
    expect(onSelectTasks).toHaveBeenCalledWith(PROJECT.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("counts archived tasks as completed in ProjectCard and ProjectDetailModal", () => {
    const tasksWithArchived: Task[] = [
      ...TASKS,
      {
        id: "01940000-0000-7000-8000-000000000013",
        projectId: PROJECT.id,
        title: "Archived v0",
        description: "",
        status: "archived",
        isPublic: false,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];

    render(
      <>
        <ProjectCard
          project={PROJECT}
          tasks={tasksWithArchived}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onSelect={vi.fn()}
        />
        <ProjectDetailModal
          project={PROJECT}
          tasks={tasksWithArchived}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onSelectTasks={vi.fn()}
        />
      </>,
    );

    expect(
      screen.getByText(
        (_, node) => node?.tagName === "SPAN" && node.textContent === "2 / 3 tasks",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        (_, node) => node?.tagName === "SPAN" && node.textContent === "2 / 3 done (1 open)",
      ),
    ).toBeInTheDocument();
  });

  it("opens from the ProjectCard title button", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    render(
      <ProjectCard
        project={PROJECT}
        tasks={TASKS}
        onView={onView}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: PROJECT.name }));
    expect(onView).toHaveBeenCalledWith(PROJECT);
  });
});

