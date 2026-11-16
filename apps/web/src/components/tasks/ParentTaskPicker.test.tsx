import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Project, Task } from "@bitig/core";
import { ParentTaskPicker } from "./ParentTaskPicker";
import { TaskModal } from "./TaskModal";

const NOW = "2026-11-15T12:00:00.000Z";

const PROJ_A: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  key: "ALP",
  description: "",
  kind: "hobby",
  createdAt: NOW,
  updatedAt: NOW,
};

const PROJ_B: Project = {
  id: "01940000-0000-7000-8000-000000000002",
  name: "Beta",
  key: "BET",
  description: "",
  kind: "hobby",
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTask(id: string, projectId: string, number: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId,
    title: `Task ${String(number)}`,
    description: "",
    status: "todo",
    number,
    isPublic: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const ROOT = makeTask("01940000-0000-7000-8000-000000000010", PROJ_A.id, 1, { title: "Root umbrella" });
const MID = makeTask("01940000-0000-7000-8000-000000000011", PROJ_A.id, 2, {
  title: "Mid task",
  parentId: ROOT.id,
});
const GRANDCHILD = makeTask("01940000-0000-7000-8000-000000000012", PROJ_A.id, 3, {
  title: "Grandchild task",
  parentId: MID.id,
});
const ARCHIVED_A = makeTask("01940000-0000-7000-8000-000000000013", PROJ_A.id, 4, {
  title: "Archived parent",
  status: "archived",
});
const FOREIGN_B = makeTask("01940000-0000-7000-8000-000000000014", PROJ_B.id, 1, {
  title: "Beta parent",
});

const ALL_TASKS = [ROOT, MID, GRANDCHILD, ARCHIVED_A, FOREIGN_B];

describe("ParentTaskPicker and TaskModal hierarchy editing (#BIT-195)", () => {
  it("filters out other-project, self, descendant, and archived candidates", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <ParentTaskPicker
        value=""
        onChange={onChange}
        projectId={PROJ_A.id}
        tasks={ALL_TASKS}
        projects={[PROJ_A, PROJ_B]}
        excludeId={ROOT.id}
      />,
    );

    const search = screen.getByLabelText("Find a parent task");
    await user.type(search, "task");
    expect(screen.getByText("No matching same-project tasks")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "Beta");
    expect(screen.getByText("No matching same-project tasks")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "Archived");
    expect(screen.getByText("No matching same-project tasks")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "ALP");
    expect(screen.getByText("No matching same-project tasks")).toBeInTheDocument();
  });

  it("allows selecting and clearing a same-project parent in TaskModal", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    const { rerender } = render(
      <TaskModal
        isOpen
        onClose={vi.fn()}
        onSubmit={onSubmit}
        projects={[PROJ_A, PROJ_B]}
        defaultProjectId={PROJ_A.id}
        tasks={ALL_TASKS}
      />,
    );

    await user.type(screen.getByLabelText(/Title/i), "New child task");
    await user.type(screen.getByLabelText("Find a parent task"), "Root umbrella");
    await user.click(screen.getByRole("button", { name: /ALP-1\s*Root umbrella/i }));
    expect(screen.getByLabelText("Chosen parent task")).toHaveTextContent("ALP-1");

    await user.click(screen.getByRole("button", { name: "Create Task" }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJ_A.id,
        title: "New child task",
        parentId: ROOT.id,
      }),
    );

    // Editing MID and detaching its parent omits parentId so caller sends parentId: null
    onSubmit.mockClear();
    rerender(
      <TaskModal
        key="edit-mid"
        isOpen
        task={MID}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        projects={[PROJ_A, PROJ_B]}
        tasks={ALL_TASKS}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Remove parent ALP-1" }));
    expect(screen.queryByLabelText("Chosen parent task")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    const submittedPayload = onSubmit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(submittedPayload.parentId).toBeUndefined();
  });

  it("shows server guard error inline when reparenting is refused", async () => {
    const user = userEvent.setup();
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new Error("Cannot change parentId while child session is active."));

    render(
      <TaskModal
        isOpen
        task={MID}
        onClose={vi.fn()}
        onSubmit={onSubmit}
        projects={[PROJ_A, PROJ_B]}
        tasks={ALL_TASKS}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Remove parent ALP-1" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/Cannot change parentId/);
  });
});
