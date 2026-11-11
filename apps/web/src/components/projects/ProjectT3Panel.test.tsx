import {
  buildProjectT3LaunchPrompt,
  type Project,
  type ProjectT3Thread,
  type T3ConnectionStatus,
  type T3ModelCapability,
} from "@bitig/core";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  T3ApiError,
  fetchProjectT3ThreadMessages,
  fetchProjectT3Threads,
  fetchT3Capabilities,
  fetchT3Connection,
  fetchT3Hosts,
  fetchT3ProjectMappings,
  sendProjectT3Message,
  settleProjectT3Thread,
  startProjectT3Thread,
} from "../../services/t3";
import { PROJECT_T3_POLL_INTERVAL_MS, ProjectT3Panel } from "./ProjectT3Panel";

vi.mock("../../services/t3", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    T3ApiError: actual.T3ApiError,
    fetchProjectT3ThreadMessages: vi.fn(),
    fetchProjectT3Threads: vi.fn(),
    fetchT3Capabilities: vi.fn(),
    fetchT3Connection: vi.fn(),
    fetchT3Hosts: vi.fn(),
    fetchT3ProjectMappings: vi.fn(),
    sendProjectT3Message: vi.fn(),
    settleProjectT3Thread: vi.fn(),
    startProjectT3Thread: vi.fn(),
  };
});

const TIMESTAMP = "2026-11-03T10:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig",
  description: "",
  kind: "hobby",
  key: "BIT",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

const CONNECTED: T3ConnectionStatus = { connected: true, expired: false };

const CAPABILITIES: T3ModelCapability[] = [
  {
    providerInstanceId: "claudeAgent",
    displayName: "Claude",
    model: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    options: [{ id: "effort", values: ["low", "medium", "high"], default: "medium" }],
  },
  { providerInstanceId: "codex", displayName: "Codex", model: "gpt-6-sol" },
];

function makeThread(overrides: Partial<ProjectT3Thread> = {}): ProjectT3Thread {
  return {
    id: "01940000-0000-7000-8000-0000000000aa",
    projectId: PROJECT.id,
    t3ProjectId: "t3-proj",
    threadId: "thread-1",
    title: "Check the environment",
    link: "https://t3.example/threads/thread-1",
    state: "finished",
    model: "claude-opus-5-5",
    workspaceStrategy: "root",
    startedAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

function mockReady(threads: ProjectT3Thread[] = []): void {
  vi.mocked(fetchT3Connection).mockResolvedValue(CONNECTED);
  vi.mocked(fetchT3ProjectMappings).mockResolvedValue([
    { projectId: PROJECT.id, t3ProjectId: "t3-proj", t3ProjectTitle: "Bitig", updatedAt: TIMESTAMP },
  ]);
  vi.mocked(fetchT3Capabilities).mockResolvedValue(CAPABILITIES);
  vi.mocked(fetchProjectT3Threads).mockResolvedValue(threads);
}

describe("ProjectT3Panel (BIT-127)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows settlement pending and removes only the settled thread", async () => {
    mockReady([makeThread(), makeThread({ id: "second", threadId: "thread-2", title: "Keep me" })]);
    let finish: () => void = () => { throw new Error("Settlement has not started"); };
    vi.mocked(settleProjectT3Thread).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);
    await screen.findByText("Check the environment");
    const firstSettle = screen.getAllByRole("button", { name: "Settle" })[0];
    if (!firstSettle) throw new Error("Missing Settle button");
    await user.click(firstSettle);
    expect(screen.getByRole("button", { name: "Settling…" })).toBeDisabled();
    expect(settleProjectT3Thread).toHaveBeenCalledWith(PROJECT.id, "thread-1", expect.any(AbortSignal));
    await act(async () => { finish(); await Promise.resolve(); });
    expect(screen.queryByText("Check the environment")).not.toBeInTheDocument();
    expect(screen.getByText("Keep me")).toBeInTheDocument();
  });

  it("keeps a failed settlement visible and allows retry", async () => {
    mockReady([makeThread({ state: "offline" })]);
    vi.mocked(settleProjectT3Thread).mockRejectedValueOnce(new Error("Host unavailable"));
    vi.mocked(settleProjectT3Thread).mockResolvedValueOnce(undefined);
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);
    await user.click(await screen.findByRole("button", { name: "Settle" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Host unavailable");
    expect(screen.getByText("Check the environment")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Settle" }));
    expect(screen.queryByText("Check the environment")).not.toBeInTheDocument();
  });

  it("does not restore a settled thread from an older refresh response", async () => {
    const thread = makeThread();
    mockReady([thread]);
    vi.mocked(settleProjectT3Thread).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);
    await screen.findByText(thread.title);
    let finishRefresh: (threads: ProjectT3Thread[]) => void = () => { throw new Error("Refresh has not started"); };
    vi.mocked(fetchProjectT3Threads).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve; }));
    await user.click(screen.getByRole("button", { name: "Refresh project T3 threads" }));
    await user.click(screen.getByRole("button", { name: "Settle" }));
    expect(screen.queryByText(thread.title)).not.toBeInTheDocument();
    await act(async () => { finishRefresh([thread]); await Promise.resolve(); });
    expect(screen.queryByText(thread.title)).not.toBeInTheDocument();
  });

  it("aborts settlement when the panel unmounts", async () => {
    mockReady([makeThread()]);
    let signal: AbortSignal | undefined;
    vi.mocked(settleProjectT3Thread).mockImplementation((_projectId, _threadId, requestSignal) => {
      signal = requestSignal;
      return new Promise<void>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => { reject(new DOMException("Aborted", "AbortError")); });
      });
    });
    const user = userEvent.setup();
    const view = render(<ProjectT3Panel project={PROJECT} />);
    await user.click(await screen.findByRole("button", { name: "Settle" }));
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("points to Settings when T3 is not connected", async () => {
    vi.mocked(fetchT3Connection).mockResolvedValue({ connected: false });
    vi.mocked(fetchT3ProjectMappings).mockResolvedValue([]);
    render(<ProjectT3Panel project={PROJECT} />);

    expect(await screen.findByText(/connect a t3 code host in settings/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send to T3" })).not.toBeInTheDocument();
    expect(fetchProjectT3Threads).not.toHaveBeenCalled();
  });

  it("points to Settings when the project is not mapped", async () => {
    vi.mocked(fetchT3Connection).mockResolvedValue(CONNECTED);
    vi.mocked(fetchT3ProjectMappings).mockResolvedValue([]);
    render(<ProjectT3Panel project={PROJECT} />);

    expect(await screen.findByText(/map project "bitig" to a t3 project/i)).toBeInTheDocument();
    expect(fetchProjectT3Threads).not.toHaveBeenCalled();
  });

  it("starts a thread in the project root with the chosen model and lists it", async () => {
    mockReady();
    vi.mocked(startProjectT3Thread).mockResolvedValue(
      makeThread({ threadId: "thread-new", title: "Check node", state: "working" }),
    );
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} focusComposer />);

    const composer = await screen.findByLabelText("Message for Bitig in T3");
    expect(composer).toHaveFocus();
    expect(screen.getByRole("button", { name: "Send to T3" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Model"), "claudeAgent::claude-opus-5-5");
    await user.selectOptions(screen.getByLabelText("T3 effort"), "str:high");
    await user.type(composer, "Check node");
    await user.click(screen.getByRole("button", { name: "Send to T3" }));

    expect(startProjectT3Thread).toHaveBeenCalledWith(PROJECT.id, {
      prompt: "Check node",
      workspaceStrategy: "root",
      modelSelection: {
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "effort", value: "high" }],
      },
    });
    const list = await screen.findByRole("list", { name: "Project T3 threads" });
    expect(within(list).getByText("Check node")).toBeInTheDocument();
    expect(composer).toHaveValue("");
  });

  it("sends with the default model and a worktree when chosen", async () => {
    mockReady();
    vi.mocked(startProjectT3Thread).mockResolvedValue(makeThread({ state: "working" }));
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    await user.type(await screen.findByLabelText("Message for Bitig in T3"), "Try a branch");
    await user.click(screen.getByRole("checkbox", { name: /isolated git worktree/i }));
    await user.click(screen.getByRole("button", { name: "Send to T3" }));

    expect(startProjectT3Thread).toHaveBeenCalledWith(PROJECT.id, {
      prompt: "Try a branch",
      workspaceStrategy: "worktree",
    });
  });

  it("shows the server error when starting fails", async () => {
    mockReady();
    vi.mocked(startProjectT3Thread).mockRejectedValue(new T3ApiError(502, "T3 host unreachable"));
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    await user.type(await screen.findByLabelText("Message for Bitig in T3"), "Check node");
    await user.click(screen.getByRole("button", { name: "Send to T3" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("T3 host unreachable");
  });

  it("follows up on a thread and switches its model", async () => {
    const thread = makeThread();
    mockReady([thread]);
    vi.mocked(sendProjectT3Message).mockResolvedValue({
      ...thread,
      state: "working",
      model: "gpt-6-sol",
      providerInstanceId: "codex",
    });
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    expect(await screen.findByTestId("project-t3-thread-state")).toHaveTextContent("finished · claude-opus-5-5");
    expect(screen.getByRole("link", { name: 'Open "Check the environment" in T3' })).toHaveAttribute(
      "href",
      "https://t3.example/threads/thread-1",
    );

    await user.click(screen.getByRole("button", { name: 'Follow up on "Check the environment"' }));
    expect(screen.getByRole("option", { name: "Keep current model (claude-opus-5-5)" })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Reply with model"), "codex::gpt-6-sol");
    await user.type(screen.getByLabelText("Follow-up message for Check the environment"), "Now check pnpm");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(sendProjectT3Message).toHaveBeenCalledWith(PROJECT.id, "thread-1", {
      body: "Now check pnpm",
      modelSelection: { providerInstanceId: "codex", model: "gpt-6-sol" },
    });
    expect(await screen.findByTestId("project-t3-thread-state")).toHaveTextContent("working · gpt-6-sol");
  });

  it("shows the conflict message when the thread is mid-turn", async () => {
    const thread = makeThread();
    mockReady([thread]);
    vi.mocked(sendProjectT3Message).mockRejectedValue(
      new T3ApiError(409, "The T3 thread is working. Switch models only while it waits for you or after its turn ends."),
    );
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    await user.click(await screen.findByRole("button", { name: 'Follow up on "Check the environment"' }));
    await user.selectOptions(screen.getByLabelText("Reply with model"), "codex::gpt-6-sol");
    await user.type(screen.getByLabelText("Follow-up message for Check the environment"), "Switch");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The T3 thread is working.");
    expect(screen.getByLabelText("Follow-up message for Check the environment")).toHaveValue("Switch");
  });

  it("keeps the model while a thread is working and hides follow-ups when offline", async () => {
    mockReady([
      makeThread({ threadId: "busy", title: "Busy", state: "working" }),
      makeThread({ id: "second", threadId: "gone", title: "Gone", state: "offline", link: "javascript:alert(1)" }),
    ]);
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    await user.click(await screen.findByRole("button", { name: 'Follow up on "Busy"' }));
    expect(screen.getByLabelText("Reply with model")).toBeDisabled();
    expect(screen.getByText(/the model can change once the t3 thread waits/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: 'Follow up on "Gone"' })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: 'Open "Gone" in T3' })).not.toBeInTheDocument();
  });

  it("shows conversation, strips the Bitig launch header, and links truncated replies (BIT-131)", async () => {
    const thread = makeThread();
    mockReady([thread]);
    vi.mocked(fetchProjectT3ThreadMessages)
      .mockResolvedValueOnce({
        thread,
        messages: [
          {
            position: 0,
            role: "user",
            text: buildProjectT3LaunchPrompt({
              project: PROJECT,
              prompt: "Check node and wrangler versions",
            }),
            truncated: false,
            updatedAt: TIMESTAMP,
          },
        ],
        nextPosition: 0,
        hasMore: true,
      })
      .mockResolvedValueOnce({
        thread,
        messages: [
          {
            position: 3,
            role: "assistant",
            text: "Node is **v22.11.0** and Wrangler is ready.",
            truncated: true,
            updatedAt: TIMESTAMP,
          },
        ],
        nextPosition: 3,
        hasMore: false,
      });

    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    const showBtn = await screen.findByRole("button", {
      name: 'Show conversation for "Check the environment"',
    });
    await user.click(showBtn);

    const conv = await screen.findByLabelText("Conversation for Check the environment");
    expect(within(conv).getByText("Check node and wrangler versions")).toBeInTheDocument();
    expect(within(conv).queryByText(/There is no Bitig task for this thread/i)).not.toBeInTheDocument();
    expect(within(conv).getByText("v22.11.0", { selector: "strong" })).toBeInTheDocument();
    expect(within(conv).getByRole("link", { name: "Open in T3 for the full text" })).toHaveAttribute(
      "href",
      "https://t3.example/threads/thread-1",
    );
    expect(fetchProjectT3ThreadMessages).toHaveBeenCalledTimes(2);
    expect(fetchProjectT3ThreadMessages).toHaveBeenNthCalledWith(
      1,
      PROJECT.id,
      "thread-1",
      expect.objectContaining({ afterPosition: undefined }),
    );
    expect(fetchProjectT3ThreadMessages).toHaveBeenNthCalledWith(
      2,
      PROJECT.id,
      "thread-1",
      expect.objectContaining({ afterPosition: 0 }),
    );
  });

  it("polls for new messages while an expanded thread is working and stops once finished (BIT-131)", async () => {
    const workingThread = makeThread({ state: "working" });
    const finishedThread = makeThread({ state: "finished" });
    mockReady([workingThread]);
    vi.mocked(fetchProjectT3ThreadMessages)
      .mockResolvedValueOnce({
        thread: workingThread,
        messages: [
          {
            position: 0,
            role: "user",
            text: "Check node",
            truncated: false,
            updatedAt: TIMESTAMP,
          },
        ],
        nextPosition: 0,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        thread: finishedThread,
        messages: [
          {
            position: 2,
            role: "assistant",
            text: "All checks passed.",
            truncated: false,
            updatedAt: TIMESTAMP,
          },
        ],
        nextPosition: 2,
        hasMore: false,
      });

    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    const showBtn = await screen.findByRole("button", {
      name: 'Show conversation for "Check the environment"',
    });

    vi.useFakeTimers({ shouldAdvanceTime: true });
    await user.click(showBtn);

    const conv = await screen.findByLabelText("Conversation for Check the environment");
    expect(within(conv).getByText("Check node")).toBeInTheDocument();
    expect(screen.getByTestId("project-t3-thread-state")).toHaveTextContent("working · claude-opus-5-5");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_T3_POLL_INTERVAL_MS);
    });

    expect(await within(conv).findByText("All checks passed.")).toBeInTheDocument();
    expect(screen.getByTestId("project-t3-thread-state")).toHaveTextContent("finished · claude-opus-5-5");
    expect(fetchProjectT3ThreadMessages).toHaveBeenCalledTimes(2);
    expect(fetchProjectT3ThreadMessages).toHaveBeenLastCalledWith(
      PROJECT.id,
      "thread-1",
      expect.objectContaining({ afterPosition: 0 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROJECT_T3_POLL_INTERVAL_MS * 2);
    });
    expect(fetchProjectT3ThreadMessages).toHaveBeenCalledTimes(2);
  });

  it("displays stopReason when a project thread is failed or stopped (BIT-132)", async () => {
    mockReady([
      makeThread({
        state: "failed",
        stopReason: "Usage limit reached: Claude API rate limit reached. Try again later.",
      }),
    ]);

    render(<ProjectT3Panel project={PROJECT} />);

    expect(await screen.findByTestId("project-t3-thread-stop-reason")).toHaveTextContent(
      "Usage limit reached: Claude API rate limit reached. Try again later.",
    );
  });

  it("scopes follow-up and settlement to the thread's recorded host when two hosts share a threadId (BIT-149)", async () => {
    const hostAThread = makeThread({
      id: "01940000-0000-7000-8000-0000000000a1",
      hostId: "host-a",
      threadId: "same-thread",
      title: "Host A thread",
    });
    const hostBThread = makeThread({
      id: "01940000-0000-7000-8000-0000000000b2",
      hostId: "host-b",
      threadId: "same-thread",
      title: "Host B thread",
    });
    mockReady([hostAThread, hostBThread]);
    vi.mocked(settleProjectT3Thread).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    await screen.findByText("Host A thread");
    expect(screen.getByText("Host B thread")).toBeInTheDocument();

    const firstSettle = screen.getAllByRole("button", { name: "Settle" })[0];
    if (!firstSettle) throw new Error("Missing Settle button");
    await user.click(firstSettle);

    expect(settleProjectT3Thread).toHaveBeenCalledWith(
      PROJECT.id,
      "same-thread",
      expect.any(AbortSignal),
      "host-a",
    );
    expect(screen.queryByText("Host A thread")).not.toBeInTheDocument();
    expect(screen.getByText("Host B thread")).toBeInTheDocument();
  });

  it("shows read-only bound host info for non-owner members and hides host management controls (BIT-152)", async () => {
    vi.mocked(fetchT3Connection).mockResolvedValue(CONNECTED);
    vi.mocked(fetchT3Hosts).mockResolvedValue([
      {
        id: "host-laptop",
        label: "Laptop",
        mcpUrl: "https://laptop.example.com/mcp",
        issuer: "https://laptop.example.com",
        connected: true,
        kind: "user",
        projectsRoot: "~/www",
        expiresAt: "2026-12-01T00:00:00.000Z",
        expiresInDays: 20,
        expiringSoon: false,
        expired: false,
        scope: "mcp:tools",
        connectedAt: TIMESTAMP,
      },
    ]);
    vi.mocked(fetchT3ProjectMappings).mockResolvedValue([
      {
        projectId: PROJECT.id,
        hostId: "host-laptop",
        t3ProjectId: "t3-proj",
        t3ProjectTitle: "Bitig",
        workspaceRoot: "~/www/bitig",
        updatedAt: TIMESTAMP,
      },
    ]);
    vi.mocked(fetchT3Capabilities).mockResolvedValue(CAPABILITIES);
    vi.mocked(fetchProjectT3Threads).mockResolvedValue([]);

    render(<ProjectT3Panel project={PROJECT} canManageHostFolder={false} />);

    const readonlyBox = await screen.findByTestId("project-bound-host-readonly");
    expect(readonlyBox).toHaveTextContent("Laptop");
    expect(readonlyBox).toHaveTextContent("~/www/bitig");
    expect(screen.queryByRole("button", { name: "Unregister folder" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reattach on another host" })).not.toBeInTheDocument();
  });

  it("lets an owner attach an unmapped project when fetchT3Hosts returns a connected host even if project connection is unmapped (BIT-152)", async () => {
    vi.mocked(fetchT3Connection).mockResolvedValue({ connected: false });
    vi.mocked(fetchT3Hosts).mockResolvedValue([
      {
        id: "host-laptop",
        label: "Laptop",
        mcpUrl: "https://laptop.example.com/mcp",
        issuer: "https://laptop.example.com",
        connected: true,
        kind: "user",
        projectsRoot: "~/www",
        expiresAt: "2026-12-01T00:00:00.000Z",
        expiresInDays: 20,
        expiringSoon: false,
        expired: false,
        scope: "mcp:tools",
        connectedAt: TIMESTAMP,
      },
    ]);
    vi.mocked(fetchT3ProjectMappings).mockResolvedValue([]);

    render(<ProjectT3Panel project={PROJECT} canManageHostFolder />);

    expect(await screen.findByLabelText("Folder on T3 host")).toHaveValue("~/www/bitig");
    expect(screen.getByRole("button", { name: "Register" })).toBeInTheDocument();
  });
});
