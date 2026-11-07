import type { AgentRun, Project, Task } from "@bitig/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchRealtimeEvent } from "../hooks/useRealtime";
import { NEEDS_YOU_VISIBLE_LIMIT } from "./dashboard/NeedsYou";
import { Overview } from "./Overview";

const NOW = new Date("2026-03-10T12:00:00.000Z");
const LONG_AGO = "2026-03-01T00:00:00.000Z";

const PROJECT_ALPHA: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  key: "ALP",
  description: "",
  kind: "paid",
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
};

function task(number: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `01940000-0000-7000-8000-${String(100 + number).padStart(12, "0")}`,
    projectId: PROJECT_ALPHA.id,
    title: `Task ${String(number)}`,
    description: "",
    status: "in_progress",
    number,
    isPublic: false,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...overrides,
  };
}

function run(forTask: Task, state: AgentRun["state"], overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: `01940000-0000-7000-8000-${String(900 + Number(forTask.number)).padStart(12, "0")}`,
    taskId: forTask.id,
    t3ProjectId: "t3",
    threadId: `thread-${String(forTask.number)}`,
    link: `https://t3.example.test/thread-${String(forTask.number)}`,
    state,
    startedAt: "2026-03-10T10:00:00.000Z",
    updatedAt: "2026-03-10T11:00:00.000Z",
    ...overrides,
  };
}

const WAITING = task(1, { title: "Configure billing" });
const QUESTION = task(2, { title: "Pick a database", needsHuman: "Postgres or SQLite?" });
const BACKLOG = task(3, { title: "Proposed refactor", status: "todo", pendingApproval: true, needsHuman: "Worth it?" });
const DONE = task(4, { title: "Write docs", status: "done", completedAt: LONG_AGO });
const WORKING = task(5, {
  title: "Build API",
  checklist: [
    { text: "Routes", done: true },
    { text: "Validation", done: false },
  ],
});
const STALLED = task(6, { title: "Forgotten task" });

const TASKS = [WAITING, QUESTION, BACKLOG, DONE, WORKING, STALLED];
const RUNS = [run(WAITING, "waiting_for_approval"), run(WORKING, "working", { model: "opus" })];

function renderOverview(props: Partial<Parameters<typeof Overview>[0]> = {}) {
  return render(
    <Overview
      mode="cloudflare"
      projects={[PROJECT_ALPHA]}
      tasks={TASKS}
      agentRuns={RUNS}
      activeSessions={[]}
      now={NOW}
      {...props}
    />,
  );
}

describe("Overview", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/app");
  });

  it("lists what needs the person, most urgent first, with direct actions", async () => {
    const user = userEvent.setup();
    const onArchiveTask = vi.fn();
    renderOverview({ onArchiveTask });

    const inbox = screen.getByRole("region", { name: /Needs you/ });
    const rows = within(inbox).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-reason"))).toEqual([
      "thread_waiting",
      "needs_human",
      "review_done",
    ]);
    expect(within(inbox).getByText("3")).toBeInTheDocument();
    // Backlog tasks wait for approval on the Tasks page, not in the inbox.
    expect(within(inbox).queryByText("Proposed refactor")).not.toBeInTheDocument();

    expect(within(inbox).getByRole("link", { name: "Open ALP-1 Configure billing in T3" })).toHaveAttribute(
      "href",
      "https://t3.example.test/thread-1",
    );
    expect(within(inbox).getByRole("link", { name: "Respond: ALP-1 Configure billing" })).toHaveAttribute(
      "href",
      "/app?task=ALP-1",
    );
    expect(within(inbox).getByText("Postgres or SQLite?")).toBeInTheDocument();

    await user.click(within(inbox).getByRole("button", { name: "Archive Write docs" }));
    expect(onArchiveTask).toHaveBeenCalledWith(DONE);
  });

  it("shows an agent that ended while its task is still in progress", () => {
    renderOverview({ tasks: [WORKING], agentRuns: [run(WORKING, "failed")] });
    const inbox = screen.getByRole("region", { name: /Needs you/ });
    expect(within(inbox).getByText("Agent failed")).toBeInTheDocument();
    expect(within(inbox).getByRole("link", { name: "Review: ALP-5 Build API" })).toBeInTheDocument();
  });

  it("shows an empty inbox and collapses a long one", async () => {
    const user = userEvent.setup();
    const { unmount } = renderOverview({ tasks: [], agentRuns: [] });
    expect(screen.getByText("Nothing needs you right now.")).toBeInTheDocument();
    unmount();

    const total = NEEDS_YOU_VISIBLE_LIMIT + 2;
    const doneTasks = Array.from({ length: total }, (_, index) =>
      task(20 + index, { status: "done", completedAt: LONG_AGO }),
    );
    renderOverview({ tasks: doneTasks, agentRuns: [] });
    const inbox = screen.getByRole("region", { name: /Needs you/ });
    expect(within(inbox).getAllByRole("listitem")).toHaveLength(NEEDS_YOU_VISIBLE_LIMIT);
    await user.click(within(inbox).getByRole("button", { name: "Show 2 more" }));
    expect(within(inbox).getAllByRole("listitem")).toHaveLength(total);
  });

  it("lists agents working now with model, start time, next subtask and thread link", () => {
    renderOverview();
    const working = screen.getByRole("region", { name: /Agents working now/ });
    const rows = within(working).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    if (row === undefined) throw new Error("expected a working row");
    expect(within(row).getByRole("link", { name: "ALP-5 Build API" })).toHaveAttribute("href", "/app?task=ALP-5");
    expect(within(row).getByText(/opus · started/)).toBeInTheDocument();
    expect(within(row).getByText("2 hours ago")).toBeInTheDocument();
    expect(within(row).getByText("Validation")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Open ALP-5 Build API in T3" })).toBeInTheDocument();
  });

  it("shows project-level threads without a task", () => {
    renderOverview({
      agentRuns: [],
      activeSessions: [
        { threadId: "thread-p", projectId: PROJECT_ALPHA.id, t3ProjectId: "t3", state: "working", title: "Ad-hoc chat" },
      ],
    });
    const working = screen.getByRole("region", { name: /Agents working now/ });
    expect(within(working).getByText("Ad-hoc chat")).toBeInTheDocument();
  });

  it("shows an umbrella session waiting on a child task in Agents working now (#BIT-141)", () => {
    const umbrella = task(10, { title: "Umbrella task" });
    const child = task(11, { title: "Child task" });
    renderOverview({
      tasks: [umbrella, child],
      agentRuns: [
        run(umbrella, "waiting_subagent", { waitingForTaskId: child.id }),
        run(child, "working"),
      ],
    });
    const working = screen.getByRole("region", { name: /Agents working now/ });
    expect(within(working).getByText("waiting for subagent")).toBeInTheDocument();
    expect(within(working).getByText("#ALP-11")).toBeInTheDocument();
    expect(within(working).getByRole("link", { name: /#ALP-11.*Child task/i })).toHaveAttribute(
      "href",
      "/app?task=ALP-11",
    );
    expect(within(working).getByRole("link", { name: /Child thread/i })).toHaveAttribute(
      "href",
      "https://t3.example.test/thread-11",
    );
  });

  it("hides the T3 board without a Worker backend", () => {
    renderOverview({ mode: "local", agentRuns: [] });
    expect(screen.queryByRole("region", { name: /Agents working now/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: /Stalled/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /in T3$/ })).not.toBeInTheDocument();
  });

  it("starts a stalled task in T3 and shows a failure on its row", async () => {
    const user = userEvent.setup();
    const onStartT3Thread = vi
      .fn<(task: Task) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Project is not mapped to a T3 project"))
      .mockResolvedValueOnce(undefined);
    renderOverview({ onStartT3Thread });

    const stalled = screen.getByRole("region", { name: /Stalled/ });
    expect(within(stalled).getAllByRole("listitem")).toHaveLength(1);
    const start = within(stalled).getByRole("button", { name: "Start ALP-6 Forgotten task in T3" });

    await user.click(start);
    expect(onStartT3Thread).toHaveBeenCalledWith(STALLED);
    expect(await within(stalled).findByRole("alert")).toHaveTextContent("Project is not mapped to a T3 project");

    await user.click(start);
    expect(within(stalled).queryByRole("alert")).not.toBeInTheDocument();
  });

  it("invites creating a project when there are none", () => {
    renderOverview({ projects: [], tasks: [] });
    expect(screen.getByRole("heading", { name: "No projects yet" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Needs you/ })).not.toBeInTheDocument();
  });

  it("loads T3 sessions itself and updates live from realtime events", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ runs: [run(WORKING, "working")], activeSessions: [] }))),
    );
    render(<Overview mode="cloudflare" projects={[PROJECT_ALPHA]} tasks={[WORKING]} now={NOW} />);

    const working = screen.getByRole("region", { name: /Agents working now/ });
    expect(await within(working).findByRole("link", { name: "ALP-5 Build API" })).toBeInTheDocument();

    act(() => {
      dispatchRealtimeEvent({ type: "agent_run.updated", run: run(WORKING, "waiting_for_approval") });
    });

    expect(within(working).getByText("No agent is working right now.")).toBeInTheDocument();
    const inbox = screen.getByRole("region", { name: /Needs you/ });
    expect(within(inbox).getByText("Agent is waiting for you")).toBeInTheDocument();
  });

  it("reports a failed T3 load with a retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ error: "T3 host unreachable" }, { status: 502 }))),
    );
    render(<Overview mode="cloudflare" projects={[PROJECT_ALPHA]} tasks={[WORKING]} now={NOW} />);

    const working = screen.getByRole("region", { name: /Agents working now/ });
    expect(await within(working).findByRole("alert")).toHaveTextContent(/Could not load T3 sessions/);
    expect(within(working).getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("shows queued runs in Agents working now with Dispatch now and Cancel queued run controls (#BIT-161)", async () => {
    const user = userEvent.setup();
    const onDispatchQueuedRun = vi.fn<(taskId: string) => Promise<void>>().mockResolvedValue(undefined);
    const onCancelQueuedRun = vi.fn<(taskId: string) => Promise<void>>().mockResolvedValue(undefined);
    const queuedTask = task(15, { title: "Queued offline task" });

    renderOverview({
      tasks: [queuedTask],
      agentRuns: [run(queuedTask, "queued", { threadId: "queued:run-15", model: "opus" })],
      onDispatchQueuedRun,
      onCancelQueuedRun,
    });

    const working = screen.getByRole("region", { name: /Agents working now/ });
    expect(within(working).getByText("queued")).toBeInTheDocument();
    expect(within(working).getByRole("link", { name: "ALP-15 Queued offline task" })).toBeInTheDocument();

    await user.click(within(working).getByRole("button", { name: /dispatch now/i }));
    expect(onDispatchQueuedRun).toHaveBeenCalledWith(queuedTask.id);

    await user.click(within(working).getByRole("button", { name: /cancel queued run/i }));
    expect(onCancelQueuedRun).toHaveBeenCalledWith(queuedTask.id);
  });
});
