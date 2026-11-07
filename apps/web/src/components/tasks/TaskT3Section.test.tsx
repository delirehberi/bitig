import { InMemoryStorage, type AgentRun, type AgentRunState, type Project, type Task } from "@bitig/core";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchTaskT3Run,
  fetchT3Connection,
  fetchT3ProjectMappings,
  fetchT3Runs,
  fetchTaskT3Run,
  startTaskT3Run,
  stopTaskT3Run,
  T3WorkspaceBusyApiError,
} from "../../services/t3";
import type * as T3Service from "../../services/t3";
import { TaskT3Section } from "./TaskT3Section";

vi.mock("../../services/t3", async (importActual) => ({
  T3WorkspaceBusyApiError: (await importActual<typeof T3Service>()).T3WorkspaceBusyApiError,
  dispatchTaskT3Run: vi.fn(),
  fetchT3Runs: vi.fn(() => Promise.resolve({ runs: [] })),
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

  it("renders saved Git metadata and safe PR links even while offline", async () => {
    const url = "https://github.com/example/repo/pull/162";
    const headSha = "abcdef0" + "1".repeat(33);
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: { ...makeRun(task.id, "offline"), branch: "feature/bit-162", headSha, diffStat: { filesChanged: 3, insertions: 12, deletions: 4 }, pullRequestUrls: [url, "javascript:alert(1)", url] }, pendingQuestions: [] });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);
    expect(await screen.findByText("feature/bit-162")).toBeInTheDocument();
    expect(screen.getByText("abcdef0")).toHaveAttribute("title", headSha);
    expect(screen.getByText("3 files changed · +12 / −4")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: url })).toHaveLength(1);
    expect(screen.getByRole("link", { name: url })).toHaveAttribute("href", url);
    expect(screen.getByRole("link", { name: url })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.queryByRole("link", { name: /javascript/ })).not.toBeInTheDocument();
  });

  it("shows a known clean diff and hides missing metadata", async () => {
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: { ...makeRun(task.id, "finished"), diffStat: { filesChanged: 0, insertions: 0, deletions: 0 }, pullRequestUrls: [] }, pendingQuestions: [] });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);
    expect(await screen.findByText("0 files changed · +0 / −0")).toBeInTheDocument();
  });

  it("renders initialRun Git metadata immediately without waiting for network fetches", () => {
    vi.mocked(fetchTaskT3Run).mockReturnValue(new Promise(() => undefined));
    const initialRun: AgentRun = {
      ...makeRun(task.id, "working"),
      branch: "t3code/bit-162",
      headSha: "1234567890abcdef1234567890abcdef12345678",
      diffStat: { filesChanged: 5, insertions: 80, deletions: 12 },
    };
    render(
      <TaskT3Section
        task={task}
        project={project}
        initialRun={initialRun}
        hasUnfinishedDependencies={false}
      />,
    );
    expect(screen.getByTestId("t3-git-metadata")).toBeInTheDocument();
    expect(screen.getByText("t3code/bit-162")).toBeInTheDocument();
    expect(screen.getByText("1234567")).toBeInTheDocument();
    expect(screen.getByText("5 files changed · +80 / −12")).toBeInTheDocument();
  });

  it("has no follow-up message input and points to comments while a run is reachable", async () => {
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: makeRun(task.id, "finished"), pendingQuestions: [] });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

    expect(await screen.findByText(COMMENT_HINT)).toBeInTheDocument();
    expect(screen.queryByTestId("t3-git-metadata")).not.toBeInTheDocument();
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
    await waitFor(() => {
      expect(onT3ContextChange).toHaveBeenLastCalledWith({ run, capabilities: [] });
    });
  });

  it("displays stopReason when a run is failed or stopped (BIT-132)", async () => {
    const run = { ...makeRun(task.id, "failed"), model: "claude-opus-4-7" };
    vi.mocked(fetchTaskT3Run).mockResolvedValue({
      run,
      pendingQuestions: [],
      stopReason: "Usage limit reached: Claude API rate limit reached. Try again later.",
    });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

    expect(await screen.findByTestId("t3-thread-stop-reason")).toHaveTextContent(
      "Usage limit reached: Claude API rate limit reached. Try again later.",
    );
  });

  it("surfaces queued runs with Dispatch now and Cancel queued run controls (#BIT-161)", async () => {
    const user = userEvent.setup();
    const queuedRun: AgentRun = {
      ...makeRun(task.id, "queued"),
      threadId: "queued:01940000-0000-7000-8000-000000000001",
      model: "claude-opus-4-7",
    };
    const workingRun: AgentRun = {
      ...makeRun(task.id, "working"),
      threadId: "thread-live",
      model: "claude-opus-4-7",
    };
    const stoppedRun: AgentRun = {
      ...makeRun(task.id, "stopped"),
      threadId: "queued:01940000-0000-7000-8000-000000000001",
    };
    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: queuedRun, pendingQuestions: [] });
    vi.mocked(dispatchTaskT3Run).mockResolvedValue({ run: workingRun, pendingQuestions: [] });
    vi.mocked(stopTaskT3Run).mockResolvedValue({ run: stoppedRun, pendingQuestions: [] });

    const { unmount } = render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);
    expect(await screen.findByTestId("t3-thread-chip")).toHaveTextContent("T3 thread · queued · claude-opus-4-7");
    expect(screen.getByTestId("t3-thread-queued")).toHaveTextContent(/Queued in D1/i);

    await user.click(screen.getByRole("button", { name: /dispatch now/i }));
    expect(dispatchTaskT3Run).toHaveBeenCalledWith(task.id);
    expect(await screen.findByTestId("t3-thread-chip")).toHaveTextContent("T3 thread · working · claude-opus-4-7");
    unmount();

    vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: queuedRun, pendingQuestions: [] });
    render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);
    await user.click(await screen.findByRole("button", { name: /cancel queued run/i }));
    expect(stopTaskT3Run).toHaveBeenCalledWith(task.id);
    expect(await screen.findByTestId("t3-thread-chip")).toHaveTextContent("T3 thread · stopped");
  });

  it("displays the waited-on child task code, title, and thread link when in waiting_subagent state (BIT-141)", async () => {
    const storage = new InMemoryStorage();
    const keyedProject = await storage.createProject({ name: "Bitig", key: "BIT" });
    const umbrella = await storage.saveTask({ projectId: keyedProject.id, title: "Umbrella task" });
    const child = await storage.saveTask({ projectId: keyedProject.id, title: "Child implementation" });
    const parentRun: AgentRun = {
      ...makeRun(umbrella.id, "waiting_subagent"),
      waitingForTaskId: child.id,
      model: "claude-opus-4-7",
    };
    const childRun: AgentRun = {
      ...makeRun(child.id, "working"),
      threadId: "thread-child",
      link: "https://t3.example.test/threads/thread-child",
    };
    vi.mocked(fetchTaskT3Run).mockImplementation((id) =>
      Promise.resolve({
        run: id === child.id ? childRun : parentRun,
        pendingQuestions: [],
      }),
    );

    render(
      <TaskT3Section
        task={umbrella}
        project={keyedProject}
        storage={storage}
        hasUnfinishedDependencies={false}
      />,
    );

    expect(await screen.findByTestId("t3-thread-chip")).toHaveTextContent(
      "T3 thread · waiting for subagent · claude-opus-4-7",
    );
    const waitingBox = await screen.findByTestId("t3-thread-waiting-subagent");
    expect(waitingBox).toHaveTextContent("#BIT-2");
    expect(waitingBox).toHaveTextContent("Child implementation");
    expect(screen.getByRole("link", { name: /open child thread/i })).toHaveAttribute(
      "href",
      "https://t3.example.test/threads/thread-child",
    );
  });

  describe("root checkout guard (#BIT-134)", () => {
    const T3_PROJECT_ID = "t3-proj";
    const BUSY_LINK = "https://t3.example.test/threads/thread-busy";

    beforeEach(() => {
      vi.mocked(fetchTaskT3Run).mockResolvedValue({ run: null, pendingQuestions: [] });
      vi.mocked(fetchT3Connection).mockResolvedValue({ connected: true, expired: false });
      vi.mocked(fetchT3ProjectMappings).mockResolvedValue([
        {
          projectId: project.id,
          t3ProjectId: T3_PROJECT_ID,
          t3ProjectTitle: "Bitig Workspace",
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ]);
      vi.mocked(fetchT3Runs).mockReset().mockResolvedValue({ runs: [] });
      vi.mocked(startTaskT3Run).mockReset();
    });

    it("warns and disables Start when another task's root session is active, but not for an isolated worktree", async () => {
      const user = userEvent.setup();
      const busyRun: AgentRun = {
        ...makeRun("01940000-0000-7000-8000-0000000000ff", "working"),
        threadId: "thread-busy",
        t3ProjectId: T3_PROJECT_ID,
        workspaceStrategy: "root",
        link: BUSY_LINK,
      };
      vi.mocked(fetchT3Runs).mockResolvedValue({ runs: [busyRun] });
      render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

      const worktreeBox = await screen.findByRole("checkbox", { name: /isolated git worktree/i });
      const startButton = screen.getByRole("button", { name: /start in t3/i });
      expect(fetchT3Runs).not.toHaveBeenCalled();

      await user.click(worktreeBox);
      expect(await screen.findByRole("status")).toHaveTextContent(/active in this project's root checkout/i);
      expect(screen.getByRole("link", { name: /open in t3/i })).toHaveAttribute("href", BUSY_LINK);
      expect(startButton).toBeDisabled();

      await user.click(worktreeBox);
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(startButton).toBeEnabled();
    });

    it("ignores worktree runs and runs in other T3 projects", async () => {
      const user = userEvent.setup();
      vi.mocked(fetchT3Runs).mockResolvedValue({
        runs: [
          { ...makeRun("01940000-0000-7000-8000-0000000000aa", "working"), t3ProjectId: T3_PROJECT_ID, workspaceStrategy: "worktree" },
          { ...makeRun("01940000-0000-7000-8000-0000000000bb", "working"), t3ProjectId: "other-proj", workspaceStrategy: "root" },
        ],
      });
      render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

      await user.click(await screen.findByRole("checkbox", { name: /isolated git worktree/i }));
      await vi.waitFor(() => {
        expect(fetchT3Runs).toHaveBeenCalled();
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /start in t3/i })).toBeEnabled();
    });

    it("shows the server's refusal with a link to the busy thread", async () => {
      const user = userEvent.setup();
      const message = "Another T3 session (BIT-9) is working in this project's root checkout.";
      vi.mocked(startTaskT3Run).mockRejectedValue(
        new T3WorkspaceBusyApiError(409, message, { threadId: "thread-busy", state: "working", link: BUSY_LINK }),
      );
      render(<TaskT3Section task={task} project={project} hasUnfinishedDependencies={false} />);

      await user.click(await screen.findByRole("checkbox", { name: /isolated git worktree/i }));
      await user.click(screen.getByRole("button", { name: /start in t3/i }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(message);
      expect(screen.getByRole("link", { name: /open busy thread/i })).toHaveAttribute("href", BUSY_LINK);
      expect(startTaskT3Run).toHaveBeenCalledWith(task.id, { workspaceStrategy: "root" });
    });
  });
});
