import type { Project, Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskCard } from "../tasks/TaskCard";
import { TaskList } from "../tasks/TaskList";
import { ProjectModal } from "./ProjectModal";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "",
  kind: "hobby",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  key: "BIT",
};

const TASK: Task = {
  id: "01940000-0000-7000-8000-000000000002",
  projectId: PROJECT.id,
  title: "Write documentation",
  description: "",
  status: "todo",
  isPublic: false,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  number: 12,
};

const noop = vi.fn();

function renderModal(project: Project | null) {
  const onSubmit = vi.fn<(input: unknown) => Promise<void>>().mockResolvedValue(undefined);
  render(<ProjectModal isOpen onClose={vi.fn()} onSubmit={onSubmit} project={project} />);
  return onSubmit;
}

describe("ticket codes in the dashboard", () => {
  it("shows the code on the board card and the list row", () => {
    render(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={TASK}
          projects={[PROJECT]}
          onView={noop}
          onEdit={noop}
          onDelete={noop}
          onComplete={noop}
          onStatusChange={noop}
        />
        <TaskList
          tasks={[TASK]}
          projects={[PROJECT]}
          onView={noop}
          onEdit={noop}
          onDelete={noop}
          onComplete={noop}
          onStatusChange={noop}
        />
      </FeatureFlagsProvider>,
    );
    expect(screen.getAllByText("BIT-12")).toHaveLength(2);
  });

  it("shows no code for a task without a number", () => {
    const legacy: Task = { ...TASK };
    delete legacy.number;
    render(
      <TaskList
        tasks={[legacy]}
        projects={[PROJECT]}
        onView={noop}
        onEdit={noop}
        onDelete={noop}
        onComplete={noop}
        onStatusChange={noop}
      />,
    );
    expect(screen.queryByTitle("Ticket code")).not.toBeInTheDocument();
  });

  it("sends a typed key uppercased and omits an empty one", async () => {
    const user = userEvent.setup();
    const onSubmit = renderModal(null);
    await user.type(screen.getByLabelText(/project name/i), "Website");
    expect(screen.getByLabelText("Key")).toHaveAttribute("placeholder", "WEB");
    await user.click(screen.getByRole("button", { name: "Create Project" }));
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("key");
  });

  it("sends a changed key and leaves an unchanged one out", async () => {
    const user = userEvent.setup();
    const onEdit = renderModal(PROJECT);
    const key = screen.getByLabelText("Key");
    expect(key).toHaveValue("BIT");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onEdit.mock.calls[0]?.[0]).not.toHaveProperty("key");

    await user.clear(key);
    await user.type(key, "app");
    await user.click(screen.getByRole("button", { name: "Save Changes" }));
    expect(onEdit.mock.calls[1]?.[0]).toMatchObject({ key: "APP" });
  });
});
