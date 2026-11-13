import { useState } from "react";
import type { Project, Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackTaskControlsContext, type FeedbackTaskControls } from "./feedback-task-controls";
import { TaskCard } from "./TaskCard";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  description: "",
  kind: "hobby",
  key: "ALP",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function pendingTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "01940000-0000-7000-8000-000000000011",
    projectId: PROJECT.id,
    title: "Button is misaligned",
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    number: 3,
    pendingApproval: true,
    labels: ["feedback"],
    ...overrides,
  };
}

function handlers() {
  return {
    onView: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onComplete: vi.fn(),
    onStatusChange: vi.fn(),
  };
}

function controls(overrides: Partial<FeedbackTaskControls> = {}): FeedbackTaskControls {
  return {
    onMerge: vi.fn(),
    onReject: vi.fn(),
    onSpam: vi.fn(),
    selectedIds: new Set(),
    onToggleSelect: vi.fn(),
    ...overrides,
  };
}

function renderCard(task: Task, value: FeedbackTaskControls | null, onApprove = vi.fn()) {
  const base = handlers();
  return render(
    <FeedbackTaskControlsContext.Provider value={value}>
      <TaskCard task={task} projects={[PROJECT]} onApprove={onApprove} {...base} />
    </FeedbackTaskControlsContext.Provider>,
  );
}

describe("TaskCard feedback review", () => {
  it("shows a Feedback badge and Merge, Reject and Spam beside Approve in the Awaiting approval view", async () => {
    const user = userEvent.setup();
    const feedback = controls();
    renderCard(pendingTask(), feedback);

    expect(screen.getByText("Feedback")).toBeInTheDocument();
    const note = screen.getByRole("note", { name: "Awaiting approval" });
    expect(note).toHaveTextContent("Approve");

    await user.click(screen.getByRole("button", { name: "Merge" }));
    expect(feedback.onMerge).toHaveBeenCalledWith(expect.objectContaining({ id: pendingTask().id }));

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(feedback.onReject).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Spam" }));
    expect(feedback.onSpam).toHaveBeenCalledTimes(1);
  });

  it("replaces the default Reject with the feedback reject, so it never deletes the task directly", async () => {
    const user = userEvent.setup();
    const base = handlers();
    render(
      <FeedbackTaskControlsContext.Provider value={controls()}>
        <TaskCard task={pendingTask()} projects={[PROJECT]} onApprove={vi.fn()} {...base} />
      </FeedbackTaskControlsContext.Provider>,
    );

    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(base.onDelete).not.toHaveBeenCalled();
  });

  it("keeps the plain approval note for a feedback task outside the Awaiting approval view", async () => {
    const user = userEvent.setup();
    const base = handlers();
    render(
      <FeedbackTaskControlsContext.Provider value={null}>
        <TaskCard task={pendingTask()} projects={[PROJECT]} onApprove={vi.fn()} {...base} />
      </FeedbackTaskControlsContext.Provider>,
    );

    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(base.onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows no feedback actions on an ordinary pending task", () => {
    renderCard(pendingTask({ labels: ["ui"] }), controls());

    expect(screen.queryByText("Feedback")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("toggles bulk selection from the card checkbox", async () => {
    const user = userEvent.setup();
    const task = pendingTask();
    const feedback = controls();
    renderCard(task, feedback);

    await user.click(screen.getByRole("checkbox", { name: "Select Button is misaligned for a bulk action" }));
    expect(feedback.onToggleSelect).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }));
  });

  it("reflects the selected state from the controls", () => {
    function Harness() {
      const [selected] = useState<ReadonlySet<string>>(() => new Set([pendingTask().id]));
      return (
        <FeedbackTaskControlsContext.Provider value={controls({ selectedIds: selected })}>
          <TaskCard task={pendingTask()} projects={[PROJECT]} onApprove={vi.fn()} {...handlers()} />
        </FeedbackTaskControlsContext.Provider>
      );
    }
    render(<Harness />);

    expect(screen.getByRole("checkbox")).toBeChecked();
  });
});
