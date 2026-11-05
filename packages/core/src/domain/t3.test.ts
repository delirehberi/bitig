import { describe, expect, it } from "vitest";
import {
  PROJECT_T3_THREAD_TITLE_MAX,
  ProjectT3ThreadSchema,
  ReplyToT3RunInputSchema,
  SendProjectT3MessageInputSchema,
  StartProjectT3ThreadInputSchema,
  buildProjectT3LaunchPrompt,
  buildProjectT3ModelSwitchNotice,
  buildProjectT3ThreadTitle,
  T3ModelCapabilitySchema,
  T3_ALLOWED_MCP_TOOLS,
  buildT3LaunchPrompt,
  buildT3ModelSwitchComment,
  buildT3ModelSwitchNotice,
  canSwitchT3Model,
  computeT3ConnectionStatus,
  deriveLiveAgentRunState,
  formatT3ModelSelection,
  isActiveAgentRunState,
  isSameT3ModelSelection,
  normalizeT3McpUrl,
  T3WorkspaceBusyError,
  AgentRunSchema,
  T3_HANDBACK_CHECKLIST_MAX,
  buildT3SubagentCompletedComment,
  buildT3SubagentCompletedPrompt,
  buildT3SubagentEndedComment,
  buildT3SubagentEndedPrompt,
  buildT3SubagentStartedComment,
} from "./t3";
import { BitigError, isBitigError } from "./errors";
import type { Checkpoint, Comment, Task } from "./types";

describe("normalizeT3McpUrl", () => {
  it("normalizes https origin or /mcp path", () => {
    expect(normalizeT3McpUrl("https://connect.t3.codes")).toEqual({
      origin: "https://connect.t3.codes",
      mcpUrl: "https://connect.t3.codes/mcp",
    });
    expect(normalizeT3McpUrl("https://connect.t3.codes/mcp/")).toEqual({
      origin: "https://connect.t3.codes",
      mcpUrl: "https://connect.t3.codes/mcp",
    });
  });

  it("allows http on localhost and 127.0.0.1 for local testing", () => {
    expect(normalizeT3McpUrl("http://localhost:3456/mcp")).toEqual({
      origin: "http://localhost:3456",
      mcpUrl: "http://localhost:3456/mcp",
    });
    expect(normalizeT3McpUrl("http://127.0.0.1:4000")).toEqual({
      origin: "http://127.0.0.1:4000",
      mcpUrl: "http://127.0.0.1:4000/mcp",
    });
  });

  it("rejects non-loopback http, credentials, query strings, and wrong paths", () => {
    expect(() => normalizeT3McpUrl("http://example.com/mcp")).toThrow(/https:\/\//);
    expect(() => normalizeT3McpUrl("https://user:pass@example.com/mcp")).toThrow(/credentials/);
    expect(() => normalizeT3McpUrl("https://example.com/mcp?token=1")).toThrow(/query/);
    expect(() => normalizeT3McpUrl("https://example.com/other")).toThrow(/path must be \/mcp/);
  });
});

describe("computeT3ConnectionStatus", () => {
  const now = Date.parse("2026-11-01T12:00:00.000Z");

  it("returns connected: false when record is null", () => {
    expect(computeT3ConnectionStatus(null, now)).toEqual({ connected: false });
  });

  it("flags expiringSoon when under 5 days remain", () => {
    const fourDaysMs = 4 * 24 * 60 * 60 * 1000;
    const status = computeT3ConnectionStatus(
      {
        mcpUrl: "https://t3.example.com/mcp",
        issuer: "https://t3.example.com",
        scope: "orchestration:read orchestration:operate",
        connectedAt: now - 26 * 24 * 60 * 60 * 1000,
        expiresAt: now + fourDaysMs,
      },
      now,
    );
    expect(status.connected).toBe(true);
    expect(status.expiringSoon).toBe(true);
    expect(status.expired).toBe(false);
    expect(status.expiresInDays).toBe(4);
  });

  it("flags expired when expiresAt is in the past", () => {
    const status = computeT3ConnectionStatus(
      {
        mcpUrl: "https://t3.example.com/mcp",
        issuer: "https://t3.example.com",
        connectedAt: now - 31 * 24 * 60 * 60 * 1000,
        expiresAt: now - 1000,
      },
      now,
    );
    expect(status.expired).toBe(true);
    expect(status.expiringSoon).toBe(false);
    expect(status.expiresInDays).toBe(0);
  });
});

describe("buildT3LaunchPrompt", () => {
  const sampleTask: Task = {
    id: "0196ed60-0000-7000-8000-000000000001",
    projectId: "0196ed60-0000-7000-8000-000000000002",
    title: "Add OAuth client",
    description: "Connect Worker to T3 MCP.",
    status: "todo",
    isPublic: false,
    checklist: [
      { text: "Spike client", done: true },
      { text: "Store encrypted token", done: false },
    ],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  };

  const sampleComments: Comment[] = [
    {
      id: "0196ed60-0000-7000-8000-000000000010",
      taskId: sampleTask.id,
      body: "Use AES-256-GCM.",
      authorType: "human",
      author: "emre",
      createdAt: "2026-11-01T11:00:00.000Z",
    },
  ];

  it("includes task code, title, description, checklist, comments, and standing instructions", () => {
    const built = buildT3LaunchPrompt({
      task: sampleTask,
      taskCode: "BIT-107",
      comments: sampleComments,
    });
    expect(built.title).toBe("BIT-107 Add OAuth client");
    expect(built.clientRequestId).toBe("BIT-107");
    expect(built.prompt).toContain("# BIT-107: Add OAuth client");
    expect(built.prompt).toContain("Connect Worker to T3 MCP.");
    expect(built.prompt).toContain("1. [x] Spike client");
    expect(built.prompt).toContain("2. [ ] Store encrypted token");
    expect(built.prompt).toContain("Use AES-256-GCM.");
    expect(built.prompt).toContain("resume_from_checkpoint");
    expect(built.prompt).toContain("save_checkpoint");
    expect(built.prompt).toContain("needsHuman");
    expect(built.prompt).toContain("Use Bitig MCP commands for task state, comments, and checkpoints");
    expect(built.prompt).toContain("Use project commands only when they are needed to implement or verify");
    expect(built.prompt).toContain("post a comment on BIT-107 that states the exact question and current progress");
    expect(built.prompt).toContain('update_task({ id: "BIT-107", needsHuman: "<what you need>" })');
    expect(built.prompt).toContain("Stop the run without polling or waiting for a reply");
    expect(built.prompt).toContain("Before every final response in T3, post that same substantive response as a comment on BIT-107");
    expect(built.prompt).toContain("completion, partial progress, failure, and blocked work");
    expect(built.prompt).toContain("If Bitig MCP cannot post the comment, say so explicitly in the T3 response");
    expect(built.prompt).toContain("post the final comment first, then move the task to `done`");
    expect(built.prompt).toContain("complete_task");
    expect(built.prompt).toContain("Never move the task to `archived`");
    expect(built.prompt).toContain("Checklist items are steps of BIT-107, not separate tasks");
    expect(built.prompt).toContain('start_t3_thread({ taskId: "<child-code>", parentTaskId: "BIT-107" })');
    expect(built.prompt).toContain("end your turn without polling");
    expect(built.prompt).not.toContain("## Umbrella Task");
  });

  it("tells a child session which umbrella task started it (BIT-141)", () => {
    const built = buildT3LaunchPrompt({ task: sampleTask, taskCode: "BIT-108", parentTaskCode: "BIT-100" });
    expect(built.prompt).toContain("## Umbrella Task");
    expect(built.prompt).toContain("umbrella task BIT-100");
    expect(built.prompt).toContain("do not start, update, or complete BIT-100");
    expect(built.prompt).toContain('complete_task({ id: "BIT-108" })');
  });
});

describe("T3 subagent handback (BIT-141)", () => {
  const child: Task = {
    id: "0196ed60-0000-7000-8000-000000000021",
    projectId: "0196ed60-0000-7000-8000-000000000002",
    title: "Store encrypted token",
    description: "",
    status: "done",
    isPublic: false,
    checklist: [
      { text: "Encrypt", done: true },
      { text: "Persist", done: false },
    ],
    createdAt: "2026-11-01T10:00:00.000Z",
    updatedAt: "2026-11-01T10:00:00.000Z",
  };
  const checkpoint: Checkpoint = {
    id: "0196ed60-0000-7000-8000-000000000022",
    taskId: child.id,
    stepIndex: 2,
    status: "COMPLETED",
    stateSnapshot: {
      summary: "Tokens are stored encrypted.",
      modifiedArtifacts: ["src/crypto.ts", "src/store.ts"],
      decisionsMade: ["AES-256-GCM"],
      nextStepInstructions: "None",
    },
    createdAt: "2026-11-01T12:00:00.000Z",
  };
  const finalComment: Comment = {
    id: "0196ed60-0000-7000-8000-000000000023",
    taskId: child.id,
    body: "Done and verified with make check.",
    authorType: "agent",
    author: "claude",
    createdAt: "2026-11-01T12:30:00.000Z",
  };
  const input = { parentLabel: "BIT-100", childLabel: "BIT-108", child, checkpoint, finalComment };

  it("treats waiting_subagent as an active state and stores parent and child links on a run", () => {
    expect(isActiveAgentRunState("waiting_subagent")).toBe(true);
    const run = AgentRunSchema.parse({
      id: "0196ed60-0000-7000-8000-000000000030",
      taskId: child.id,
      t3ProjectId: "t3-proj",
      threadId: "thread-1",
      state: "waiting_subagent",
      parentTaskId: "0196ed60-0000-7000-8000-000000000031",
      waitingForTaskId: "0196ed60-0000-7000-8000-000000000032",
      startedAt: "2026-11-01T10:00:00.000Z",
      updatedAt: "2026-11-01T10:00:00.000Z",
    });
    expect(run.waitingForTaskId).toBe("0196ed60-0000-7000-8000-000000000032");
    expect(() => AgentRunSchema.parse({ ...run, waitingForTaskId: "TAS-2" })).toThrow();
  });

  it("names the child and its thread in the started comment", () => {
    const body = buildT3SubagentStartedComment({
      childLabel: "BIT-108",
      childTitle: "Store encrypted token",
      link: "https://t3.example/threads/t-2",
    });
    expect(body).toContain('#BIT-108 "Store encrypted token"');
    expect(body).toContain("(https://t3.example/threads/t-2)");
    expect(buildT3SubagentStartedComment({ childLabel: "BIT-108", childTitle: "x" })).not.toContain("T3 thread]");
  });

  it("hands back status, checklist, checkpoint, and the final comment", () => {
    const comment = buildT3SubagentCompletedComment(input);
    const prompt = buildT3SubagentCompletedPrompt(input);
    for (const text of [comment, prompt]) {
      expect(text).toContain("Status: done");
      expect(text).toContain("Checklist: 1/2 done");
      expect(text).toContain("  - [ ] Persist");
      expect(text).toContain("Latest checkpoint (step 2): Tokens are stored encrypted.");
      expect(text).toContain("Modified: src/crypto.ts, src/store.ts");
      expect(text).toContain("Decisions: AES-256-GCM");
      expect(text).toContain("Final comment from claude:\n\nDone and verified with make check.");
    }
    expect(prompt).toContain("Child task BIT-108 that you started from BIT-100 is done.");
    expect(prompt).toContain('resume_from_checkpoint({ taskId: "BIT-100" })');
  });

  it("omits missing checkpoint and comment, and bounds long checklists", () => {
    const many = Array.from({ length: T3_HANDBACK_CHECKLIST_MAX + 5 }, (_, i) => ({ text: `Item ${String(i)}`, done: true }));
    const prompt = buildT3SubagentCompletedPrompt({ parentLabel: "BIT-100", childLabel: "BIT-108", child: { ...child, checklist: many } });
    expect(prompt).not.toContain("Latest checkpoint");
    expect(prompt).not.toContain("Final comment");
    expect(prompt).toContain("…and 5 more");
    expect(prompt).not.toContain(`Item ${String(T3_HANDBACK_CHECKLIST_MAX)}\n`);
  });

  it("tells the umbrella session when a child session fails or stops", () => {
    const ended = { ...input, child: { ...child, status: "in_progress" as const }, state: "failed" as const, stopReason: "Usage limit" };
    expect(buildT3SubagentEndedComment(ended)).toContain(
      "The T3 session of child task #BIT-108 failed before the task was done. Reason: Usage limit",
    );
    const prompt = buildT3SubagentEndedPrompt(ended);
    expect(prompt).toContain("You started it from BIT-100.");
    expect(prompt).toContain('start_t3_thread({ taskId: "BIT-108", parentTaskId: "BIT-100" })');
  });
});

describe("deriveLiveAgentRunState", () => {
  it("maps pending requests or waiting status to waiting_for_approval", () => {
    expect(deriveLiveAgentRunState({ threadStatus: "running", pendingQuestionIds: ["req-1"] })).toBe(
      "waiting_for_approval",
    );
    expect(deriveLiveAgentRunState({ threadStatus: "running", pendingRequestCount: 1 })).toBe(
      "waiting_for_approval",
    );
    expect(deriveLiveAgentRunState({ threadStatus: "waiting" })).toBe("waiting_for_approval");
  });

  it("maps running, completed, failed, and interrupted states", () => {
    expect(deriveLiveAgentRunState({ threadStatus: "running" })).toBe("working");
    expect(deriveLiveAgentRunState({ threadStatus: "completed" })).toBe("finished");
    expect(deriveLiveAgentRunState({ threadStatus: "idle", latestRunStatus: "completed" })).toBe("finished");
    expect(deriveLiveAgentRunState({ threadStatus: "failed" })).toBe("failed");
    expect(deriveLiveAgentRunState({ threadStatus: "interrupted" })).toBe("stopped");
  });

  it("identifies working, waiting_for_approval, and waiting_subagent as active agent run states", () => {
    expect(isActiveAgentRunState("working")).toBe(true);
    expect(isActiveAgentRunState("waiting_for_approval")).toBe(true);
    expect(isActiveAgentRunState("waiting_subagent")).toBe(true);
    expect(isActiveAgentRunState("finished")).toBe(false);
    expect(isActiveAgentRunState("failed")).toBe(false);
    expect(isActiveAgentRunState("stopped")).toBe(false);
    expect(isActiveAgentRunState("offline")).toBe(false);
  });
});

describe("T3_ALLOWED_MCP_TOOLS", () => {
  it("never includes project mutation tools and allows thread listing and organization", () => {
    const allowed = new Set<string>(T3_ALLOWED_MCP_TOOLS);
    expect(allowed.has("t3_thread_list")).toBe(true);
    expect(allowed.has("t3_thread_organize")).toBe(true);
    expect(allowed.has("t3_thread_configure")).toBe(true);
    expect(allowed.has("t3_project_create")).toBe(false);
    expect(allowed.has("t3_project_update")).toBe(false);
    expect(allowed.has("t3_project_delete")).toBe(false);
    expect(allowed.has("t3_project_clone")).toBe(false);
  });
});

describe("T3 model switching (BIT-119)", () => {
  it("allows a switch only when the thread waits or its turn has ended", () => {
    expect(canSwitchT3Model("waiting_for_approval")).toBe(true);
    expect(canSwitchT3Model("finished")).toBe(true);
    expect(canSwitchT3Model("stopped")).toBe(true);
    expect(canSwitchT3Model("failed")).toBe(true);
    expect(canSwitchT3Model("working")).toBe(false);
    expect(canSwitchT3Model("offline")).toBe(false);
  });

  it("compares selections by provider, model and option values in any order", () => {
    const base = {
      providerInstanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "high" },
        { id: "fastMode", value: false },
      ],
    };
    expect(isSameT3ModelSelection(base, { ...base, options: [...base.options].reverse() })).toBe(true);
    expect(isSameT3ModelSelection(base, { ...base, model: "claude-sonnet-5-5" })).toBe(false);
    expect(isSameT3ModelSelection(base, { ...base, providerInstanceId: "antigravity" })).toBe(false);
    expect(isSameT3ModelSelection(base, { ...base, options: [{ id: "effort", value: "high" }] })).toBe(false);
    expect(
      isSameT3ModelSelection(base, {
        ...base,
        options: [
          { id: "effort", value: "low" },
          { id: "fastMode", value: false },
        ],
      }),
    ).toBe(false);
    expect(isSameT3ModelSelection({ providerInstanceId: "codex", model: "gpt-6-sol" }, { providerInstanceId: "codex", model: "gpt-6-sol", options: [] })).toBe(true);
  });

  it("formats selections and builds the switch comment and notice", () => {
    expect(
      formatT3ModelSelection({ providerInstanceId: "codex", model: "gpt-6-sol", options: [{ id: "reasoningEffort", value: "high" }] }),
    ).toBe("gpt-6-sol (codex, reasoningEffort: high)");
    expect(formatT3ModelSelection({ model: "claude-opus-5-5" })).toBe("claude-opus-5-5");
    expect(formatT3ModelSelection({})).toBe("the default model");
    expect(buildT3ModelSwitchComment("a", "b")).toBe("Model switched from a to b.");
    expect(buildT3ModelSwitchNotice("BIT-119", "gpt-6-sol")).toContain("resume_from_checkpoint for BIT-119");
  });

  it("validates reply input and capability options", () => {
    expect(ReplyToT3RunInputSchema.safeParse({ body: "  " }).success).toBe(false);
    expect(
      ReplyToT3RunInputSchema.safeParse({
        body: "Go on",
        modelSelection: { providerInstanceId: "codex", model: "gpt-6-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      }).success,
    ).toBe(true);
    expect(ReplyToT3RunInputSchema.safeParse({ body: "Go on", modelSelection: { model: "x" } }).success).toBe(false);
    expect(
      T3ModelCapabilitySchema.safeParse({
        providerInstanceId: "claudeAgent",
        model: "claude-opus-5-5",
        options: [{ id: "fastMode", values: [false, true] }],
      }).success,
    ).toBe(true);
  });
});

describe("project-level T3 threads (BIT-127)", () => {
  it("validates start input and trims the prompt", () => {
    const parsed = StartProjectT3ThreadInputSchema.parse({
      prompt: "  check node version  ",
      workspaceStrategy: "root",
      modelSelection: { providerInstanceId: "claudeAgent", model: "claude-opus-5-5" },
    });
    expect(parsed.prompt).toBe("check node version");
    expect(StartProjectT3ThreadInputSchema.safeParse({ prompt: "   " }).success).toBe(false);
    expect(StartProjectT3ThreadInputSchema.safeParse({ prompt: "x", extra: 1 }).success).toBe(false);
    expect(StartProjectT3ThreadInputSchema.safeParse({ prompt: "x".repeat(20_001) }).success).toBe(false);
  });

  it("validates follow-up input", () => {
    expect(SendProjectT3MessageInputSchema.safeParse({ body: "ok" }).success).toBe(true);
    expect(SendProjectT3MessageInputSchema.safeParse({ body: "" }).success).toBe(false);
    expect(
      SendProjectT3MessageInputSchema.safeParse({ body: "ok", modelSelection: { model: "m" } }).success,
    ).toBe(false);
  });

  it("requires a workspace strategy on a stored thread", () => {
    const base = {
      id: "01a1a193-c1e4-7750-833d-a7d9b5c42f1d",
      projectId: "01a14ecf-281e-7436-8c52-a524c5fabc2f",
      t3ProjectId: "t3-proj",
      threadId: "thread-1",
      title: "Check env",
      state: "working",
      startedAt: "2026-11-03T00:00:00.000Z",
      updatedAt: "2026-11-03T00:00:00.000Z",
    };
    expect(ProjectT3ThreadSchema.safeParse(base).success).toBe(false);
    expect(ProjectT3ThreadSchema.safeParse({ ...base, workspaceStrategy: "root" }).success).toBe(true);
  });

  it("titles a thread from the first non-empty prompt line", () => {
    expect(buildProjectT3ThreadTitle("\n\n  Check env  \nmore")).toBe("Check env");
    expect(buildProjectT3ThreadTitle("   ")).toBe("Project message");
    const long = buildProjectT3ThreadTitle("a".repeat(500));
    expect(long).toHaveLength(PROJECT_T3_THREAD_TITLE_MAX);
    expect(long.endsWith("…")).toBe(true);
  });

  it("tells the agent there is no Bitig task", () => {
    const prompt = buildProjectT3LaunchPrompt({ project: { name: "Bitig", key: "BIT" }, prompt: " ls -la " });
    expect(prompt).toContain('Bitig project "Bitig" (BIT)');
    expect(prompt).toContain("There is no Bitig task");
    expect(prompt.endsWith("ls -la")).toBe(true);
    expect(buildProjectT3LaunchPrompt({ project: { name: "X" }, prompt: "hi" })).toContain('project "X".');
  });

  it("builds a switch notice without checkpoint instructions", () => {
    const notice = buildProjectT3ModelSwitchNotice("gpt-6 (codex)");
    expect(notice).toContain("gpt-6 (codex)");
    expect(notice).not.toContain("resume_from_checkpoint");
  });
});

describe("T3WorkspaceBusyError (BIT-134)", () => {
  it("is a BitigError with the WORKSPACE_BUSY code and names the busy task", () => {
    const error = new T3WorkspaceBusyError({
      threadId: "thread-1",
      state: "waiting_for_approval",
      taskId: "task-1",
      taskCode: "BIT-12",
      title: "Other task",
    });
    expect(error).toBeInstanceOf(BitigError);
    expect(isBitigError(error)).toBe(true);
    expect(error.code).toBe("WORKSPACE_BUSY");
    expect(error.name).toBe("T3WorkspaceBusyError");
    expect(error.session.threadId).toBe("thread-1");
    expect(error.message).toContain("(BIT-12) is waiting for approval");
    expect(error.message).toContain("isolated git worktree");
  });

  it("falls back to the title, then the thread ID, when the session has no ticket code", () => {
    expect(new T3WorkspaceBusyError({ threadId: "t-1", state: "working", title: "Fix it" }).message).toContain(
      "(Fix it) is working",
    );
    expect(new T3WorkspaceBusyError({ threadId: "t-1", state: "working" }).message).toContain("(t-1) is working");
  });
});
