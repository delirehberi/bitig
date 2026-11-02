import { InMemoryStorage, type SaveCheckpointInput, type StorageProvider, type Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskCheckpoint } from "./TaskCheckpoint";

describe("TaskCheckpoint", () => {
  let storage: InMemoryStorage;
  let task: Task;

  function checkpoint(stepIndex: number, summary: string): SaveCheckpointInput {
    return {
      taskId: task.id,
      stepIndex,
      status: "IN_PROGRESS",
      stateSnapshot: { summary, modifiedArtifacts: [], decisionsMade: [], nextStepInstructions: `Do step ${String(stepIndex + 1)}` },
    };
  }

  beforeEach(async () => {
    storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig" });
    task = await storage.saveTask({ projectId: project.id, title: "Long job" });
  });

  it("shows the latest checkpoint with its author and next step", async () => {
    await storage.saveCheckpoint(checkpoint(0, "Read the code"), { actor: "claude" });
    await storage.saveCheckpoint(checkpoint(1, "Wrote the schema"), { actor: "codex" });
    render(<TaskCheckpoint storage={storage} taskId={task.id} />);

    expect(await screen.findByText("Wrote the schema")).toBeInTheDocument();
    expect(screen.queryByText("Read the code")).not.toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Step 1")).toBeInTheDocument();
    expect(screen.getByText("just now")).toBeInTheDocument();
    expect(screen.getByText("Do step 2")).toBeInTheDocument();
  });

  it("omits the author when the checkpoint has none", async () => {
    await storage.saveCheckpoint(checkpoint(0, "Anonymous"));
    render(<TaskCheckpoint storage={storage} taskId={task.id} />);

    expect(await screen.findByText("Anonymous")).toBeInTheDocument();
    expect(screen.queryByText(/^by$/)).not.toBeInTheDocument();
  });

  it("renders nothing when the task has no checkpoints", async () => {
    const spy = vi.spyOn(storage, "getCheckpoints");
    const { container } = render(<TaskCheckpoint storage={storage} taskId={task.id} />);
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalled();
    });
    await spy.mock.results[0]?.value;
    expect(container).toBeEmptyDOMElement();
  });

  it("reports a load failure", async () => {
    const failing: StorageProvider = Object.create(storage) as StorageProvider;
    failing.getCheckpoints = () => Promise.reject(new Error("relay down"));
    render(<TaskCheckpoint storage={failing} taskId={task.id} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("relay down");
  });
});
