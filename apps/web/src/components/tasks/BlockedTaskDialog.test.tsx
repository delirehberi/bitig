import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InMemoryStorage, type Project, type StorageProvider } from "@bitig/core";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { useTasks } from "../../hooks/useTasks";
import { TasksView } from "./TasksView";

function Harness({ storage, projects }: { readonly storage: StorageProvider; readonly projects: Project[] }) {
  const { tasks, isLoading, error, saveTask, updateTask, completeTask, deleteTask } = useTasks(storage);
  return (
    <TasksView
      tasks={tasks}
      projects={projects}
      isLoading={isLoading}
      error={error}
      onSelectProject={() => undefined}
      onSaveTask={saveTask}
      onUpdateTask={updateTask}
      onCompleteTask={completeTask}
      onDeleteTask={deleteTask}
      searchQuery=""
    />
  );
}

async function setup() {
  const storage = new InMemoryStorage();
  const project = await storage.createProject({ name: "Bitig", key: "BIT" });
  const dependency = await storage.saveTask({ projectId: project.id, title: "Schema" });
  const blocked = await storage.saveTask({ projectId: project.id, title: "Signup", dependsOn: [dependency.id] });
  render(
    <FeatureFlagsProvider mode="nostr">
      <Harness storage={storage} projects={[project]} />
    </FeatureFlagsProvider>,
  );
  await screen.findByText("Signup");
  return { storage, blocked };
}

function completeButtonOf(title: string): HTMLElement {
  const card = screen.getByText(title).closest("article") ?? screen.getByText(title).parentElement;
  if (card === null) throw new Error(`No card for ${title}`);
  return within(card).getByTitle("Mark as Done");
}

describe("completing a task with unfinished dependencies", () => {
  it("asks first, and completes it with a logged override when the person confirms", async () => {
    const user = userEvent.setup();
    const { storage, blocked } = await setup();

    await user.click(completeButtonOf("Signup"));
    const dialog = await screen.findByRole("dialog", { name: "Task is blocked" });
    expect(dialog).toHaveTextContent("waits on BIT-1");
    expect((await storage.getTask(blocked.id))?.status).toBe("todo");

    await user.click(within(dialog).getByRole("button", { name: "Complete anyway" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Task is blocked" })).not.toBeInTheDocument();
    });
    const completed = await storage.getTask(blocked.id);
    expect(completed?.status).toBe("done");
    expect(completed?.activity).toEqual([
      expect.objectContaining({ action: "dependency_override", toStatus: "done", blockedBy: ["BIT-1"] }),
    ]);
  });

  it("leaves the task alone when the person cancels", async () => {
    const user = userEvent.setup();
    const { storage, blocked } = await setup();

    await user.click(completeButtonOf("Signup"));
    const dialog = await screen.findByRole("dialog", { name: "Task is blocked" });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog", { name: "Task is blocked" })).not.toBeInTheDocument();
    expect(await storage.getTask(blocked.id)).toEqual(blocked);
  });

  it("does not ask for a task whose dependencies are finished", async () => {
    const user = userEvent.setup();
    const { storage } = await setup();

    await user.click(completeButtonOf("Schema"));
    await waitFor(async () => {
      expect((await storage.getTasks()).find((t) => t.title === "Schema")?.status).toBe("done");
    });
    expect(screen.queryByRole("dialog", { name: "Task is blocked" })).not.toBeInTheDocument();
  });
});
