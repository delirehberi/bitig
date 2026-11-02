import { InMemoryStorage, type AgentRun, type AgentRunState, type Project, type Task } from "@bitig/core";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchTaskT3Run } from "../../services/t3";
import { TaskT3Section } from "./TaskT3Section";

vi.mock("../../services/t3", () => ({
  fetchTaskT3Run: vi.fn(),
  fetchT3Connection: vi.fn(() => Promise.resolve({ connected: false })),
  fetchT3ProjectMappings: vi.fn(() => Promise.resolve([])),
  fetchT3Capabilities: vi.fn(() => Promise.resolve([])),
  respondToTaskT3PendingRequest: vi.fn(),
  startTaskT3Run: vi.fn(),
  stopTaskT3Run: vi.fn(),
}));

const COMMENT_HINT = /add a comment to send the agent a follow-up/i;

function makeRun(taskId: string, state: AgentRunState): AgentRun {
  return {
    id: "01940000-0000-7000-8000-000000000001",
    taskId,
    t3ProjectId: "t3-proj",
    threadId: "thread-1",
    state,
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

describe("TaskT3Section", () => {
  let project: Project;
  let task: Task;

  beforeEach(async () => {
    vi.mocked(fetchTaskT3Run).mockReset();
    const storage = new InMemoryStorage();
    project = await storage.createProject({ name: "Bitig" });
    task = await storage.saveTask({ projectId: project.id, title: "Run in T3" });
  });

  it("has no follow-up message input and points to comments while a run is reachable", async () => {
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "finished"), pendingQuestions: [] });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

    expect(await screen.findByText(COMMENT_HINT)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /message t3 thread/i })).not.toBeInTheDocument();
  });

  it("hides the comment hint when the run is offline", async () => {
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "offline"), pendingQuestions: [] });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

    expect(await screen.findByText("thread-1")).toBeInTheDocument();
    expect(screen.queryByText(COMMENT_HINT)).not.toBeInTheDocument();
  });

  it("shows the current model on the T3 chip and reports the run for the comment box (BIT-119)", async () => {
    const run = { ...makeRun(task.id, "waiting_for_approval"), model: "gpt-6-sol" };
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run, pendingQuestions: [] });
    const onT3ContextChange = vi.fn();
    render(
      <TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} onT3ContextChange={onT3ContextChange} />,
    );

    expect(await screen.findByTestId("t3-thread-chip")).toHaveTextContent("T3 thread · waiting for approval · gpt-6-sol");
    expect(onT3ContextChange).toHaveBeenLastCalledWith({ run, capabilities: [] });
  });
});
