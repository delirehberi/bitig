import {
  InMemoryStorage,
  type AgentRun,
  type AgentRunChild,
  type Project,
  type Task,
  type UmbrellaChildrenStatusResponse,
} from "@bitig/core";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskMentionsProvider } from "../../domain/task-mentions-context";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import * as t3Service from "../../services/t3";
import { TaskBoard } from "./TaskBoard";
import { TaskDetailModal } from "./TaskDetailModal";
import { TaskDetailPage } from "./TaskDetailPage";
import { TaskList } from "./TaskList";
import { UmbrellaChildrenPanel } from "./UmbrellaChildrenPanel";

const TIMESTAMP = "2026-11-12T12:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig",
  key: "BIT",
  description: "",
  kind: "paid",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function makeTask(number: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `01940000-0000-7000-8000-${String(number).padStart(12, "0")}`,
    projectId: PROJECT.id,
    title: `Task ${String(number)}`,
    description: "",
    status: "todo",
    number,
    isPublic: false,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

const UMBRELLA = makeTask(183, {
  title: "Umbrella: Model routing and parallel children",
  status: "in_progress",
  checklist: [
    { text: "#BIT-189 Done & merged child", done: true },
    { text: "#BIT-190 Running child A", done: false },
    { text: "#BIT-191 Running child B", done: false },
    { text: "#BIT-192 Ready child C", done: false },
    { text: "#BIT-193 Blocked child D", done: false },
  ],
});

const CHILD_189 = makeTask(189, {
  title: "Parallel child batches",
  description: "Plan attached to #BIT-183.",
  status: "done",
});
const CHILD_190 = makeTask(190, {
  title: "Child worktrees and merges",
  description: "Plan attached to #BIT-183.",
  status: "in_progress",
});
const CHILD_191 = makeTask(191, {
  title: "Run orchestration: umbrella children panel in the web app",
  description: "Plan attached to #BIT-183.",
  status: "in_progress",
});
const CHILD_192 = makeTask(192, {
  title: "Component tests and polish",
  description: "Plan attached to #BIT-183.",
  status: "todo",
});
const CHILD_193 = makeTask(193, {
  title: "End-to-end verification",
  description: "Plan attached to #BIT-183.",
  status: "todo",
  dependsOn: [CHILD_191.id],
});

function makeChildrenStatus(
  overrides: Partial<UmbrellaChildrenStatusResponse> = {},
): UmbrellaChildrenStatusResponse {
  return {
    parentTaskId: UMBRELLA.id,
    progress: {
      total: 5,
      running: 2,
      merged: 1,
      done: 1,
    },
    maxParallelChildren: 3,
    launchReadiness: { ready: true },
    readyBatch: [
      {
        taskId: CHILD_192.id,
        code: "BIT-192",
        title: CHILD_192.title,
        levelKey: "cheap",
        levelLabel: "Cheap",
        providerInstanceId: "codex",
        model: "gpt-5.4-mini",
        effort: "low",
        touches: ["apps/web/src/components/tasks/**"],
      },
    ],
    children: [
      {
        taskId: CHILD_189.id,
        code: "BIT-189",
        title: CHILD_189.title,
        taskStatus: "done",
        childState: "done",
        runState: "finished",
        isRunning: false,
        levelKey: "standard",
        levelLabel: "Standard",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-4-7",
        effort: "medium",
        branch: "bitig/BIT-189",
        headSha: "1111111111111111111111111111111111111111",
        diffStat: { filesChanged: 4, insertions: 120, deletions: 18 },
        merged: true,
        mergedAt: TIMESTAMP,
        mergedSha: "2222222222222222222222222222222222222222",
        inReadyBatch: false,
      },
      {
        taskId: CHILD_190.id,
        code: "BIT-190",
        title: CHILD_190.title,
        taskStatus: "in_progress",
        childState: "running",
        runState: "working",
        isRunning: true,
        threadId: "thread-190",
        link: "https://t3.example.test/threads/thread-190",
        levelKey: "strong",
        levelLabel: "Strong",
        providerInstanceId: "claudeAgent",
        model: "claude-opus-4-7",
        effort: "high",
        branch: "bitig/BIT-190",
        headSha: "3333333333333333333333333333333333333333",
        diffStat: { filesChanged: 2, insertions: 64, deletions: 5 },
        merged: false,
        inReadyBatch: false,
      },
      {
        taskId: CHILD_191.id,
        code: "BIT-191",
        title: CHILD_191.title,
        taskStatus: "in_progress",
        childState: "running",
        runState: "working",
        isRunning: true,
        threadId: "thread-191",
        levelKey: "standard",
        levelLabel: "Standard",
        providerInstanceId: "codex",
        model: "gpt-5.4",
        branch: "bitig/BIT-191",
        merged: false,
        inReadyBatch: false,
      },
      {
        taskId: CHILD_192.id,
        code: "BIT-192",
        title: CHILD_192.title,
        taskStatus: "todo",
        isRunning: false,
        levelKey: "cheap",
        levelLabel: "Cheap",
        providerInstanceId: "codex",
        model: "gpt-5.4-mini",
        effort: "low",
        touches: ["apps/web/src/components/tasks/**"],
        merged: false,
        inReadyBatch: true,
      },
      {
        taskId: CHILD_193.id,
        code: "BIT-193",
        title: CHILD_193.title,
        taskStatus: "todo",
        isRunning: false,
        levelKey: "standard",
        levelLabel: "Standard",
        model: "claude-opus-4-7",
        merged: false,
        waitingReason: {
          reason: "blocked",
          detail: "Task BIT-193 is blocked by unfinished dependencies: BIT-191",
          blockingTaskId: CHILD_191.id,
          blockingTaskCode: "BIT-191",
        },
        inReadyBatch: false,
      },
    ],
    ...overrides,
  };
}

describe("UmbrellaChildrenPanel & umbrella progress UI (#BIT-191)", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/tasks");
    vi.restoreAllMocks();
  });

  it("renders child state, tier & model, branch, diff stat, merged status, and waiting skip reasons (dependency, path overlap, cap, serial path)", async () => {
    const childOverlap = makeTask(194, { title: "Overlapping child" });
    const childCap = makeTask(195, { title: "Cap-limited child" });
    const childSerial = makeTask(196, { title: "Migration child" });

    const base = makeChildrenStatus();
    vi.spyOn(t3Service, "fetchUmbrellaChildren").mockResolvedValue({
      ...base,
      children: [
        ...base.children,
        {
          taskId: childOverlap.id,
          code: "BIT-194",
          title: childOverlap.title,
          taskStatus: "todo",
          isRunning: false,
          merged: false,
          waitingReason: {
            reason: "overlaps_running",
            detail: 'Task BIT-194 path "apps/worker/**" overlaps running task BIT-190 path "apps/worker/**"',
            blockingTaskCode: "BIT-190",
            overlappingPath: "apps/worker/**",
          },
          inReadyBatch: false,
        },
        {
          taskId: childCap.id,
          code: "BIT-195",
          title: childCap.title,
          taskStatus: "todo",
          isRunning: false,
          merged: false,
          waitingReason: {
            reason: "cap_reached",
            detail: "Parallel cap (3) reached",
          },
          inReadyBatch: false,
        },
        {
          taskId: childSerial.id,
          code: "BIT-196",
          title: childSerial.title,
          taskStatus: "todo",
          isRunning: false,
          merged: false,
          waitingReason: {
            reason: "touches_serial_path",
            detail: 'Task BIT-196 touches serial path "packages/storage-d1/migrations/**" and cannot run alongside other tasks',
            overlappingPath: "packages/storage-d1/migrations/**",
          },
          inReadyBatch: false,
        },
      ],
    });

    render(<UmbrellaChildrenPanel task={UMBRELLA} />);

    const panel = await screen.findByTestId("umbrella-children-panel");
    expect(within(panel).getByTestId("umbrella-progress-badge")).toHaveTextContent(
      "2 of 5 running, 1 merged",
    );

    // Child 189: Done, Standard, claude-opus-4-7 · medium, branch bitig/BIT-189, diffStat 4f +120 −18, Merged · 2222222
    const row189 = within(panel).getByTestId("umbrella-child-row-BIT-189");
    expect(within(row189).getByText("Done")).toBeInTheDocument();
    expect(within(row189).getByText("Standard")).toBeInTheDocument();
    expect(within(row189).getByText("claude-opus-4-7 \u00b7 medium")).toBeInTheDocument();
    expect(within(row189).getByText("bitig/BIT-189")).toBeInTheDocument();
    expect(within(row189).getByText("1111111")).toBeInTheDocument();
    expect(within(row189).getByText("4f")).toBeInTheDocument();
    expect(within(row189).getByText("+120")).toBeInTheDocument();
    expect(within(row189).getByText("\u221218")).toBeInTheDocument();
    expect(within(row189).getByText("Merged \u00b7 2222222")).toBeInTheDocument();

    // Child 190: Running, Strong, Not merged, Stop button
    const row190 = within(panel).getByTestId("umbrella-child-row-BIT-190");
    expect(within(row190).getByText("Running")).toBeInTheDocument();
    expect(within(row190).getByText("Strong")).toBeInTheDocument();
    expect(within(row190).getByText("Not merged")).toBeInTheDocument();
    expect(within(row190).getByRole("button", { name: "Stop BIT-190" })).toBeInTheDocument();

    // Waiting reasons: Dependency, Path overlap, Cap reached, Serial path
    const row193 = within(panel).getByTestId("umbrella-child-row-BIT-193");
    expect(within(row193).getByText("Waiting")).toBeInTheDocument();
    expect(within(row193).getByText("Dependency")).toBeInTheDocument();
    expect(within(row193).getByText(/blocked by unfinished dependencies: BIT-191/)).toBeInTheDocument();

    const row194 = within(panel).getByTestId("umbrella-child-row-BIT-194");
    expect(within(row194).getByText("Path overlap")).toBeInTheDocument();

    const row195 = within(panel).getByTestId("umbrella-child-row-BIT-195");
    expect(within(row195).getByText("Cap reached")).toBeInTheDocument();

    const row196 = within(panel).getByTestId("umbrella-child-row-BIT-196");
    expect(within(row196).getByText("Serial path")).toBeInTheDocument();
  });

  it("shows the ready batch for confirmation before calling startUmbrellaReadyChildren, and supports stopping one child or all", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi
      .spyOn(t3Service, "fetchUmbrellaChildren")
      .mockResolvedValue(makeChildrenStatus());
    const startBatchSpy = vi
      .spyOn(t3Service, "startUmbrellaReadyChildren")
      .mockResolvedValue({ started: [], skipped: [] });
    const stopOneSpy = vi
      .spyOn(t3Service, "stopTaskT3Run")
      .mockResolvedValue({ run: null, pendingQuestions: [] });
    const stopAllSpy = vi
      .spyOn(t3Service, "stopAllUmbrellaChildren")
      .mockResolvedValue({ stoppedTaskIds: [CHILD_190.id, CHILD_191.id] });

    render(<UmbrellaChildrenPanel task={UMBRELLA} />);
    await screen.findByTestId("umbrella-children-panel");

    // Clicking "Run ready children" previews the batch first without starting it
    await user.click(screen.getByRole("button", { name: /Run ready children/i }));
    const confirmBox = screen.getByTestId("umbrella-batch-confirm");
    expect(within(confirmBox).getByText(/Start 1 ready child/i)).toBeInTheDocument();
    expect(within(confirmBox).getByText("BIT-192")).toBeInTheDocument();
    expect(within(confirmBox).getByText("Cheap")).toBeInTheDocument();
    expect(within(confirmBox).getByText("gpt-5.4-mini \u00b7 low")).toBeInTheDocument();
    expect(within(confirmBox).getByText("apps/web/src/components/tasks/**")).toBeInTheDocument();
    expect(startBatchSpy).not.toHaveBeenCalled();

    // Cancel hides the confirmation box without launching
    await user.click(within(confirmBox).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("umbrella-batch-confirm")).not.toBeInTheDocument();
    expect(startBatchSpy).not.toHaveBeenCalled();

    // Re-open and confirm launch
    await user.click(screen.getByRole("button", { name: /Run ready children/i }));
    await user.click(
      within(screen.getByTestId("umbrella-batch-confirm")).getByRole("button", {
        name: "Start 1 child",
      }),
    );
    expect(startBatchSpy).toHaveBeenCalledWith(UMBRELLA.id);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Stop a single child
    await user.click(screen.getByRole("button", { name: "Stop BIT-190" }));
    expect(stopOneSpy).toHaveBeenCalledWith(CHILD_190.id);

    // Stop all running children
    await user.click(screen.getByRole("button", { name: "Stop all" }));
    expect(stopAllSpy).toHaveBeenCalledWith(UMBRELLA.id);
  });

  it("blocks confirmation start when the umbrella worktree is not launch-ready", async () => {
    const user = userEvent.setup();
    vi.spyOn(t3Service, "fetchUmbrellaChildren").mockResolvedValue(
      makeChildrenStatus({
        launchReadiness: {
          ready: false,
          reason: "Umbrella task BIT-183 has uncommitted changes in its worktree; commit or stash first.",
        },
      }),
    );

    render(<UmbrellaChildrenPanel task={UMBRELLA} />);
    await screen.findByTestId("umbrella-children-panel");

    await user.click(screen.getByRole("button", { name: /Run ready children/i }));
    const confirmBox = screen.getByTestId("umbrella-batch-confirm");
    expect(within(confirmBox).getByRole("alert")).toHaveTextContent(/uncommitted changes/i);
    expect(within(confirmBox).getByRole("button", { name: "Start 1 child" })).toBeDisabled();
  });

  it("updates child rows and umbrella progress live on agent_run_child.updated realtime events", async () => {
    vi.spyOn(t3Service, "fetchUmbrellaChildren")
      .mockResolvedValueOnce(makeChildrenStatus())
      .mockRejectedValue(new Error("offline"));

    render(<UmbrellaChildrenPanel task={UMBRELLA} />);
    const panel = await screen.findByTestId("umbrella-children-panel");
    expect(within(panel).getByTestId("umbrella-progress-badge")).toHaveTextContent(
      "2 of 5 running, 1 merged",
    );

    act(() => {
      dispatchRealtimeEvent({
        type: "agent_run_child.updated",
        child: {
          parentTaskId: UMBRELLA.id,
          childTaskId: CHILD_190.id,
          state: "done",
          branch: "bitig/BIT-190",
          headSha: "4444444444444444444444444444444444444444",
          mergedAt: TIMESTAMP,
          mergedSha: "9999999999999999999999999999999999999999",
          startedAt: TIMESTAMP,
          finishedAt: TIMESTAMP,
        },
      });
    });

    await waitFor(() => {
      expect(within(panel).getByTestId("umbrella-progress-badge")).toHaveTextContent(
        "1 of 5 running, 2 merged",
      );
    });
    const row190 = within(panel).getByTestId("umbrella-child-row-BIT-190");
    expect(within(row190).getByText("Done")).toBeInTheDocument();
    expect(within(row190).getByText("Merged \u00b7 9999999")).toBeInTheDocument();
  });

  it("renders inside TaskDetailModal and TaskDetailPage for umbrella tasks", async () => {
    const storage = new InMemoryStorage();
    vi.spyOn(t3Service, "fetchT3Connection").mockResolvedValue({ connected: true });
    vi.spyOn(t3Service, "fetchT3ProjectMappings").mockResolvedValue([]);
    vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({ run: null, pendingQuestions: [] });
    vi.spyOn(t3Service, "fetchT3Runs").mockResolvedValue({ runs: [] });
    vi.spyOn(t3Service, "fetchT3Capabilities").mockResolvedValue([]);
    vi.spyOn(t3Service, "fetchUmbrellaChildren").mockResolvedValue(makeChildrenStatus());

    const { unmount } = render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskMentionsProvider projects={[PROJECT]} tasks={[UMBRELLA, CHILD_189]}>
          <TaskDetailModal
            task={UMBRELLA}
            projects={[PROJECT]}
            storage={storage}
            isUmbrella
            onClose={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onComplete={vi.fn()}
          />
        </TaskMentionsProvider>
      </FeatureFlagsProvider>,
    );

    expect(await screen.findByTestId("umbrella-children-panel")).toBeInTheDocument();
    unmount();

    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskMentionsProvider projects={[PROJECT]} tasks={[UMBRELLA, CHILD_189]}>
          <TaskDetailPage
            task={UMBRELLA}
            projects={[PROJECT]}
            storage={storage}
            isUmbrella
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onComplete={vi.fn()}
            onStatusChange={vi.fn()}
          />
        </TaskMentionsProvider>
      </FeatureFlagsProvider>,
    );

    expect(await screen.findByTestId("umbrella-children-panel")).toBeInTheDocument();
  });

  it("shows '2 of 5 running, 1 merged' on umbrella cards in TaskBoard and TaskList without false badges on leaf tasks", () => {
    const tasks = [UMBRELLA, CHILD_189, CHILD_190, CHILD_191, CHILD_192, CHILD_193];
    const agentRuns: AgentRun[] = [
      {
        id: "01940000-0000-7000-8000-000000009190",
        taskId: CHILD_190.id,
        parentTaskId: UMBRELLA.id,
        t3ProjectId: "t3-proj",
        threadId: "thread-190",
        state: "working",
        startedAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
      {
        id: "01940000-0000-7000-8000-000000009191",
        taskId: CHILD_191.id,
        parentTaskId: UMBRELLA.id,
        t3ProjectId: "t3-proj",
        threadId: "thread-191",
        state: "working",
        startedAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
      },
    ];
    const umbrellaChildren: AgentRunChild[] = [
      {
        parentTaskId: UMBRELLA.id,
        childTaskId: CHILD_189.id,
        state: "done",
        mergedAt: TIMESTAMP,
        mergedSha: "2222222222222222222222222222222222222222",
        startedAt: TIMESTAMP,
        finishedAt: TIMESTAMP,
      },
      {
        parentTaskId: UMBRELLA.id,
        childTaskId: CHILD_190.id,
        state: "running",
        startedAt: TIMESTAMP,
      },
      {
        parentTaskId: UMBRELLA.id,
        childTaskId: CHILD_191.id,
        state: "running",
        startedAt: TIMESTAMP,
      },
    ];

    const { unmount } = render(
      <TaskMentionsProvider projects={[PROJECT]} tasks={tasks}>
        <TaskBoard
          tasks={tasks}
          projects={[PROJECT]}
          agentRuns={agentRuns}
          umbrellaChildren={umbrellaChildren}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
          onMove={vi.fn()}
        />
      </TaskMentionsProvider>,
    );

    const boardBadges = screen.getAllByTestId("umbrella-progress-badge");
    expect(boardBadges).toHaveLength(1);
    expect(boardBadges[0]).toHaveTextContent("2 of 5 running, 1 merged");
    unmount();

    render(
      <TaskMentionsProvider projects={[PROJECT]} tasks={tasks}>
        <TaskList
          tasks={tasks}
          projects={[PROJECT]}
          agentRuns={agentRuns}
          umbrellaChildren={umbrellaChildren}
          onView={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </TaskMentionsProvider>,
    );

    const listBadges = screen.getAllByTestId("umbrella-progress-badge");
    expect(listBadges).toHaveLength(1);
    expect(listBadges[0]).toHaveTextContent("2 of 5 running, 1 merged");
  });
});
