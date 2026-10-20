import type { Project, Task } from "@bitig/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TaskList } from "./TaskList";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT_ALPHA: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  description: "",
  kind: "hobby",
  key: "ALP",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const PROJECT_ZETA: Project = {
  id: "01940000-0000-7000-8000-000000000002",
  name: "Zeta",
  description: "",
  kind: "open_source",
  key: "ZET",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const TASKS: Task[] = [
  {
    id: "01940000-0000-7000-8000-000000000011",
    projectId: PROJECT_ZETA.id,
    title: "Charlie task",
    description: "",
    status: "done",
    priority: "urgent",
    dueDate: "2026-12-01",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    order: 0,
    number: 1,
  },
  {
    id: "01940000-0000-7000-8000-000000000012",
    projectId: PROJECT_ALPHA.id,
    title: "alpha task",
    description: "",
    status: "todo",
    priority: "low",
    dueDate: "2026-05-10",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    order: 1,
    number: 1,
  },
  {
    id: "01940000-0000-7000-8000-000000000013",
    projectId: PROJECT_ALPHA.id,
    title: "Bravo task",
    description: "",
    status: "in_progress",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    order: 2,
    number: 2,
  },
];

function renderTaskList(showProject = true) {
  render(
    <TaskList
      tasks={TASKS}
      projects={[PROJECT_ALPHA, PROJECT_ZETA]}
      showProject={showProject}
      onView={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onComplete={vi.fn()}
      onStatusChange={vi.fn()}
    />,
  );
}

function rowTitles(): string[] {
  const rows = screen.getAllByRole("row").slice(1);
  return rows.map((row) => {
    const button = within(row).getByTitle("View task details");
    return button.textContent;
  });
}

describe("TaskList sorting and project column visibility", () => {
  it("keeps initial order before any column header is clicked", () => {
    renderTaskList();
    expect(rowTitles()).toEqual(["Charlie task", "alpha task", "Bravo task"]);
  });

  it("sorts by Title ascending on first click and descending on second click", async () => {
    const user = userEvent.setup();
    renderTaskList();

    const titleHeader = screen.getByRole("columnheader", { name: "Title" });
    expect(titleHeader).toHaveAttribute("aria-sort", "none");

    await user.click(within(titleHeader).getByRole("button", { name: "Title" }));
    expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowTitles()).toEqual(["alpha task", "Bravo task", "Charlie task"]);

    await user.click(within(titleHeader).getByRole("button", { name: "Title" }));
    expect(titleHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowTitles()).toEqual(["Charlie task", "Bravo task", "alpha task"]);
  });

  it("sorts by Project name ascending and descending", async () => {
    const user = userEvent.setup();
    renderTaskList();

    const projectHeader = screen.getByRole("columnheader", { name: "Project" });
    await user.click(within(projectHeader).getByRole("button", { name: "Project" }));
    expect(projectHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowTitles()).toEqual(["alpha task", "Bravo task", "Charlie task"]);

    await user.click(within(projectHeader).getByRole("button", { name: "Project" }));
    expect(projectHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowTitles()).toEqual(["Charlie task", "alpha task", "Bravo task"]);
  });

  it("sorts by Status in workflow order", async () => {
    const user = userEvent.setup();
    renderTaskList();

    const statusHeader = screen.getByRole("columnheader", { name: "Status" });
    await user.click(within(statusHeader).getByRole("button", { name: "Status" }));
    expect(statusHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowTitles()).toEqual(["alpha task", "Bravo task", "Charlie task"]);

    await user.click(within(statusHeader).getByRole("button", { name: "Status" }));
    expect(statusHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowTitles()).toEqual(["Charlie task", "Bravo task", "alpha task"]);
  });

  it("sorts by Priority with unset priorities last", async () => {
    const user = userEvent.setup();
    renderTaskList();

    const priorityHeader = screen.getByRole("columnheader", { name: "Priority" });
    await user.click(within(priorityHeader).getByRole("button", { name: "Priority" }));
    expect(priorityHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowTitles()).toEqual(["alpha task", "Charlie task", "Bravo task"]);

    await user.click(within(priorityHeader).getByRole("button", { name: "Priority" }));
    expect(priorityHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowTitles()).toEqual(["Charlie task", "alpha task", "Bravo task"]);
  });

  it("sorts by Due Date with unset due dates last", async () => {
    const user = userEvent.setup();
    renderTaskList();

    const dueHeader = screen.getByRole("columnheader", { name: "Due Date" });
    await user.click(within(dueHeader).getByRole("button", { name: "Due Date" }));
    expect(dueHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowTitles()).toEqual(["alpha task", "Charlie task", "Bravo task"]);

    await user.click(within(dueHeader).getByRole("button", { name: "Due Date" }));
    expect(dueHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowTitles()).toEqual(["Charlie task", "alpha task", "Bravo task"]);
  });

  it("hides the Project column when showProject is false", () => {
    renderTaskList(false);
    expect(screen.queryByRole("columnheader", { name: "Project" })).not.toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.queryByText("Zeta")).not.toBeInTheDocument();
  });

  it("shows the agent's question next to the Needs you flag in list rows", () => {
    const firstTask = TASKS[0];
    if (!firstTask) throw new Error("expected first task");
    render(
      <TaskList
        tasks={[{ ...firstTask, needsHuman: "Which region should we deploy to?" }]}
        projects={[PROJECT_ALPHA, PROJECT_ZETA]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Needs you: Which region should we deploy to?")).toBeInTheDocument();
  });

  it("renders the comment count badge in task rows when commentCount > 0", () => {
    const firstTask = TASKS[0];
    const secondTask = TASKS[1];
    if (!firstTask || !secondTask) throw new Error("expected tasks");
    render(
      <TaskList
        tasks={[{ ...firstTask, commentCount: 2 }, secondTask]}
        projects={[PROJECT_ALPHA, PROJECT_ZETA]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(screen.getByTitle("2 comments")).toHaveTextContent("2");
    expect(screen.queryByTitle(/1 comment/)).not.toBeInTheDocument();
  });

  it("excludes archived tasks from the table view", () => {
    const firstTask = TASKS[0];
    const secondTask = TASKS[1];
    if (!firstTask || !secondTask) throw new Error("expected tasks");
    const archivedTask: Task = {
      ...secondTask,
      id: "01940000-0000-7000-8000-000000000099",
      title: "Hidden archived task",
      status: "archived",
    };

    const { rerender } = render(
      <TaskList
        tasks={[firstTask, archivedTask]}
        projects={[PROJECT_ALPHA, PROJECT_ZETA]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    expect(screen.getByText("Charlie task")).toBeInTheDocument();
    expect(screen.queryByText("Hidden archived task")).not.toBeInTheDocument();

    // When only archived tasks are passed, renders the empty state
    rerender(
      <TaskList
        tasks={[archivedTask]}
        projects={[PROJECT_ALPHA, PROJECT_ZETA]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    expect(screen.getByText("No tasks found")).toBeInTheDocument();
    expect(screen.queryByText("Hidden archived task")).not.toBeInTheDocument();
  });
});

