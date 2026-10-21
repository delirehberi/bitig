import { InMemoryStorage, type Project, type Task } from "@bitig/core";
import type { ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../domain/feature-context";
import { TaskMentionsProvider } from "../domain/task-mentions-context";
import { Markdown } from "./Markdown";
import { TaskDetailModal } from "./tasks/TaskDetailModal";
import { TaskComments } from "./tasks/TaskComments";

const NOW = "2026-10-21T12:00:00.000Z";
const PROJECT: Project = { id: "p1", name: "Bitig", key: "BIT", description: "", kind: "hobby", createdAt: NOW, updatedAt: NOW };
function task(number: number, title: string, status: Task["status"] = "todo"): Task {
  return { id: `t${String(number)}`, projectId: PROJECT.id, number, title, description: "", status, isPublic: false, createdAt: NOW, updatedAt: NOW };
}
const SCHEMA = task(63, "Schema", "done");
const SIGNUP = task(64, "Signup");

function withMentions(children: ReactNode, tasks: Task[] = [SCHEMA, SIGNUP]) {
  return (
    <FeatureFlagsProvider mode="local">
      <TaskMentionsProvider projects={[PROJECT]} tasks={tasks}>
        {children}
      </TaskMentionsProvider>
    </FeatureFlagsProvider>
  );
}

describe("task mentions", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/tasks");
  });

  it("links known mentions to the task, with its title and status on hover", async () => {
    render(withMentions(<Markdown content="Needs #BIT-64 and **#BIT-63** first." />));

    const signup = screen.getByRole("link", { name: "#BIT-64" });
    expect(signup).toHaveAttribute("href", "/tasks?task=BIT-64");
    expect(signup).toHaveAttribute("title", "Signup (To do)");
    expect(signup).not.toHaveClass("line-through");

    const schema = screen.getByRole("link", { name: "#BIT-63" });
    expect(schema).toHaveAttribute("title", "Schema (Done)");
    expect(schema).toHaveClass("line-through");
    expect(schema.closest("strong")).not.toBeNull();

    await userEvent.setup().click(signup);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/tasks?task=BIT-64");
  });

  it("leaves unknown codes, code spans, links and URLs as text", () => {
    render(
      withMentions(
        <Markdown content={"#BIT-99 and `#BIT-64` and [see #BIT-64](https://example.test) and https://x.test/#BIT-64"} />,
      ),
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.test");
    expect(screen.getByText("#BIT-64", { selector: "code" })).toBeInTheDocument();
  });

  it("renders mentions as plain text without a provider", () => {
    render(<Markdown content="See #BIT-64" />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("links mentions in subtasks without breaking the checkbox label", async () => {
    const parent: Task = { ...task(70, "Launch"), checklist: [{ text: "Wait for #BIT-64", done: false }] };
    const onChecklistChange = vi.fn(() => Promise.resolve());
    render(
      withMentions(
        <TaskDetailModal
          task={parent}
          projects={[PROJECT]}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onChecklistChange={onChecklistChange}
        />,
      ),
    );

    const dialog = screen.getByRole("dialog");
    const checkbox = within(dialog).getByLabelText("Wait for #BIT-64");
    expect(within(dialog).getByRole("link", { name: "#BIT-64" })).toHaveAttribute("href", "/tasks?task=BIT-64");

    await userEvent.setup().click(checkbox);
    expect(onChecklistChange).toHaveBeenCalledWith(parent, [{ text: "Wait for #BIT-64", done: true }]);
  });

  it("links mentions in comments", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Other" });
    const commented = await storage.saveTask({ projectId: project.id, title: "Signup" });
    await storage.addComment({ taskId: commented.id, body: "Blocked on #BIT-63" });
    render(withMentions(<TaskComments storage={storage} taskId={commented.id} />));

    expect(await screen.findByRole("link", { name: "#BIT-63" })).toHaveAttribute("href", "/tasks?task=BIT-63");
  });
});
