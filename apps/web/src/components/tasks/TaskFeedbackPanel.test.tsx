import { NotFoundError, type Task } from "@bitig/core";
import type { TaskFeedbackClient, TaskFeedbackDetail } from "@bitig/api-client";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskFeedbackPanel } from "./TaskFeedbackPanel";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const TASK: Task = {
  id: "01940000-0000-7000-8000-000000000011",
  projectId: "01940000-0000-7000-8000-000000000001",
  title: "Login is slow",
  description: "",
  status: "todo",
  isPublic: false,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  labels: ["feedback"],
  pendingApproval: true,
};

function detail(overrides: Partial<TaskFeedbackDetail> = {}): TaskFeedbackDetail {
  return {
    id: "01940000-0000-7000-8000-000000000013",
    taskId: TASK.id,
    formId: "01940000-0000-7000-8000-000000000005",
    orgId: "01940000-0000-7000-8000-000000000009",
    projectId: TASK.projectId,
    outcome: "pending",
    category: "Performance",
    submitterName: "Ada",
    submitterEmail: "ada@example.com",
    pageUrl: "https://example.com/login",
    spamScore: 0,
    createdAt: TIMESTAMP,
    form: { id: "01940000-0000-7000-8000-000000000005", name: "Bug reports", title: "Report", publicId: "abcdefghijklmnopqrstu" },
    submitter: { name: "Ada", email: "ada@example.com" },
    ...overrides,
  };
}

describe("TaskFeedbackPanel", () => {
  it("shows the form, category, submitter and page URL from the feedback entry", async () => {
    const getTaskFeedback = vi.fn<TaskFeedbackClient["getTaskFeedback"]>(() => Promise.resolve(detail()));
    render(<TaskFeedbackPanel task={TASK} feedbackApi={{ getTaskFeedback }} />);

    expect(await screen.findByText("Bug reports")).toBeInTheDocument();
    expect(screen.getByText("Performance")).toBeInTheDocument();
    expect(screen.getByText(/Ada/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "https://example.com/login" })).toHaveAttribute("href", "https://example.com/login");
    const [id, opts] = getTaskFeedback.mock.calls[0] ?? [];
    expect(id).toBe(TASK.id);
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it("does not link a page URL that is not http(s)", async () => {
    const feedbackApi = { getTaskFeedback: vi.fn(() => Promise.resolve(detail({ pageUrl: "javascript:alert(1)" }))) };
    render(<TaskFeedbackPanel task={TASK} feedbackApi={feedbackApi} />);

    expect(await screen.findByText("javascript:alert(1)")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("stays hidden when the task has no feedback entry", async () => {
    const feedbackApi = { getTaskFeedback: vi.fn(() => Promise.reject(new NotFoundError("feedback_entry", TASK.id))) };
    const { container } = render(<TaskFeedbackPanel task={TASK} feedbackApi={feedbackApi} />);

    await vi.waitFor(() => {
      expect(feedbackApi.getTaskFeedback).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows an alert when the details fail to load", async () => {
    const feedbackApi = { getTaskFeedback: vi.fn(() => Promise.reject(new Error("Network down"))) };
    render(<TaskFeedbackPanel task={TASK} feedbackApi={feedbackApi} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
  });
});
