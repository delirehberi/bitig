import type { Project, Task } from "@bitig/core";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskBoard, type TaskMove } from "./TaskBoard";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "",
  kind: "hobby",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function task(n: number, order: number, status: Task["status"] = "todo"): Task {
  return {
    id: `01940000-0000-7000-8000-00000000001${String(n)}`,
    projectId: PROJECT.id,
    title: `Task ${String(n)}`,
    description: "",
    status,
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    order,
  };
}

const FIRST = task(1, 0);
const SECOND = task(2, 1);
const THIRD = task(3, 2);
const STARTED = task(4, 0, "in_progress");

function renderBoard(onMove: (moves: readonly TaskMove[]) => void, tasks: Task[] = [FIRST, SECOND, THIRD, STARTED]) {
  render(
    <FeatureFlagsProvider mode="cloudflare">
      <TaskBoard
        tasks={tasks}
        projects={[PROJECT]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
        onMove={onMove}
      />
    </FeatureFlagsProvider>,
  );
}

function summary(onMove: ReturnType<typeof vi.fn>) {
  const [moves] = onMove.mock.lastCall as [readonly TaskMove[]];
  return moves.map((m) => [m.task.title, m.patch]);
}

const dataTransfer = { setData: vi.fn(), dropEffect: "", effectAllowed: "" };

describe("TaskBoard reordering", () => {
  it("accepts a task into an empty Backlog and ignores external drops", () => {
    const onMove = vi.fn();
    renderBoard(onMove);
    const backlog = screen.getByTestId("column-backlog");
    fireEvent.drop(backlog, { dataTransfer });
    expect(onMove).not.toHaveBeenCalled();
    const card = screen.getByText(STARTED.title).closest("[data-task-id]");
    if (!card) throw new Error("source card not found");
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(backlog, { dataTransfer });
    fireEvent.drop(backlog, { dataTransfer });
    expect(summary(onMove)).toEqual([[STARTED.title, { status: "todo", pendingApproval: true, order: 0 }]]);
  });

  it("reorders within Backlog without changing approval or status", () => {
    const onMove = vi.fn();
    renderBoard(onMove, [{ ...FIRST, pendingApproval: true }, { ...SECOND, pendingApproval: true }]);
    const card = screen.getByText(FIRST.title).closest("[data-task-id]");
    if (!card) throw new Error("backlog card not found");
    const backlog = screen.getByTestId("column-backlog");
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.drop(backlog, { dataTransfer });
    expect(summary(onMove)).toEqual([[FIRST.title, { order: 2 }]]);
  });

  it.each(["todo", "in_progress", "done", "archived"] as const)("drops %s tasks into Backlog", (status) => {
    const onMove = vi.fn();
    const movedTask = task(4, 0, status);
    const backlogTask: Task = { ...FIRST, order: 2, pendingApproval: true };
    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard tasks={[backlogTask, movedTask]} projects={[PROJECT]}
          onView={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onComplete={vi.fn()}
          onStatusChange={vi.fn()} onMove={onMove} />
      </FeatureFlagsProvider>,
    );
    if (status === "archived") fireEvent.click(screen.getByTestId("toggle-archived-tasks"));
    const card = screen.getByText(movedTask.title).closest("[data-task-id]");
    if (!card) throw new Error("source card not found");
    const backlog = screen.getByTestId("column-backlog");
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(backlog, { dataTransfer });
    fireEvent.drop(backlog, { dataTransfer });
    expect(summary(onMove)).toEqual([[movedTask.title, { status: "todo", pendingApproval: true, order: 3 }]]);
  });

  it("offers a Backlog action on cards and hides it for existing Backlog tasks", () => {
    const onMoveToBacklog = vi.fn();
    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard tasks={[FIRST, { ...SECOND, pendingApproval: true }]} projects={[PROJECT]}
          onView={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} onComplete={vi.fn()}
          onStatusChange={vi.fn()} onMoveToBacklog={onMoveToBacklog} onMove={vi.fn()} />
      </FeatureFlagsProvider>,
    );
    expect(screen.getAllByRole("button", { name: "Move to Backlog" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Move to Backlog" }));
    expect(onMoveToBacklog).toHaveBeenCalledWith(FIRST);
  });

  it("keeps pending-approval tasks in Backlog and promotes them to Todo on drop", () => {
    const onMove = vi.fn();
    const backlogTask: Task = { ...FIRST, pendingApproval: true };
    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard
          tasks={[backlogTask]}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
          onMove={onMove}
        />
      </FeatureFlagsProvider>,
    );

    const backlog = screen.getByTestId("column-backlog");
    const todo = screen.getByTestId("column-todo");
    expect(within(backlog).getByText("Task 1")).toBeInTheDocument();
    expect(within(todo).queryByText("Task 1")).not.toBeInTheDocument();

    const card = within(backlog).getByText("Task 1").closest("[data-task-id]");
    if (!card) throw new Error("backlog card not found");
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(todo, { dataTransfer });
    fireEvent.drop(todo, { dataTransfer });

    expect(summary(onMove)).toEqual([
      ["Task 1", { status: "todo", pendingApproval: null, order: 0 }],
    ]);
  });

  it("moves a card down with the arrow keys on its handle", async () => {
    const onMove = vi.fn();
    renderBoard(onMove);
    screen.getByRole("button", { name: "Reorder Task 1" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(summary(onMove)).toEqual([["Task 1", { order: 1.5 }]]);
  });

  it("ignores moves past the ends of a column", async () => {
    const onMove = vi.fn();
    renderBoard(onMove);
    screen.getByRole("button", { name: "Reorder Task 1" }).focus();
    await userEvent.keyboard("{ArrowUp}");
    screen.getByRole("button", { name: "Reorder Task 3" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onMove).not.toHaveBeenCalled();
  });

  it("drops a card into another column with a new status and order", () => {
    const onMove = vi.fn();
    renderBoard(onMove);
    const card = screen.getByText("Task 2").closest("[data-task-id]");
    if (!card) throw new Error("card not found");
    const column = screen.getByTestId("column-in_progress");
    fireEvent.dragStart(card, { dataTransfer });
    fireEvent.dragOver(column, { dataTransfer });
    fireEvent.drop(column, { dataTransfer });
    expect(summary(onMove)).toEqual([["Task 2", { status: "in_progress", order: 1 }]]);
  });

  it("shows Archive all only when the Done column has tasks and archives every Done task", async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    const doneA = task(5, 0, "done");
    const doneB = task(6, 1, "done");

    const { rerender } = render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard
          tasks={[FIRST, STARTED]}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={onStatusChange}
          onMove={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.queryByRole("button", { name: "Archive all" })).not.toBeInTheDocument();

    rerender(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard
          tasks={[FIRST, STARTED, doneA, doneB]}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={onStatusChange}
          onMove={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );

    await user.click(screen.getByRole("button", { name: "Archive all" }));
    expect(onStatusChange).toHaveBeenCalledTimes(2);
    expect(onStatusChange).toHaveBeenNthCalledWith(1, doneA, "archived");
    expect(onStatusChange).toHaveBeenNthCalledWith(2, doneB, "archived");
  });

  it("displays the comment count badge in the card bottom bar only when commentCount > 0", () => {
    const withOneComment: Task = { ...FIRST, commentCount: 1 };
    const withThreeComments: Task = { ...SECOND, commentCount: 3 };
    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard
          tasks={[withOneComment, withThreeComments, THIRD]}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
          onMove={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByTitle("1 comment")).toHaveTextContent("1");
    expect(screen.getByTitle("3 comments")).toHaveTextContent("3");
    const thirdCard = screen.getByText("Task 3").closest("article");
    if (!thirdCard) throw new Error("expected Task 3 card");
    expect(thirdCard.querySelector('[title*="comment"]')).toBeNull();
  });

  it("hides the archived column by default and toggles it via the archive icon button", async () => {
    const user = userEvent.setup();
    const archivedTask = task(7, 0, "archived");
    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskBoard
          tasks={[FIRST, STARTED, archivedTask]}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
          onMove={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.queryByTestId("column-archived")).not.toBeInTheDocument();
    expect(screen.queryByText("Task 7")).not.toBeInTheDocument();

    const archiveToggle = screen.getByTestId("toggle-archived-tasks");
    expect(archiveToggle).toHaveAttribute("aria-label", "Archived tasks (1)");
    expect(archiveToggle).toHaveAttribute("aria-pressed", "false");

    await user.click(archiveToggle);
    expect(archiveToggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("column-archived")).toBeInTheDocument();
    expect(screen.getByText("Task 7")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hide archived tasks" }));
    expect(screen.queryByTestId("column-archived")).not.toBeInTheDocument();
  });
});
