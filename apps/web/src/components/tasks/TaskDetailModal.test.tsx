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

  it("displays startedAt, completedAt, lead time, and active time spent", () => {
    renderModal({
      ...TASK,
      status: "done",
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:30:00.000Z",
      completedAt: "2026-01-01T12:00:00.000Z",
      updatedAt: "2026-01-01T12:00:00.000Z",
    });

    expect(screen.getByText("Time spent")).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Started 30m after creation")).toBeInTheDocument();
    expect(screen.getByText("Completed in 1h 30m")).toBeInTheDocument();
  });

  it("displays LLM actor attribution and activity history across modal, card, and list", () => {
    const markedTask: Task = {
      ...TASK,
      status: "done",
      createdAt: "2026-01-01T10:00:00.000Z",
      startedAt: "2026-01-01T10:30:00.000Z",
      completedAt: "2026-01-01T12:00:00.000Z",
      updatedAt: "2026-01-01T12:00:00.000Z",
      createdBy: "claude",
      startedBy: "antigravity",
      completedBy: "codex",
      updatedBy: "codex",
      activity: [
        {
          action: "created",
          actor: "claude",
          timestamp: "2026-01-01T10:00:00.000Z",
          toStatus: "todo",
        },
        {
          action: "status_changed",
          actor: "antigravity",
          timestamp: "2026-01-01T10:30:00.000Z",
          fromStatus: "todo",
          toStatus: "in_progress",
        },
        {
          action: "completed",
          actor: "codex",
          timestamp: "2026-01-01T12:00:00.000Z",
          fromStatus: "in_progress",
          toStatus: "done",
        },
      ],
    };

    const { unmount } = render(
      <FeatureFlagsProvider mode="local">
        <TaskDetailModal
          task={markedTask}
          projects={[PROJECT]}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByRole("region", { name: "Activity (3)" })).toBeInTheDocument();
    expect(screen.getByText("created task")).toBeInTheDocument();
    expect(screen.getByText("moved from To Do to In Progress")).toBeInTheDocument();
    expect(screen.getByText("completed task")).toBeInTheDocument();
    expect(screen.getAllByText("claude")).toHaveLength(2);
    expect(screen.getAllByText("antigravity")).toHaveLength(2);
    expect(screen.getAllByText("codex")).toHaveLength(3);
    unmount();

    const { unmount: unmountCard } = render(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={markedTask}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );
    expect(screen.getByTitle("Last touched by codex")).toHaveTextContent("codex");
    unmountCard();

    render(
      <TaskList
        tasks={[markedTask]}
        projects={[PROJECT]}
        onView={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onComplete={vi.fn()}
        onStatusChange={vi.fn()}
      />,
    );
    expect(screen.getByTitle("Last touched by codex")).toHaveTextContent("codex");
  });

  it("shows what the task needs from a human and clears it", async () => {
    const onNeedsHumanResolve = vi.fn();
    render(
      <FeatureFlagsProvider mode="local">
        <TaskDetailModal
          task={{ ...TASK, needsHuman: "Choose the API style" }}
          projects={[PROJECT]}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onNeedsHumanResolve={onNeedsHumanResolve}
        />
      </FeatureFlagsProvider>,
    );

    expect(screen.getByRole("note", { name: "Needs you" })).toHaveTextContent("Choose the API style");
    await userEvent.setup().click(screen.getByRole("button", { name: "Mark answered" }));
    expect(onNeedsHumanResolve).toHaveBeenCalledWith(expect.objectContaining({ id: TASK.id }));
  });

  it("shows no needs-human note for a task that needs nobody", () => {
    renderModal();
    expect(screen.queryByRole("note", { name: "Needs you" })).not.toBeInTheDocument();
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

  it("hides the description on done and archived cards and applies skinny hover-expanding layout to archived cards", () => {
    const { rerender } = render(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={TASK}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );
    expect(screen.getByText("Cover the REST API")).toBeInTheDocument();

    rerender(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={{ ...TASK, status: "done" }}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );
    expect(screen.queryByText("Cover the REST API")).not.toBeInTheDocument();

    rerender(
      <FeatureFlagsProvider mode="local">
        <TaskCard
          task={{ ...TASK, status: "archived" }}
          projects={[PROJECT]}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </FeatureFlagsProvider>,
    );
    expect(screen.queryByText("Cover the REST API")).not.toBeInTheDocument();
    expect(screen.queryByText("#docs")).not.toBeInTheDocument();
    const article = screen.getByRole("article");
    expect(article.className).toContain("w-4/5");
    expect(article.className).toContain("hover:w-full");
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
