import type { Project } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectCard } from "./ProjectCard";
import { ProjectModal } from "./ProjectModal";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "",
  kind: "hobby",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  resources: [
    { type: "repository", label: "GitHub", url: "https://github.com/acme/bitig" },
    { type: "design", label: "Figma", url: "https://www.figma.com/design/abc" },
  ],
};

function renderModal(project: Project | null) {
  const onSubmit = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={onSubmit} project={project} />);
  return onSubmit;
}

describe("project resources", () => {
  it("links each resource from the card in a new tab", () => {
    render(
      <ProjectCard project={PROJECT} tasks={[]} onEdit={vi.fn()} onDelete={vi.fn()} onSelect={vi.fn()} />,
    );

    const link = screen.getByRole("link", { name: "GitHub" });
    expect(link).toHaveAttribute("href", "https://github.com/acme/bitig");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("link", { name: "Figma" })).toBeInTheDocument();
  });

  it("adds, edits, reorders and removes links in the form", async () => {
    const user = userEvent.setup();
    const onSubmit = renderModal(PROJECT);

    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.selectOptions(screen.getByLabelText("Link 3 type"), "issue_tracker");
    await user.type(screen.getByLabelText("Link 3 URL"), "https://acme.atlassian.net/browse/BIT");
    await user.clear(screen.getByLabelText("Link 1 label"));
    await user.type(screen.getByLabelText("Link 1 label"), "Code");
    await user.click(screen.getByRole("button", { name: "Move up: link 3" }));
    await user.click(screen.getByRole("button", { name: "Remove: Figma" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        resources: [
          { type: "repository", label: "Code", url: "https://github.com/acme/bitig" },
          // A blank label falls back to the host.
          { type: "issue_tracker", label: "acme.atlassian.net", url: "https://acme.atlassian.net/browse/BIT" },
        ],
      }),
    );
  });

  it("refuses links that are not web addresses", async () => {
    const user = userEvent.setup();
    const onSubmit = renderModal(null);

    await user.type(screen.getByLabelText(/project name/i), "New");
    await user.click(screen.getByRole("button", { name: "Add link" }));
    await user.type(screen.getByLabelText("Link 1 URL"), "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Create Project" }));

    expect(screen.getByRole("alert")).toHaveTextContent("must start with http:// or https://");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears links when every one is removed while editing", async () => {
    const user = userEvent.setup();
    const onEdit = renderModal(PROJECT);
    await user.click(screen.getByRole("button", { name: "Remove: GitHub" }));
    await user.click(screen.getByRole("button", { name: "Remove: Figma" }));
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ resources: [] }));
  });

  it("omits links when creating a project without any", async () => {
    const user = userEvent.setup();
    const onSubmit = renderModal(null);
    await user.type(screen.getByLabelText(/project name/i), "New");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("resources");
  });
});
