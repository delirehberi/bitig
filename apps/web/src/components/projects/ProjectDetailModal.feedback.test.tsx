import type { Project } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectDetailModal } from "./ProjectDetailModal";

vi.mock("./ProjectFeedbackPanel", () => ({
  ProjectFeedbackPanel: ({ canEdit }: { readonly canEdit: boolean }) => (
    <div data-testid="feedback-panel">{canEdit ? "editor" : "viewer"}</div>
  ),
}));

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "Manage tasks",
  kind: "open_source",
  key: "BIT",
  resources: [],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function renderModal(props: { feedbackFormsEnabled?: boolean; canEditFeedbackForms?: boolean }) {
  return render(
    <ProjectDetailModal
      project={PROJECT}
      tasks={[]}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onSelectTasks={vi.fn()}
      {...props}
    />,
  );
}

describe("ProjectDetailModal feedback tab", () => {
  it("has no tab strip when feedback forms are disabled (local mode)", () => {
    renderModal({ feedbackFormsEnabled: false });

    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Feedback" })).not.toBeInTheDocument();
  });

  it("switches to the feedback panel and back to the details", async () => {
    renderModal({ feedbackFormsEnabled: true, canEditFeedbackForms: true });

    expect(screen.getByRole("tab", { name: "Details", selected: true })).toBeInTheDocument();
    expect(screen.getByText("Manage tasks")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));

    expect(screen.getByRole("tab", { name: "Feedback", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("feedback-panel")).toHaveTextContent("editor");
    expect(screen.queryByText("Manage tasks")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: "Details" }));

    expect(screen.getByText("Manage tasks")).toBeInTheDocument();
    expect(screen.queryByTestId("feedback-panel")).not.toBeInTheDocument();
  });

  it("passes read-only access to the panel for viewers", async () => {
    renderModal({ feedbackFormsEnabled: true, canEditFeedbackForms: false });

    await userEvent.click(screen.getByRole("tab", { name: "Feedback" }));

    expect(screen.getByTestId("feedback-panel")).toHaveTextContent("viewer");
  });
});
