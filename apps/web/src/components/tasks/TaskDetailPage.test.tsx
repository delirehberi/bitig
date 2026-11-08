import {
  InMemoryStorage,
  type AgentRun,
  type AgentRunState,
  type Project,
  type T3ModelCapability,
  type Task,
} from "@bitig/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskMentionsProvider } from "../../domain/task-mentions-context";
import * as t3Service from "../../services/t3";
import { TaskDetailPage } from "./TaskDetailPage";

const CAPABILITIES: T3ModelCapability[] = [
  {
    providerInstanceId: "claudeAgent",
    displayName: "Claude",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    options: [
      { id: "effort", values: ["low", "medium", "high"], default: "medium" },
      { id: "fastMode", values: [false, true] },
    ],
  },
  {
    providerInstanceId: "codex",
    displayName: "Codex",
    model: "gpt-5.4",
    options: [{ id: "reasoningEffort", values: ["low", "high"], default: "low" }],
  },
];

function makeRun(taskId: string, state: AgentRunState, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "01940000-0000-7000-8000-000000000099",
    taskId,
    t3ProjectId: "t3-proj",
    threadId: "thread-1",
    state,
    model: "gpt-5.4",
    link: "https://t3.example.test/threads/thread-1",
    startedAt: "2026-11-07T10:05:00.000Z",
    updatedAt: "2026-11-07T10:25:00.000Z",
    ...overrides,
  };
}

describe("TaskDetailPage", () => {
  let storage: InMemoryStorage;
  let project: Project;
  let task: Task;

  beforeEach(async () => {
    window.history.replaceState(null, "", "/tasks/BIT-168");
    vi.restoreAllMocks();
    storage = new InMemoryStorage();
    project = await storage.createProject({ name: "Bitig", key: "BIT" });
    task = await storage.saveTask({
      projectId: project.id,
      title: "Add a full-page task detail view",
      description: "The task detail modal has outgrown a dialog.",
      priority: "high",
      status: "in_progress",
      checklist: [
        { text: "Add the task page route", done: true },
        { text: "Page shell and side rail", done: false },
      ],
    });

    vi.spyOn(t3Service, "fetchT3Connection").mockResolvedValue({
      enabled: true,
      connected: true,
    });
    vi.spyOn(t3Service, "fetchT3ProjectMappings").mockResolvedValue([
      {
        projectId: project.id,
        t3ProjectId: "t3-proj",
        t3ProjectName: "Bitig",
        updatedAt: "2026-11-07T10:00:00.000Z",
      },
    ]);
    vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({
      run: null,
      pendingQuestions: [],
    });
    vi.spyOn(t3Service, "fetchT3Runs").mockResolvedValue({ runs: [] });
    vi.spyOn(t3Service, "fetchT3Capabilities").mockResolvedValue(CAPABILITIES);
    vi.spyOn(t3Service, "replyToTaskT3Run").mockResolvedValue({
      run: makeRun(task.id, "working"),
      comment: {
        id: "01940000-0000-7000-8000-0000000000c9",
        taskId: task.id,
        body: "Replied to agent",
        authorType: "human",
        createdAt: "2026-11-07T10:30:00.000Z",
      },
      switchedSession: false,
    });
  });

  function renderPage(
    overrides: Partial<React.ComponentProps<typeof TaskDetailPage>> = {},
    customTask: Task = task,
  ) {
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onComplete = vi.fn();
    const onStatusChange = vi.fn();
    const onArchive = vi.fn();
    const onMoveToBacklog = vi.fn();
    const onChecklistChange = vi.fn().mockResolvedValue(undefined);
    const onNeedsHumanResolve = vi.fn();
    const onApprove = vi.fn();

    const utils = render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskMentionsProvider projects={[project]} tasks={[customTask]}>
          <TaskDetailPage
            task={customTask}
            projects={[project]}
            storage={storage}
            onEdit={onEdit}
            onDelete={onDelete}
            onComplete={onComplete}
            onStatusChange={onStatusChange}
            onArchive={onArchive}
            onMoveToBacklog={onMoveToBacklog}
            onChecklistChange={onChecklistChange}
            onNeedsHumanResolve={onNeedsHumanResolve}
            onApprove={onApprove}
            {...overrides}
          />
        </TaskMentionsProvider>
      </FeatureFlagsProvider>,
    );

    return {
      ...utils,
      onEdit,
      onDelete,
      onComplete,
      onStatusChange,
      onArchive,
      onMoveToBacklog,
      onChecklistChange,
      onNeedsHumanResolve,
      onApprove,
    };
  }

  it("renders the top bar, header chips, description with subtasks first, and chronological comments and events", async () => {
    const t0 = "2026-11-07T10:00:00.000Z";
    const t1 = "2026-11-07T10:05:00.000Z";
    const t2 = "2026-11-07T10:10:00.000Z";
    const t3 = "2026-11-07T10:15:00.000Z";
    const t4 = "2026-11-07T10:20:00.000Z";

    const run = makeRun(task.id, "waiting_for_approval", {
      startedAt: t1,
      updatedAt: t4,
    });
    vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({ run, pendingQuestions: [] });

    vi.spyOn(storage, "getCheckpoints").mockResolvedValue([
      {
        id: "01940000-0000-7000-8000-0000000000cp",
        taskId: task.id,
        stepIndex: 0,
        status: "IN_PROGRESS",
        createdBy: "codex",
        createdAt: t2,
        updatedAt: t2,
        stateSnapshot: {
          summary: "Added /tasks/:code route",
          modifiedArtifacts: ["router.ts"],
          decisionsMade: [],
          nextStepInstructions: "Build page shell",
        },
      },
    ]);

    vi.spyOn(storage, "getComments").mockResolvedValue([
      {
        id: "01940000-0000-7000-8000-0000000000c1",
        taskId: task.id,
        body: "Use the existing TaskModal for editing.",
        authorType: "human",
        author: "Emre",
        createdAt: t3,
      },
      {
        id: "01940000-0000-7000-8000-0000000000c2",
        taskId: task.id,
        body: "Should Archive stay in the action row?",
        authorType: "agent",
        author: "Codex",
        createdAt: t4,
      },
    ]);

    const richTask: Task = {
      ...task,
      number: 168,
      createdAt: t0,
      startedAt: t1,
      updatedAt: t4,
      needsHuman: "Should Archive stay in the action row?",
      activity: [
        { timestamp: t0, action: "created", actor: "Emre", toStatus: "todo" },
        { timestamp: t1, action: "status_changed", actor: "Codex", fromStatus: "todo", toStatus: "in_progress" },
      ],
    };

    renderPage({ agentRun: run }, richTask);

    // Top bar
    expect(screen.getByRole("link", { name: "Back to Tasks" })).toHaveAttribute("href", "/tasks");
    expect(screen.getByText("BIT-168")).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /Open in T3/i })[0]).toHaveAttribute(
      "href",
      "https://t3.example.test/threads/thread-1",
    );

    // Header chips
    expect(screen.getByRole("heading", { level: 1, name: "Add a full-page task detail view" })).toBeInTheDocument();
    expect(screen.getByTestId("task-waiting-chip")).toHaveTextContent("Codex is waiting for you");

    // Description is the first message and contains subtasks
    const descArticle = screen.getByRole("article", { name: "Task description" });
    expect(within(descArticle).getByText("The task detail modal has outgrown a dialog.")).toBeInTheDocument();
    expect(within(descArticle).getByText("Add the task page route")).toBeInTheDocument();
    expect(within(descArticle).getByText("Page shell and side rail")).toBeInTheDocument();

    // Wait for comments & checkpoints to load into the thread
    expect(await screen.findByText("Use the existing TaskModal for editing.")).toBeInTheDocument();
    expect(await screen.findByText(/Added \/tasks\/:code route/)).toBeInTheDocument();
    const highlightedQuestion = screen.getByTestId("highlighted-agent-question");
    expect(within(highlightedQuestion).getByText("Needs you")).toBeInTheDocument();
    expect(within(highlightedQuestion).getByText("Should Archive stay in the action row?")).toBeInTheDocument();

    // Verify chronological order inside the thread
    const thread = screen.getByTestId("task-thread");
    const textContent = thread.textContent ?? "";
    const descIdx = textContent.indexOf("The task detail modal has outgrown a dialog.");
    const runStartIdx = textContent.indexOf("started a T3 run");
    const statusEventIdx = textContent.indexOf("moved from To Do to In Progress");
    const checkpointIdx = textContent.indexOf("Checkpoint saved: “Added /tasks/:code route”");
    const humanCommentIdx = textContent.indexOf("Use the existing TaskModal for editing.");
    const agentQuestionIdx = textContent.indexOf("Should Archive stay in the action row?");

    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(runStartIdx).toBeGreaterThan(descIdx);
    expect(statusEventIdx).toBeGreaterThan(descIdx);
    expect(checkpointIdx).toBeGreaterThan(runStartIdx);
    expect(humanCommentIdx).toBeGreaterThan(checkpointIdx);
    expect(agentQuestionIdx).toBeGreaterThan(humanCommentIdx);
  });

  describe("Composer Send behavior", () => {
    it("replies to a waiting agent via replyToTaskT3Run, supports Cmd/Ctrl+Enter, and offers Resolve without reply", async () => {
      const user = userEvent.setup();
      const run = makeRun(task.id, "waiting_for_approval");
      vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({ run, pendingQuestions: [] });

      const waitingTask: Task = {
        ...task,
        needsHuman: "Should Archive stay in the action row?",
      };

      const { onNeedsHumanResolve } = renderPage({ agentRun: run }, waitingTask);

      const routeStrip = await screen.findByTestId("composer-route-strip");
      expect(routeStrip).toHaveTextContent("Replying to Codex");

      // Resolve without reply button in strip
      const resolveBtn = within(routeStrip).getByRole("button", { name: "Resolve without reply" });
      await user.click(resolveBtn);
      expect(onNeedsHumanResolve).toHaveBeenCalledWith(waitingTask);

      // Sending a message calls replyToTaskT3Run and resolves needsHuman
      const input = screen.getByLabelText("Message");
      await user.type(input, "Keep Archive visible.{Control>}{Enter}{/Control}");

      await waitFor(() => {
        expect(t3Service.replyToTaskT3Run).toHaveBeenCalledWith(
          task.id,
          expect.objectContaining({
            body: "Keep Archive visible.",
          }),
        );
      });
      expect(onNeedsHumanResolve).toHaveBeenCalledTimes(2);
    });

    it("posts a plain comment without interrupting or starting a run when the agent is working or absent", async () => {
      const user = userEvent.setup();
      const workingRun = makeRun(task.id, "working");
      vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({
        run: workingRun,
        pendingQuestions: [],
      });

      renderPage({ agentRun: workingRun });

      const routeStrip = await screen.findByTestId("composer-route-strip");
      expect(routeStrip).toHaveTextContent("Codex is working. This posts a comment.");

      const input = screen.getByLabelText("Message");
      await user.type(input, "Note while working");
      await user.click(screen.getByRole("button", { name: "Send" }));

      expect(await screen.findByText("Note while working")).toBeInTheDocument();
      expect(t3Service.replyToTaskT3Run).not.toHaveBeenCalled();
      const stored = await storage.getComments(task.id);
      expect(stored).toMatchObject([{ body: "Note while working", authorType: "human" }]);
    });
  });

  describe("Action row", () => {
    it("changes status, completes, edits, archives, and opens the ⋯ menu for Move to backlog and Delete", async () => {
      const user = userEvent.setup();
      const {
        onStatusChange,
        onComplete,
        onEdit,
        onArchive,
        onMoveToBacklog,
        onDelete,
      } = renderPage();

      const actionRow = screen.getByTestId("task-action-row");

      // Status select
      await user.selectOptions(within(actionRow).getByLabelText("Change status"), "done");
      expect(onStatusChange).toHaveBeenCalledWith(task, "done");

      // Complete
      await user.click(within(actionRow).getByRole("button", { name: "Complete" }));
      expect(onComplete).toHaveBeenCalledWith(task);

      // Edit
      await user.click(within(actionRow).getByRole("button", { name: "Edit" }));
      expect(onEdit).toHaveBeenCalledWith(task);

      // Archive
      await user.click(within(actionRow).getByRole("button", { name: "Archive" }));
      expect(onArchive).toHaveBeenCalledWith(task);

      // ⋯ menu -> Move to backlog
      await user.click(within(actionRow).getByRole("button", { name: "More actions" }));
      const menu = screen.getByRole("menu", { name: "More actions" });
      await user.click(within(menu).getByRole("menuitem", { name: "Move to backlog" }));
      expect(onMoveToBacklog).toHaveBeenCalledWith(task);
      expect(screen.queryByRole("menu", { name: "More actions" })).not.toBeInTheDocument();

      // ⋯ menu -> Delete
      await user.click(within(actionRow).getByRole("button", { name: "More actions" }));
      await user.click(
        within(screen.getByRole("menu", { name: "More actions" })).getByRole("menuitem", {
          name: "Delete",
        }),
      );
      expect(onDelete).toHaveBeenCalledWith(task);
    });

    it("shows Approve and Reject when the task is awaiting approval", async () => {
      const user = userEvent.setup();
      const pendingTask: Task = { ...task, pendingApproval: true, status: "todo" };
      const { onApprove, onDelete } = renderPage({}, pendingTask);

      const actionRow = screen.getByTestId("task-action-row");
      await user.click(within(actionRow).getByRole("button", { name: "Approve" }));
      expect(onApprove).toHaveBeenCalledWith(pendingTask);

      await user.click(within(actionRow).getByRole("button", { name: "Reject" }));
      expect(onDelete).toHaveBeenCalledWith(pendingTask);
    });
  });

  describe("Side rail and mobile details strip", () => {
    it("displays agent run card, project, priority, subtasks progress, and toggles mobile details strip", async () => {
      const user = userEvent.setup();
      const run = makeRun(task.id, "waiting_for_approval");
      vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({ run, pendingQuestions: [] });

      renderPage({ agentRun: run });

      const rail = screen.getByRole("complementary", { name: "Task details" });
      expect(within(rail).getByTestId("rail-agent-run-card")).toHaveTextContent("Waiting for input");
      expect(within(rail).getByText("1 of 2")).toBeInTheDocument();
      expect(within(rail).getByText("High")).toBeInTheDocument();

      const toggle = within(rail).getByTestId("mobile-details-toggle");
      const content = within(rail).getByTestId("task-rail-content");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(content.className).toContain("hidden");

      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(content.className).toContain("block");
    });
  });
});
