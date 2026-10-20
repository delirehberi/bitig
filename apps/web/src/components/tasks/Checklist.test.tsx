import type { ChecklistItem, Project, Task } from "@bitig/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskCard } from "./TaskCard";
import { TaskDetailModal } from "./TaskDetailModal";
import { TaskModal } from "./TaskModal";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "",
  kind: "hobby",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const TASK: Task = {
  id: "01940000-0000-7000-8000-000000000002",
  projectId: PROJECT.id,
  title: "Release",
  description: "",
  status: "todo",
  isPublic: false,
  checklist: [
    { text: "Write notes", done: true },
    { text: "Tag", done: false },
  ],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function renderTaskModal(task: Task | null) {
  const onSubmit = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  render(
    <FeatureFlagsProvider mode="local">
      <TaskModal isOpen onClose={vi.fn()} onSubmit={onSubmit} task={task} projects={[PROJECT]} />
    </FeatureFlagsProvider>,
  );
  return onSubmit;
}

describe("task checklist", () => {
  it("shows progress on the card", () => {
    render(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={TASK}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTitle("1 of 2 subtasks done")).toHaveTextContent("1/2");
  });

  function renderDetail(onChecklistChange: (task: Task, checklist: unknown) => Promise<unknown>) {
    render(
      <FeatureFlagsProvider mode="local">
        <TaskDetailModal
          task={TASK}
          projects={[PROJECT]}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onChecklistChange={onChecklistChange}
        />
      </FeatureFlagsProvider>,
    );
  }

  it("toggles an item from the detail view and shows it before the save finishes", async () => {
    const user = userEvent.setup();
    const onChecklistChange = vi.fn(() => new Promise<never>(() => undefined));
    renderDetail(onChecklistChange);

    await user.click(screen.getByLabelText("Tag"));
    expect(onChecklistChange).toHaveBeenCalledWith(TASK, [
      { text: "Write notes", done: true },
      { text: "Tag", done: true },
    ]);
    expect(screen.getByLabelText("Tag")).toBeChecked();
    expect(screen.getByTitle("2 of 2 subtasks done")).toBeInTheDocument();
  });

  it("starts a subtask and displays subtask timing durations", async () => {
    const user = userEvent.setup();
    const taskWithTimedSubtasks: Task = {
      ...TASK,
      checklist: [
        {
          text: "Write notes",
          done: true,
          startedAt: "2026-01-01T10:00:00.000Z",
          completedAt: "2026-01-01T10:45:00.000Z",
        },
        { text: "Tag", done: false },
      ],
    };
    const onChecklistChange = vi.fn<(_task: Task, _checklist: ChecklistItem[]) => Promise<void>>(() =>
      Promise.resolve(),
    );
    render(
      <FeatureFlagsProvider mode="local">
        <TaskDetailModal
          task={taskWithTimedSubtasks}
          projects={[PROJECT]}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onChecklistChange={onChecklistChange}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByTitle("Time spent on subtask")).toHaveTextContent("45m");

    await user.click(screen.getByRole("button", { name: "Start subtask: Tag" }));
    expect(onChecklistChange).toHaveBeenCalledTimes(1);
    const updatedChecklist = onChecklistChange.mock.calls[0]?.[1];
    expect(updatedChecklist?.[1]?.text).toBe("Tag");
    expect(typeof updatedChecklist?.[1]?.startedAt).toBe("string");
  });

  it("reverts a toggle whose save fails", async () => {
    const user = userEvent.setup();
    renderDetail(vi.fn(() => Promise.reject(new Error("offline"))));

    await user.click(screen.getByLabelText("Tag"));
    await waitFor(() => {
      expect(screen.getByLabelText("Tag")).not.toBeChecked();
    });
  });

  it("shows subtasks section and allows adding subtasks in the detail view even when starting empty", async () => {
    const user = userEvent.setup();
    const taskWithoutChecklist: Task = {
      id: TASK.id,
      projectId: TASK.projectId,
      title: TASK.title,
      description: TASK.description,
      status: TASK.status,
      isPublic: TASK.isPublic,
      createdAt: TASK.createdAt,
      updatedAt: TASK.updatedAt,
    };
    const onChecklistChange = vi.fn(() => new Promise<never>(() => undefined));
    render(
      <FeatureFlagsProvider mode="local">
        <TaskDetailModal
          task={taskWithoutChecklist}
          projects={[PROJECT]}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onChecklistChange={onChecklistChange}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByText("No subtasks")).toBeInTheDocument();
    await user.type(screen.getByLabelText("New subtask"), "Publish package");
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(onChecklistChange).toHaveBeenCalledWith(taskWithoutChecklist, [
      { text: "Publish package", done: false },
    ]);
    expect(screen.getByLabelText("Publish package")).not.toBeChecked();
    expect(screen.getByLabelText("New subtask")).toHaveValue("");
  });

  it("adds, checks, renames, reorders and removes items in the form", async () => {
    const user = userEvent.setup();
    const onSubmit = renderTaskModal(TASK);

    await user.type(screen.getByLabelText("New subtask"), "Announce{Enter}");
    await user.click(screen.getByLabelText("Done: Tag"));
    await user.clear(screen.getByLabelText("Subtask 1"));
    await user.type(screen.getByLabelText("Subtask 1"), "Write changelog");
    await user.click(screen.getByRole("button", { name: "Move up: Announce" }));
    await user.click(screen.getByRole("button", { name: "Remove: Tag" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        checklist: [
          { text: "Write changelog", done: true },
          { text: "Announce", done: false },
        ],
      }),
    );
  });

  it("clears the checklist when every item is removed while editing", async () => {
    const user = userEvent.setup();
    const onSubmit = renderTaskModal(TASK);

    await user.click(screen.getByRole("button", { name: "Remove: Tag" }));
    await user.click(screen.getByRole("button", { name: "Remove: Write notes" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ checklist: [] }));
  });

  it("omits the checklist when creating a task without items", async () => {
    const user = userEvent.setup();
    const onSubmit = renderTaskModal(null);

    await user.type(screen.getByLabelText(/title/i), "New task");
    await user.click(screen.getByRole("button", { name: "Create Task" }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("checklist");
  });
});
