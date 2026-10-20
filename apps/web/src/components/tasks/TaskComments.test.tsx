import { InMemoryStorage, type Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { TaskComments } from "./TaskComments";

describe("TaskComments", () => {
  let storage: InMemoryStorage;
  let task: Task;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig" });
    task = await storage.saveTask({ projectId: project.id, title: "Needs a key" });
  });

  it("shows comments oldest first and who wrote them", async () => {
    await storage.addComment({ taskId: task.id, body: "Which key should I use?", authorType: "agent", author: "claude" });
    await storage.addComment({ taskId: task.id, body: "The staging one." });
    render(<TaskComments storage={storage} taskId={task.id} />);

    const items = await screen.findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Which key should I use?"),
      expect.stringContaining("The staging one."),
    ]);
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("(agent)")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /comments \(2\)/i })).toBeInTheDocument();
  });

  it("adds a comment as a person and deletes one", async () => {
    const user = userEvent.setup();
    render(<TaskComments storage={storage} taskId={task.id} />);
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Comment" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Add a comment"), "Use the staging key");
    await user.click(submit);

    expect(await screen.findByText("Use the staging key")).toBeInTheDocument();
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");
    expect(await storage.getComments(task.id)).toMatchObject([{ body: "Use the staging key", authorType: "human" }]);

    await user.click(screen.getByRole("button", { name: "Delete comment by You" }));
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();
    expect(await storage.getComments(task.id)).toEqual([]);
  });
});
