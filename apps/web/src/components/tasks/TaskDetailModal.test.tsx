import type { Project, StorageMode, Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskCard } from "./TaskCard";
import { TaskDetailModal } from "./TaskDetailModal";
import { TaskList } from "./TaskList";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig App",
  description: "",
  kind: "hobby",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const TASK: Task = {
  id: "01940000-0000-7000-8000-000000000002",
  projectId: PROJECT.id,
  title: "Write documentation",
  description: "Cover the REST API",
  status: "in_progress",
  priority: "high",
  dueDate: "2026-02-01",
  labels: ["docs", "api"],
  isPublic: false,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function renderModal(task: Task | null = TASK, mode: StorageMode = "local") {
  const handlers = {
    onClose: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onComplete: vi.fn(),
  };
  render(
    <FeatureFlagsProvider mode={mode}>
      <TaskDetailModal task={task} projects={[PROJECT]} {...handlers} />
    </FeatureFlagsProvider>,
  );
  return handlers;
}

describe("TaskDetailModal", () => {
  it("renders nothing without a task", () => {
    renderModal(null);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows the task details", () => {
    renderModal();

    expect(screen.getByRole("dialog", { name: "Write documentation" })).toBeInTheDocument();
    expect(screen.getByText("Cover the REST API")).toBeInTheDocument();
    expect(screen.getByText("Bitig App")).toBeInTheDocument();
    expect(screen.getByText("In Progress")).toBeInTheDocument();
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("2026-02-01")).toBeInTheDocument();
    expect(screen.getByText("#docs")).toBeInTheDocument();
    expect(screen.getByText("#api")).toBeInTheDocument();
  });

  it("shows visibility only in nostr mode", () => {
    renderModal(TASK, "nostr");
    expect(screen.getByText(/private \(nip-44 encrypted\)/i)).toBeInTheDocument();
  });

  it("hides visibility outside nostr mode", () => {
    renderModal(TASK, "cloudflare");
    expect(screen.queryByText(/nip-44/i)).not.toBeInTheDocument();
  });

  it("hides Complete for done tasks", () => {
    renderModal({ ...TASK, status: "done" });
    expect(screen.queryByRole("button", { name: /complete/i })).not.toBeInTheDocument();
  });

  it("invokes the action handlers", async () => {
    const user = userEvent.setup();
    const handlers = renderModal();

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("button", { name: "Complete" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(handlers.onEdit).toHaveBeenCalledWith(TASK);
    expect(handlers.onComplete).toHaveBeenCalledWith(TASK);
    expect(handlers.onDelete).toHaveBeenCalledWith(TASK);
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape, the close button and the backdrop but not on content clicks", async () => {
    const user = userEvent.setup();
    const handlers = renderModal();

    await user.click(screen.getByText("Cover the REST API"));
    expect(handlers.onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(handlers.onClose).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole("dialog"));
    expect(handlers.onClose).toHaveBeenCalledTimes(3);
  });
});

/** Opens the modal from a button, the way the board and list titles do, and closes it on every action. */
function ModalHarness({ task }: { readonly task: Task }) {
  const [open, setOpen] = useState<Task | null>(null);
  const close = () => {
    setOpen(null);
  };
  return (
    <FeatureFlagsProvider mode="local">
      <button
        type="button"
        onClick={() => {
          setOpen(task);
        }}
      >
        Open task
      </button>
      <TaskDetailModal
        task={open}
        projects={[PROJECT]}
        onClose={close}
        onEdit={close}
        onDelete={close}
        onComplete={(t) => {
          setOpen({ ...t, status: "done" });
        }}
      />
    </FeatureFlagsProvider>
  );
}

describe("TaskDetailModal focus", () => {
  async function openFromButton() {
    const user = userEvent.setup();
    render(<ModalHarness task={TASK} />);
    const opener = screen.getByRole("button", { name: "Open task" });
    await user.click(opener);
    return { user, opener };
  }

  it("moves focus into the dialog when it opens", async () => {
    await openFromButton();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });

  it("wraps Tab and Shift+Tab inside the dialog", async () => {
    const { user } = await openFromButton();
    const close = screen.getByRole("button", { name: "Close dialog" });
    const edit = screen.getByRole("button", { name: "Edit" });

    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(edit).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    // Walking forward through every control never leaves the dialog
    const dialog = screen.getByRole("dialog");
    for (let i = 0; i < 6; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
    }
  });

  it("keeps Tab inside after Complete removes the focused button", async () => {
    const { user } = await openFromButton();
    await user.click(screen.getByRole("button", { name: "Complete" }));
    expect(screen.queryByRole("button", { name: "Complete" })).not.toBeInTheDocument();

    await user.tab();
    expect(screen.getByRole("button", { name: "Close dialog" })).toHaveFocus();
  });

  it.each([
    ["Escape", (user: ReturnType<typeof userEvent.setup>) => user.keyboard("{Escape}")],
    ["the close button", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Close dialog" }))],
    ["the backdrop", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("dialog"))],
    ["Edit", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Edit" }))],
    ["Delete", (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole("button", { name: "Delete" }))],
  ])("returns focus to the opener after closing with %s", async (_how, closeWith) => {
    const { user, opener } = await openFromButton();
    await closeWith(user);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});

describe("opening the detail view", () => {
  it("calls onView from the card title only", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    const onEdit = vi.fn();
    render(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={TASK}
          projects={[PROJECT]}
          onView={onView}
          onEdit={onEdit}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );

    await user.click(screen.getByRole("button", { name: `Edit ${TASK.title}` }));
    expect(onView).not.toHaveBeenCalled();
    expect(onEdit).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: TASK.title }));
    expect(onView).toHaveBeenCalledWith(TASK);
  });

  it("calls onView from the list row title", async () => {
    const user = userEvent.setup();
    const onView = vi.fn();
    render(
      <TaskList
        tasks={[TASK]}
        projects={[PROJECT]}
        onView={onView}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: TASK.title }));
    expect(onView).toHaveBeenCalledWith(TASK);
  });
});
