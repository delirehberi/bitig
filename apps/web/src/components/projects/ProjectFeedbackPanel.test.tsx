import type { FeedbackFormSummary } from "@bitig/api-client";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectFeedbackPanel } from "./ProjectFeedbackPanel";

const storage = vi.hoisted(() => ({
  listFeedbackForms: vi.fn(),
  createFeedbackForm: vi.fn(),
  updateFeedbackForm: vi.fn(),
  deleteFeedbackForm: vi.fn(),
  rotateFeedbackFormPublicId: vi.fn(),
}));

vi.mock("../../hooks/useStorage", () => ({
  useApiStorage: () => storage,
}));

const PROJECT_ID = "01940000-0000-7000-8000-000000000001";
const FORM_ID = "01940000-0000-7000-8000-000000000005";
const PUBLIC_ID = "abcdefghijklmnopqrstu";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function makeForm(overrides: Partial<FeedbackFormSummary> = {}): FeedbackFormSummary {
  return {
    id: FORM_ID,
    orgId: "01940000-0000-7000-8000-000000000009",
    projectId: PROJECT_ID,
    publicId: PUBLIC_ID,
    name: "Bug reports",
    title: "Report a bug",
    intro: "",
    enabled: true,
    fields: { email: "optional", name: false, categories: [] },
    allowedOrigins: [],
    turnstile: true,
    thankYouText: "Thanks!",
    submissionCount: 4,
    lastSubmittedAt: TIMESTAMP,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    publicPath: `/f/${PUBLIC_ID}`,
    publicUrl: `https://bitig.example/f/${PUBLIC_ID}`,
    publicLink: `https://bitig.example/f/${PUBLIC_ID}`,
    pendingCount: 2,
    ...overrides,
  };
}

function setClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("ProjectFeedbackPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setClipboard(vi.fn(() => Promise.resolve()));
  });

  it("lists forms with their pending count and last submission", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    expect(await screen.findByText("Bug reports")).toBeInTheDocument();
    expect(screen.getByText("Accepting")).toBeInTheDocument();
    expect(screen.getByText(/2 pending/)).toBeInTheDocument();
    expect(screen.getByText(/4 submissions/)).toBeInTheDocument();
    expect(storage.listFeedbackForms).toHaveBeenCalledWith(PROJECT_ID, expect.anything());
  });

  it("shows an empty state when the project has no forms", async () => {
    storage.listFeedbackForms.mockResolvedValue([]);
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    expect(await screen.findByText("No feedback forms yet.")).toBeInTheDocument();
  });

  it("shows an alert when the forms cannot be loaded", async () => {
    storage.listFeedbackForms.mockRejectedValue(new Error("Network down"));
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Network down");
  });

  it("hides every management control from viewers but keeps copy and preview", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit={false} />);

    await screen.findByText("Bug reports");
    expect(screen.getByRole("button", { name: /copy link/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy iframe/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /copy script/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /preview/i })).toHaveAttribute("href", `https://bitig.example/f/${PUBLIC_ID}`);
    expect(screen.queryByRole("button", { name: /new form/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause|enable/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /rotate link/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it("copies the iframe snippet for the form", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard(writeText);
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit={false} />);

    await userEvent.click(await screen.findByRole("button", { name: /copy iframe/i }));

    expect(writeText).toHaveBeenCalledWith(expect.stringContaining(`src="https://bitig.example/f/${PUBLIC_ID}?embed=1"`));
    expect(await screen.findByRole("status")).toHaveTextContent("iframe snippet copied.");
  });

  it("reports a clipboard failure instead of hiding it", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    setClipboard(vi.fn(() => Promise.reject(new Error("Permission denied"))));
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit={false} />);

    await userEvent.click(await screen.findByRole("button", { name: /copy link/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Permission denied");
  });

  it("pauses an enabled form through the update call", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    storage.updateFeedbackForm.mockResolvedValue(makeForm({ enabled: false }));
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    expect(storage.updateFeedbackForm).toHaveBeenCalledWith(FORM_ID, { enabled: false });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
  });

  it("asks for confirmation before rotating the link", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    storage.rotateFeedbackFormPublicId.mockResolvedValue(makeForm({ publicId: "zyxwvutsrqponmlkjihgf" }));
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    await userEvent.click(await screen.findByRole("button", { name: /rotate link/i }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm link rotation" });
    expect(storage.rotateFeedbackFormPublicId).not.toHaveBeenCalled();

    await userEvent.click(within(dialog).getByRole("button", { name: "Rotate" }));
    expect(storage.rotateFeedbackFormPublicId).toHaveBeenCalledWith(FORM_ID);
    expect(await screen.findByRole("status")).toHaveTextContent("Link rotated.");
  });

  it("cancelling the delete confirmation keeps the form", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm delete" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(storage.deleteFeedbackForm).not.toHaveBeenCalled();
    expect(screen.getByText("Bug reports")).toBeInTheDocument();
  });

  it("removes the form after a confirmed delete", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    storage.deleteFeedbackForm.mockResolvedValue(undefined);
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    await userEvent.click(await screen.findByRole("button", { name: /^delete$/i }));
    const dialog = screen.getByRole("alertdialog", { name: "Confirm delete" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    expect(storage.deleteFeedbackForm).toHaveBeenCalledWith(FORM_ID);
    expect(await screen.findByText("No feedback forms yet.")).toBeInTheDocument();
  });

  it("shows a failed action without changing the form", async () => {
    storage.listFeedbackForms.mockResolvedValue([makeForm()]);
    storage.updateFeedbackForm.mockRejectedValue(new Error("Form is locked"));
    render(<ProjectFeedbackPanel projectId={PROJECT_ID} canEdit />);

    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Form is locked");
    expect(screen.getByText("Accepting")).toBeInTheDocument();
  });
});
