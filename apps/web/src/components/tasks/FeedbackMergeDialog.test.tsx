import type { Project, Task } from "@bitig/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackMergeDialog } from "./FeedbackMergeDialog";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const ALPHA: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  description: "",
  kind: "hobby",
  key: "ALP",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};
const ZETA: Project = { ...ALPHA, id: "01940000-0000-7000-8000-000000000002", name: "Zeta", key: "ZET" };

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `01940000-0000-7000-8000-0000000001${id}`,
    projectId: ALPHA.id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    number: Number(id),
    ...overrides,
  };
}

const SOURCE = task("01", { pendingApproval: true, labels: ["feedback"], title: "Login is slow" });
const TARGET = task("02", { title: "Speed up login" });
const TASKS: Task[] = [
  SOURCE,
  TARGET,
  task("03", { title: "Other feedback", labels: ["feedback"], pendingApproval: true }),
  task("04", { title: "Archived idea", status: "archived" }),
  task("05", { title: "Elsewhere", projectId: ZETA.id }),
];

describe("FeedbackMergeDialog", () => {
  it("lists only open, non-feedback tasks from the feedback's own project", () => {
    render(
      <FeedbackMergeDialog source={SOURCE} tasks={TASKS} projects={[ALPHA, ZETA]} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );

    expect(screen.getByRole("button", { name: /Speed up login/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Other feedback/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Archived idea/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Elsewhere/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Login is slow/ })).not.toBeInTheDocument();
  });

  it("filters candidates by title", async () => {
    const user = userEvent.setup();
    render(
      <FeedbackMergeDialog source={SOURCE} tasks={TASKS} projects={[ALPHA, ZETA]} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );

    await user.type(screen.getByRole("searchbox"), "nothing matches");
    expect(screen.getByText("No tasks in this project match.")).toBeInTheDocument();
  });

  it("merges into the picked task, then closes", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    render(
      <FeedbackMergeDialog source={SOURCE} tasks={TASKS} projects={[ALPHA, ZETA]} onClose={onClose} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole("button", { name: /Speed up login/ }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ id: TARGET.id }));
    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the dialog open and shows the error when the merge fails", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onConfirm = vi.fn(() => Promise.reject(new Error("Target task was deleted")));
    render(
      <FeedbackMergeDialog source={SOURCE} tasks={TASKS} projects={[ALPHA, ZETA]} onClose={onClose} onConfirm={onConfirm} />,
    );

    await user.click(screen.getByRole("button", { name: /Speed up login/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Target task was deleted");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("renders nothing without a source", () => {
    const { container } = render(
      <FeedbackMergeDialog source={null} tasks={TASKS} projects={[ALPHA]} onClose={vi.fn()} onConfirm={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
