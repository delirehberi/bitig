import type { FeedbackFormSummary } from "@bitig/api-client";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackFormDialog } from "./FeedbackFormDialog";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const EXISTING: FeedbackFormSummary = {
  id: "01940000-0000-7000-8000-000000000005",
  orgId: "01940000-0000-7000-8000-000000000009",
  projectId: "01940000-0000-7000-8000-000000000001",
  publicId: "abcdefghijklmnopqrstu",
  name: "Bug reports",
  title: "Report a bug",
  intro: "",
  enabled: true,
  fields: { email: "optional", name: false, categories: ["Bug"] },
  allowedOrigins: [],
  turnstile: true,
  thankYouText: "Thanks!",
  submissionCount: 0,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  publicPath: "/f/abcdefghijklmnopqrstu",
  publicUrl: "https://bitig.example/f/abcdefghijklmnopqrstu",
  publicLink: "https://bitig.example/f/abcdefghijklmnopqrstu",
  pendingCount: 0,
};

describe("FeedbackFormDialog", () => {
  it("opens empty in create mode with the server defaults", () => {
    render(<FeedbackFormDialog editing={null} onClose={vi.fn()} onSave={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "New feedback form" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByLabelText("Require Turnstile check")).toBeChecked();
    expect(screen.getByLabelText("Email")).toHaveValue("optional");
  });

  it("requires a name and does not save without one", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<FeedbackFormDialog editing={null} onClose={vi.fn()} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Save form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a name for the form.");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("saves the draft built from the inputs", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    render(<FeedbackFormDialog editing={null} onClose={vi.fn()} onSave={onSave} />);

    await userEvent.type(screen.getByLabelText("Name"), "Ideas");
    await userEvent.click(screen.getByRole("button", { name: "Save form" }));

    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ name: "Ideas", enabled: true, turnstile: true }));
  });

  it("prefills the form when editing an existing one", () => {
    render(<FeedbackFormDialog editing={EXISTING} onClose={vi.fn()} onSave={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Edit feedback form" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("Bug reports");
    expect(screen.getByLabelText(/Category options/)).toHaveValue("Bug");
    expect(screen.getByLabelText("Require Turnstile check")).toBeChecked();
  });

  it("keeps the dialog open and shows the message when saving fails", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(() => Promise.reject(new Error("Accent colour must be a hex colour")));
    render(<FeedbackFormDialog editing={EXISTING} onClose={onClose} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Save form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Accent colour must be a hex colour");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save form" })).toBeEnabled();
  });

  it("closes from the cancel button without saving", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(() => Promise.resolve());
    render(<FeedbackFormDialog editing={null} onClose={onClose} onSave={onSave} />);

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });
});
