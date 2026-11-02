import { describe, expect, it } from "vitest";
import {
  T3_ALLOWED_MCP_TOOLS,
  buildT3LaunchPrompt,
  computeT3ConnectionStatus,
  deriveLiveAgentRunState,
  normalizeT3McpUrl,
} from "./t3";
import type { Comment, Task } from "./types";

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
});

describe("T3_ALLOWED_MCP_TOOLS", () => {
  it("never includes project mutation tools", () => {
    const allowed = new Set<string>(T3_ALLOWED_MCP_TOOLS);
    expect(allowed.has("t3_project_create")).toBe(false);
    expect(allowed.has("t3_project_update")).toBe(false);
    expect(allowed.has("t3_project_delete")).toBe(false);
    expect(allowed.has("t3_project_clone")).toBe(false);
  });
});
