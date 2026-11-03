import type { Project, ProjectT3Thread, T3ConnectionStatus, T3ModelCapability } from "@bitig/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  T3ApiError,
  fetchProjectT3Threads,
  fetchT3Capabilities,
  fetchT3Connection,
  fetchT3ProjectMappings,
  sendProjectT3Message,
  startProjectT3Thread,
} from "../../services/t3";
import { ProjectT3Panel } from "./ProjectT3Panel";

vi.mock("../../services/t3", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    T3ApiError: actual.T3ApiError,
    fetchProjectT3Threads: vi.fn(),
    fetchT3Capabilities: vi.fn(),
    fetchT3Connection: vi.fn(),
    fetchT3ProjectMappings: vi.fn(),
    sendProjectT3Message: vi.fn(),
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
      makeThread({ threadId: "gone", title: "Gone", state: "offline", link: "javascript:alert(1)" }),
    ]);
    const user = userEvent.setup();
    render(<ProjectT3Panel project={PROJECT} />);

    await user.click(await screen.findByRole("button", { name: 'Follow up on "Busy"' }));
    expect(screen.getByLabelText("Reply with model")).toBeDisabled();
    expect(screen.getByText(/the model can change once the t3 thread waits/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: 'Follow up on "Gone"' })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: 'Open "Gone" in T3' })).not.toBeInTheDocument();
  });
});
