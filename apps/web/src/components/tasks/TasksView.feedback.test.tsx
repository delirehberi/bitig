import type { Project, Task } from "@bitig/core";
import type { TaskFeedbackClient } from "@bitig/api-client";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TasksView } from "./TasksView";

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
const FEEDBACK_ONE = "01940000-0000-7000-8000-000000000021";
const FEEDBACK_TWO = "01940000-0000-7000-8000-000000000022";
const ORDINARY = "01940000-0000-7000-8000-000000000023";

function task(id: string, title: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    projectId: PROJECT.id,
    title,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    pendingApproval: true,
    ...overrides,
  };
}

const TASKS: Task[] = [
  task(FEEDBACK_ONE, "Feedback one", { labels: ["feedback"], number: 1 }),
  task(FEEDBACK_TWO, "Feedback two", { labels: ["feedback"], number: 2 }),
  task(ORDINARY, "Agent proposal", { labels: ["ui"], number: 3 }),
];

function feedbackApi(): TaskFeedbackClient {
  return {
    getTaskFeedback: vi.fn(() => Promise.reject(new Error("unused"))),
    mergeTaskFeedback: vi.fn(() => Promise.reject(new Error("unused"))),
    rejectTaskFeedback: vi.fn((id: string) => Promise.resolve({ deletedTaskId: id })),
    markTaskFeedbackSpam: vi.fn((id: string) => Promise.resolve({ deletedTaskId: id })),
  };
}

function renderView(api: TaskFeedbackClient | undefined, awaitingApprovalOnly = true) {
  return render(
    <TasksView
      tasks={TASKS}
      projects={[PROJECT]}
      isLoading={false}
      error={null}
      selectedProjectId={undefined}
      onSelectProject={vi.fn()}
      awaitingApprovalOnly={awaitingApprovalOnly}
      onAwaitingApprovalOnlyChange={vi.fn()}
      onViewTaskChange={vi.fn()}
      onSaveTask={vi.fn()}
      onUpdateTask={vi.fn()}
      onCompleteTask={vi.fn()}
      onDeleteTask={vi.fn()}
      searchQuery=""
      feedbackApi={api}
    />,
  );
}

describe("TasksView feedback review", () => {
  it("offers a Feedback filter in the Awaiting approval view only", () => {
    const { unmount } = renderView(feedbackApi());
    expect(screen.getByRole("button", { name: /Feedback \(2\)/ })).toBeInTheDocument();
    unmount();

    renderView(feedbackApi(), false);
    expect(screen.queryByRole("button", { name: /Feedback \(/ })).not.toBeInTheDocument();
  });

  it("narrows the Awaiting approval view to feedback when the chip is pressed", async () => {
    const user = userEvent.setup();
    renderView(feedbackApi());

    await user.click(screen.getByRole("button", { name: /Feedback \(2\)/ }));

    expect(screen.getByRole("button", { name: /Feedback \(2\)/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByText("Feedback one").length).toBeGreaterThan(0);
    expect(screen.queryByText("Agent proposal")).not.toBeInTheDocument();
  });

  it("rejects the selected feedback in bulk and reports each removal", async () => {
    const user = userEvent.setup();
    const api = feedbackApi();
    renderView(api);

    const boxOne = screen.getAllByRole("checkbox", { name: "Select Feedback one for a bulk action" })[0];
    const boxTwo = screen.getAllByRole("checkbox", { name: "Select Feedback two for a bulk action" })[0];
    if (!boxOne || !boxTwo) throw new Error("feedback checkboxes not rendered");
    await user.click(boxOne);
    await user.click(boxTwo);

    const bar = screen.getByRole("region", { name: "Bulk feedback actions" });
    expect(within(bar).getByText("2 selected")).toBeInTheDocument();

    await user.click(within(bar).getByRole("button", { name: "Reject selected" }));

    await waitFor(() => {
      expect(api.rejectTaskFeedback).toHaveBeenCalledTimes(2);
    });
    expect(api.rejectTaskFeedback).toHaveBeenCalledWith(FEEDBACK_ONE);
    expect(api.rejectTaskFeedback).toHaveBeenCalledWith(FEEDBACK_TWO);
    expect(api.markTaskFeedbackSpam).not.toHaveBeenCalled();
  });

  it("does not show review actions when no feedback API is configured", () => {
    renderView(undefined);

    expect(screen.queryByRole("button", { name: "Merge" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: /bulk action/ })).not.toBeInTheDocument();
  });
});
