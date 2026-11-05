import {
  InMemoryStorage,
  type AgentRun,
  type AgentRunState,
  type T3ModelCapability,
  type Task,
  type User,
} from "@bitig/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "../../auth/auth-types";
import { replyToTaskT3Run } from "../../services/t3";
import { TaskComments } from "./TaskComments";

vi.mock("../../services/t3", () => ({
  replyToTaskT3Run: vi.fn(),
}));

const SIGNED_IN_PROFILE: User = {
  id: "01a1ac95-b471-7100-a809-21f894f9c1cd",
  email: "nostr-46f3c7bb@nostr.local",
  username: "nostr-46f3c7bb",
  displayName: "Nostr (46f3c7bb)",
  platformRole: "user",
  status: "active",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
};

function makeAuthContext(profile: User | null): AuthContextValue {
  return {
    status: profile ? "authenticated" : "disabled",
    user: profile?.username ?? null,
    profile,
    memberships: [],
    needsOnboarding: false,
    currentOrg: null,
    currentRole: "owner",
    isAdmin: false,
    selectOrg: vi.fn(),
    refreshAuth: vi.fn().mockResolvedValue(undefined),
    requestSignInCode: vi.fn(),
    requestRegistrationCode: vi.fn(),
    verifyAuthCode: vi.fn(),
    loginWithPassword: vi.fn(),
    loginWithNostr: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    expire: vi.fn(),
  };
}

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
    model: "gpt-6-sol",
    options: [{ id: "reasoningEffort", values: ["low", "high"], default: "low" }],
  },
];

function makeRun(taskId: string, state: AgentRunState): AgentRun {
  return {
    id: "01940000-0000-7000-8000-000000000001",
    taskId,
    t3ProjectId: "t3-proj",
    threadId: "thread-1",
    state,
    model: "claude-opus-5-5",
    startedAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
  };
}

describe("TaskComments", () => {
  let storage: InMemoryStorage;
  let task: Task;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig" });
    task = await storage.saveTask({ projectId: project.id, title: "Needs a key" });
  });

  it("shows comments oldest first and who wrote them", async () => {
    await storage.addComment({ taskId: task.id, body: "Which key should I use?", authorType: "agent", author: "claude" });
    await storage.addComment({ taskId: task.id, body: "The staging one." });
    render(<TaskComments storage={storage} taskId={task.id} />);

    const items = await screen.findAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("Which key should I use?"),
      expect.stringContaining("The staging one."),
    ]);
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("(agent)")).toBeInTheDocument();
    expect(screen.getAllByText("just now")).toHaveLength(2);
    expect(screen.getByRole("heading", { name: /comments \(2\)/i })).toBeInTheDocument();
  });

  it("adds a comment as a person and deletes one", async () => {
    const user = userEvent.setup();
    render(<TaskComments storage={storage} taskId={task.id} />);
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();

    const submit = screen.getByRole("button", { name: "Comment" });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText("Add a comment"), "Use the staging key");
    await user.click(submit);

    expect(await screen.findByText("Use the staging key")).toBeInTheDocument();
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");
    const storedComments = await storage.getComments(task.id);
    expect(storedComments).toMatchObject([{ body: "Use the staging key", authorType: "human" }]);
    expect(storedComments[0]?.author).toBeUndefined();
    expect(storedComments[0]?.authorId).toBeUndefined();

    await user.click(screen.getByRole("button", { name: "Delete comment by You" }));
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();
    expect(await storage.getComments(task.id)).toEqual([]);
  });

  it("submits a comment with a signed-in profile using authorId and passes strict schema validation (BIT-143)", async () => {
    const user = userEvent.setup();
    render(
      <AuthContext.Provider value={makeAuthContext(SIGNED_IN_PROFILE)}>
        <TaskComments storage={storage} taskId={task.id} />
      </AuthContext.Provider>,
    );
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Add a comment"), "Signed-in Nostr comment");
    await user.click(screen.getByRole("button", { name: "Comment" }));

    expect(await screen.findByText("Signed-in Nostr comment")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(SIGNED_IN_PROFILE.displayName)).toBeInTheDocument();
    expect(screen.getByLabelText("Add a comment")).toHaveValue("");

    expect(await storage.getComments(task.id)).toMatchObject([
      {
        body: "Signed-in Nostr comment",
        authorType: "human",
        author: SIGNED_IN_PROFILE.displayName,
        authorId: SIGNED_IN_PROFILE.id,
      },
    ]);
    expect((await storage.getTask(task.id))?.updatedBy).toBe(SIGNED_IN_PROFILE.displayName);
  });

  it("only calls onResolve when Comment & resolve is clicked, not on a regular Comment", async () => {
    const user = userEvent.setup();
    const onResolve = vi.fn();
    render(<TaskComments storage={storage} taskId={task.id} onResolve={onResolve} />);
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Add a comment"), "Still checking");
    await user.click(screen.getByRole("button", { name: "Comment" }));
    expect(await screen.findByText("Still checking")).toBeInTheDocument();
    expect(onResolve).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Add a comment"), "Resolved: use the staging key");
    await user.click(screen.getByRole("button", { name: "Comment & resolve" }));
    expect(await screen.findByText("Resolved: use the staging key")).toBeInTheDocument();
    expect(onResolve).toHaveBeenCalledTimes(1);
  });

  describe("model picker for a task with a T3 thread (BIT-119)", () => {
    beforeEach(() => {
      vi.mocked(replyToTaskT3Run).mockReset();
    });

    it("is not shown without a run, for an offline run, or without a model list", async () => {
      const { rerender } = render(<TaskComments storage={storage} taskId={task.id} />);
      expect(await screen.findByText("No comments yet")).toBeInTheDocument();
      expect(screen.queryByLabelText("Reply with model")).not.toBeInTheDocument();

      rerender(<TaskComments storage={storage} taskId={task.id} t3={{ run: makeRun(task.id, "offline"), capabilities: CAPABILITIES }} />);
      expect(screen.queryByLabelText("Reply with model")).not.toBeInTheDocument();

      rerender(<TaskComments storage={storage} taskId={task.id} t3={{ run: makeRun(task.id, "finished"), capabilities: [] }} />);
      expect(screen.queryByLabelText("Reply with model")).not.toBeInTheDocument();
    });

    it("keeps the current model by default and comments as usual", async () => {
      const user = userEvent.setup();
      render(<TaskComments storage={storage} taskId={task.id} t3={{ run: makeRun(task.id, "waiting_for_approval"), capabilities: CAPABILITIES }} />);
      expect(await screen.findByText("No comments yet")).toBeInTheDocument();

      const picker = screen.getByLabelText("Reply with model");
      expect(picker).toHaveValue("");
      expect(screen.getByRole("option", { name: "Keep current model (claude-opus-5-5)" })).toBeInTheDocument();

      await user.type(screen.getByLabelText("Add a comment"), "Go ahead");
      await user.click(screen.getByRole("button", { name: "Comment" }));
      expect(await screen.findByText("Go ahead")).toBeInTheDocument();
      expect(replyToTaskT3Run).not.toHaveBeenCalled();
      expect(await storage.getComments(task.id)).toMatchObject([{ body: "Go ahead", authorType: "human" }]);
    });

    it("sends a reply with the chosen model and effort, then resets to the current model", async () => {
      const user = userEvent.setup();
      const run = makeRun(task.id, "waiting_for_approval");
      vi.mocked(replyToTaskT3Run).mockResolvedValue({
        comment: { id: "01940000-0000-7000-8000-0000000000c1", taskId: task.id, body: "Continue on Codex", authorType: "human", createdAt: "2026-11-02T00:00:00.000Z" },
        switchComment: {
          id: "01940000-0000-7000-8000-0000000000c2",
          taskId: task.id,
          body: "Model switched from claude-opus-5-5 to gpt-6-sol (codex, reasoningEffort: high).",
          authorType: "agent",
          author: "bitig",
          createdAt: "2026-11-02T00:00:00.000Z",
        },
        run: { ...run, state: "working", model: "gpt-6-sol", providerInstanceId: "codex" },
      });
      render(<TaskComments storage={storage} taskId={task.id} t3={{ run, capabilities: CAPABILITIES }} />);
      expect(await screen.findByText("No comments yet")).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText("Reply with model"), "codex::gpt-6-sol");
      const effort = screen.getByLabelText("T3 reasoningEffort");
      expect(effort).toHaveValue("str:low");
      await user.selectOptions(effort, "str:high");
      await user.type(screen.getByLabelText("Add a comment"), "Continue on Codex");
      await user.click(screen.getByRole("button", { name: "Comment" }));

      expect(replyToTaskT3Run).toHaveBeenCalledWith(task.id, {
        body: "Continue on Codex",
        modelSelection: { providerInstanceId: "codex", model: "gpt-6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      });
      expect(await screen.findByText("Continue on Codex")).toBeInTheDocument();
      expect(screen.getByText(/Model switched from claude-opus-5-5 to gpt-6-sol/)).toBeInTheDocument();
      expect(screen.getByLabelText("Reply with model")).toHaveValue("");
      expect(screen.getByLabelText("Add a comment")).toHaveValue("");
    });

    it("encodes boolean options and starts each option at its default", async () => {
      const user = userEvent.setup();
      render(<TaskComments storage={storage} taskId={task.id} t3={{ run: makeRun(task.id, "finished"), capabilities: CAPABILITIES }} />);
      expect(await screen.findByText("No comments yet")).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText("Reply with model"), "claudeAgent::claude-opus-5-5");
      expect(screen.getByLabelText("T3 effort")).toHaveValue("str:medium");
      expect(screen.getByLabelText("T3 fastMode")).toHaveValue("bool:false");
      await user.selectOptions(screen.getByLabelText("T3 fastMode"), "bool:true");
      vi.mocked(replyToTaskT3Run).mockRejectedValue(new Error("The T3 thread is working."));
      await user.type(screen.getByLabelText("Add a comment"), "Faster please");
      await user.click(screen.getByRole("button", { name: "Comment" }));

      expect(replyToTaskT3Run).toHaveBeenCalledWith(task.id, {
        body: "Faster please",
        modelSelection: {
          providerInstanceId: "claudeAgent",
          model: "claude-opus-5-5",
          options: [
            { id: "effort", value: "medium" },
            { id: "fastMode", value: true },
          ],
        },
      });
      // A refused reply keeps the draft and shows why
      expect(await screen.findByRole("alert")).toHaveTextContent("The T3 thread is working.");
      expect(screen.getByLabelText("Add a comment")).toHaveValue("Faster please");
    });

    it("disables the picker while the thread is mid-turn", async () => {
      render(<TaskComments storage={storage} taskId={task.id} t3={{ run: makeRun(task.id, "working"), capabilities: CAPABILITIES }} />);
      expect(await screen.findByText("No comments yet")).toBeInTheDocument();
      expect(screen.getByLabelText("Reply with model")).toBeDisabled();
      expect(screen.getByText(/model can change once the T3 thread waits/i)).toBeInTheDocument();
    });
  });
});
