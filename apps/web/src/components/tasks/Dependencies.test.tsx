import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InMemoryStorage, type Project, type StorageProvider } from "@bitig/core";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskMentionsProvider } from "../../domain/task-mentions-context";
import { useTasks } from "../../hooks/useTasks";
import { TasksView } from "./TasksView";

function Harness({ storage, projects }: { readonly storage: StorageProvider; readonly projects: Project[] }) {
  const { tasks, isLoading, error, saveTask, updateTask, completeTask, deleteTask } = useTasks(storage);
  const [viewTaskRef, setViewTaskRef] = useState<string | undefined>();
  const [blockedOnly, setBlockedOnly] = useState(false);
  return (
    <TaskMentionsProvider projects={projects} tasks={tasks}>
      <TasksView
        tasks={tasks}
        projects={projects}
        isLoading={isLoading}
        error={error}
        onSelectProject={() => undefined}
        blockedOnly={blockedOnly}
        onBlockedOnlyChange={setBlockedOnly}
        viewTaskRef={viewTaskRef}
        onViewTaskChange={setViewTaskRef}
        onSaveTask={saveTask}
        onUpdateTask={updateTask}
        onCompleteTask={completeTask}
        onDeleteTask={deleteTask}
        searchQuery=""
      />
    </TaskMentionsProvider>
  );
}

async function setup({ signupDependsOnSchema = false } = {}) {
  const storage = new InMemoryStorage();
  const project = await storage.createProject({ name: "Bitig", key: "BIT" });
  const schema = await storage.saveTask({ projectId: project.id, title: "Schema" });
  const signup = await storage.saveTask({
    projectId: project.id,
    title: "Signup",
    ...(signupDependsOnSchema ? { dependsOn: [schema.id] } : {}),
  });
  render(
    <FeatureFlagsProvider mode="nostr">
      <Harness storage={storage} projects={[project]} />
    </FeatureFlagsProvider>,
  );
  await screen.findByText("Signup");
  return { storage, schema, signup };
}

function cardOf(title: string): HTMLElement {
  const card = screen.getByText(title).closest("article");
  if (card === null) throw new Error(`No card for ${title}`);
  return card;
}

describe("dependencies in the web app", () => {
  it("picks a dependency by code, shows the task as blocked, and unblocks it when the dependency is done", async () => {
    const user = userEvent.setup();
    const { storage, schema, signup } = await setup();

    await user.click(screen.getByRole("button", { name: "Edit Signup" }));
    const form = screen.getByRole("dialog");
    await user.type(within(form).getByLabelText("Find a task to depend on"), "bit-1");
    await user.click(within(within(form).getByRole("list", { name: "Matching tasks" })).getByRole("button", { name: /Schema/ }));
    expect(within(within(form).getByRole("list", { name: "Chosen dependencies" })).getByText("BIT-1")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Save Changes" }));

    await waitFor(async () => {
      expect((await storage.getTask(signup.id))?.dependsOn).toEqual([schema.id]);
    });
    expect(within(cardOf("Signup")).getByTitle("Blocked by BIT-1")).toHaveTextContent("Blocked");
    expect(within(cardOf("Schema")).queryByText("Blocked")).not.toBeInTheDocument();

    // The filter shows only blocked tasks
    await user.click(screen.getByRole("button", { name: "Blocked (1)" }));
    expect(screen.queryByText("Schema")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Blocked (1)" }));

    // Both directions show in the detail view
    await user.click(within(cardOf("Schema")).getByRole("button", { name: "Schema" }));
    const detail = screen.getByRole("dialog");
    expect(within(within(detail).getByRole("list", { name: "Blocks" })).getByRole("link")).toHaveTextContent("BIT-2Signup");
    await user.click(within(detail).getByRole("button", { name: "Close dialog" }));

    // Starting it asks for confirmation
    await user.selectOptions(within(cardOf("Signup")).getByLabelText("Change status"), "in_progress");
    const confirm = await screen.findByRole("dialog", { name: "Task is blocked" });
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect((await storage.getTask(signup.id))?.status).toBe("todo");

    await user.click(within(cardOf("Schema")).getByTitle("Mark as Done"));
    await waitFor(() => {
      expect(within(cardOf("Signup")).queryByText("Blocked")).not.toBeInTheDocument();
    });
  });

  it("removes a dependency and shows a cycle as a form error", async () => {
    const user = userEvent.setup();
    const { storage, schema, signup } = await setup({ signupDependsOnSchema: true });

    await user.click(screen.getByRole("button", { name: "Edit Schema" }));
    let form = screen.getByRole("dialog");
    await user.type(within(form).getByLabelText("Find a task to depend on"), "Signup{Enter}");
    await user.click(within(form).getByRole("button", { name: "Save Changes" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent(/cycle/i);
    expect((await storage.getTask(schema.id))?.dependsOn).toBeUndefined();
    await user.click(within(form).getByRole("button", { name: "Cancel" }));

    await user.click(screen.getByRole("button", { name: "Edit Signup" }));
    form = screen.getByRole("dialog");
    await user.click(within(form).getByRole("button", { name: "Remove dependency BIT-1" }));
    await user.click(within(form).getByRole("button", { name: "Save Changes" }));
    await waitFor(async () => {
      expect((await storage.getTask(signup.id))?.dependsOn).toBeUndefined();
    });
  });

  it("refuses to create a task already started behind an unfinished dependency", async () => {
    const user = userEvent.setup();
    await setup();

    await user.click(screen.getByRole("button", { name: "New Task" }));
    const form = screen.getByRole("dialog");
    await user.type(within(form).getByLabelText(/^Title/), "Launch");
    await user.selectOptions(within(form).getByLabelText("Status"), "in_progress");
    await user.type(within(form).getByLabelText("Find a task to depend on"), "BIT-1{Enter}");
    await user.click(within(form).getByRole("button", { name: "Create Task" }));
    expect(await within(form).findByRole("alert")).toHaveTextContent("blocked by unfinished dependencies: BIT-1");
  });
});
