import { z } from "zod";
import { IdSchema, TaskActorSchema, TimestampSchema } from "./schemas";
import type { Comment, Task } from "./types";
import { ValidationError } from "./errors";

export const AGENT_RUN_STATES = [
  "working",
  "waiting_for_approval",
  "finished",
  "failed",
  "stopped",
  "offline",
] as const;

export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
export const AgentRunStateSchema = z.enum(AGENT_RUN_STATES);

export const T3_WORKSPACE_STRATEGIES = ["worktree", "root"] as const;
export type T3WorkspaceStrategy = (typeof T3_WORKSPACE_STRATEGIES)[number];
export const T3WorkspaceStrategySchema = z.enum(T3_WORKSPACE_STRATEGIES);

/**
 * Only these read-only project and thread orchestration tools may ever be called on a T3 host.
 * Bitig never creates, edits, deletes, or clones T3 projects.
 */
export const T3_ALLOWED_MCP_TOOLS = [
  "t3_project_list",
  "orchestrator_capabilities",
  "t3_thread_launch",
  "t3_thread_read",
  "t3_pending_request",
  "t3_thread_send",
  "t3_thread_interrupt",
] as const;

export type T3AllowedMcpTool = (typeof T3_ALLOWED_MCP_TOOLS)[number];

export const T3_EXPIRY_WARNING_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const T3_EXPIRY_WARNING_MS = T3_EXPIRY_WARNING_DAYS * MS_PER_DAY;
export const T3_PROMPT_COMMENTS_LIMIT = 5;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const AgentRunSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  t3ProjectId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(256),
  link: z.string().trim().min(1).max(2048).exactOptional(),
  state: AgentRunStateSchema,
  model: z.string().trim().min(1).max(200).exactOptional(),
  workspaceStrategy: T3WorkspaceStrategySchema.exactOptional(),
  startedBy: TaskActorSchema.exactOptional(),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type AgentRun = z.output<typeof AgentRunSchema>;

export const T3RemoteProjectSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  workspaceRoot: z.string().trim().max(1024).exactOptional(),
  displayName: z.string().trim().max(500).exactOptional(),
});

export type T3RemoteProject = z.output<typeof T3RemoteProjectSchema>;

export const T3ProjectMappingSchema = z.strictObject({
  projectId: IdSchema,
  t3ProjectId: z.string().trim().min(1).max(200),
  t3ProjectTitle: z.string().trim().min(1).max(500),
  updatedAt: TimestampSchema,
});

export type T3ProjectMapping = z.output<typeof T3ProjectMappingSchema>;

export const UpsertT3ProjectMappingInputSchema = z.strictObject({
  t3ProjectId: z.string().trim().min(1).max(200),
  t3ProjectTitle: z.string().trim().min(1).max(500),
});

export type UpsertT3ProjectMappingInput = z.input<typeof UpsertT3ProjectMappingInputSchema>;

export const T3ConnectionStatusSchema = z.strictObject({
  connected: z.boolean(),
  mcpUrl: z.string().exactOptional(),
  issuer: z.string().exactOptional(),
  scope: z.string().exactOptional(),
  connectedAt: TimestampSchema.exactOptional(),
  expiresAt: TimestampSchema.exactOptional(),
  expiresInDays: z.number().exactOptional(),
  expiringSoon: z.boolean().exactOptional(),
  expired: z.boolean().exactOptional(),
});

export type T3ConnectionStatus = z.output<typeof T3ConnectionStatusSchema>;

export const T3StartOAuthInputSchema = z.strictObject({
  mcpUrl: z.string().trim().min(1).max(512),
});

export type T3StartOAuthInput = z.input<typeof T3StartOAuthInputSchema>;

export const T3ModelCapabilitySchema = z.strictObject({
  providerInstanceId: z.string().trim().min(1).max(200),
  driverKind: z.string().trim().min(1).max(100).exactOptional(),
  displayName: z.string().trim().min(1).max(200).exactOptional(),
  model: z.string().trim().min(1).max(200),
  label: z.string().trim().min(1).max(200).exactOptional(),
});

export type T3ModelCapability = z.output<typeof T3ModelCapabilitySchema>;

export const T3PendingQuestionOptionSchema = z.strictObject({
  label: z.string().trim().min(1).max(500),
  description: z.string().trim().max(1000).exactOptional(),
});

export const T3PendingQuestionItemSchema = z.strictObject({
  id: z.string().trim().min(1).max(200),
  header: z.string().trim().max(200).exactOptional(),
  question: z.string().trim().min(1).max(4000),
  options: z.array(T3PendingQuestionOptionSchema).exactOptional(),
  multiSelect: z.boolean().exactOptional(),
  allowCustomAnswer: z.boolean().exactOptional(),
  required: z.boolean().exactOptional(),
});

export const T3PendingQuestionSchema = T3PendingQuestionItemSchema;
export type T3PendingQuestion = z.output<typeof T3PendingQuestionItemSchema>;
export type TaskActor = z.output<typeof TaskActorSchema>;

export interface T3ThreadSummary {
  readonly status?: string | undefined;
  readonly pendingRequestCount?: number | undefined;
  readonly activeRunId?: string | null | undefined;
}

export interface T3RunSummary {
  readonly status?: string | undefined;
  readonly state?: string | undefined;
}

export interface T3TaskRunLiveResponse {
  readonly run: AgentRun | null;
  readonly pendingRequestId?: string | undefined;
  readonly pendingQuestions: T3PendingQuestion[];
}

export const T3PendingQuestionRequestSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(256),
  questions: z.array(T3PendingQuestionItemSchema),
});

export type T3PendingQuestionRequest = z.output<typeof T3PendingQuestionRequestSchema>;

export const AgentRunLiveStatusSchema = z.strictObject({
  run: AgentRunSchema.nullable(),
  liveState: AgentRunStateSchema.exactOptional(),
  threadStatus: z.string().exactOptional(),
  pendingQuestions: z.array(T3PendingQuestionRequestSchema).exactOptional(),
  hasPendingApproval: z.boolean().exactOptional(),
  lastAssistantMessage: z.string().exactOptional(),
  error: z.string().exactOptional(),
});

export type AgentRunLiveStatus = z.output<typeof AgentRunLiveStatusSchema>;

export const StartT3RunInputSchema = z.strictObject({
  model: z.string().trim().min(1).max(200).exactOptional(),
  providerInstanceId: z.string().trim().min(1).max(200).exactOptional(),
  worktree: z.boolean().default(true),
});

export type StartT3RunInput = z.input<typeof StartT3RunInputSchema>;

export const StartT3ThreadInputSchema = z.strictObject({
  workspaceStrategy: T3WorkspaceStrategySchema.exactOptional(),
  providerInstanceId: z.string().trim().min(1).max(200).exactOptional(),
  model: z.string().trim().min(1).max(200).exactOptional(),
});

export type StartT3ThreadInput = z.input<typeof StartT3ThreadInputSchema>;

export const SendT3MessageInputSchema = z.strictObject({
  message: z.string().trim().min(1).max(20_000),
  mode: z.enum(["auto", "queue", "steer", "restart"]).default("auto"),
});

export type SendT3MessageInput = z.input<typeof SendT3MessageInputSchema>;

export const StopT3RunInputSchema = z.strictObject({
  reason: z.string().trim().min(1).max(2000).exactOptional(),
});

export type StopT3RunInput = z.input<typeof StopT3RunInputSchema>;

export const RespondT3QuestionInputSchema = z.strictObject({
  requestId: z.string().trim().min(1).max(256),
  answers: z.record(
    z.string().min(1).max(200),
    z.union([z.string().max(4000), z.array(z.string().max(4000)).max(50)]),
  ),
});

export type RespondT3QuestionInput = z.input<typeof RespondT3QuestionInputSchema>;
export const RespondT3PendingRequestInputSchema = RespondT3QuestionInputSchema;
export type RespondT3PendingRequestInput = RespondT3QuestionInput;

const HTTP_URL_PATTERN =
  /^(https?):\/\/(?:([^/@?#]+)@)?(\[[0-9a-fA-F:]+\]|[^/?#:]+)(?::(\d+))?(\/[^?#]*)?(\?[^#]*)?(#.*)?$/;

function throwUrlValidationError(rawUrl: string, message: string): never {
  throw new ValidationError("normalizeT3McpUrl", [
    {
      code: "custom",
      path: ["mcpUrl"],
      message,
      input: rawUrl,
    },
  ]);
}

/**
 * Validates and normalizes a T3 Connect `/mcp` URL.
 * Requires HTTPS (or HTTP on localhost / 127.0.0.1 / [::1] for local testing) and `/mcp` path.
 */
export function normalizeT3McpUrl(rawUrl: string): { mcpUrl: string; origin: string } {
  const trimmed = rawUrl.trim();
  const match = HTTP_URL_PATTERN.exec(trimmed);
  if (!match) {
    throwUrlValidationError(rawUrl, "T3 MCP URL must be a valid URL (e.g. https://<host>/mcp)");
  }

  const scheme = (match[1] ?? "").toLowerCase();
  const userInfo = match[2] ?? "";
  const hostname = (match[3] ?? "").toLowerCase();
  const port = match[4] ?? "";
  const pathname = match[5] ?? "";
  const query = match[6] ?? "";
  const hash = match[7] ?? "";

  if (userInfo !== "") {
    throwUrlValidationError(rawUrl, "T3 MCP URL must not contain credentials");
  }

  const isHttps = scheme === "https";
  const isLoopbackHttp = scheme === "http" && LOOPBACK_HOSTS.has(hostname);
  if (!isHttps && !isLoopbackHttp) {
    throwUrlValidationError(rawUrl, "T3 MCP URL must use https:// (or http:// on localhost)");
  }

  if (query !== "" || hash !== "") {
    throwUrlValidationError(rawUrl, "T3 MCP URL must not contain query parameters or fragments");
  }

  const defaultPort = (scheme === "https" && port === "443") || (scheme === "http" && port === "80");
  const hostAuthority = port !== "" && !defaultPort ? `${hostname}:${port}` : hostname;
  const origin = `${scheme}://${hostAuthority}`;

  const cleanPath = pathname.replace(/\/+$/u, "");
  if (cleanPath === "" || cleanPath === "/mcp") {
    return {
      origin,
      mcpUrl: `${origin}/mcp`,
    };
  }

  throwUrlValidationError(rawUrl, "T3 MCP URL path must be /mcp");
}

export function computeT3ConnectionStatus(
  record: {
    readonly mcpUrl: string;
    readonly issuer: string;
    readonly scope?: string | null | undefined;
    readonly connectedAt: number;
    readonly expiresAt: number;
  } | null,
  nowMs: number = Date.now(),
): T3ConnectionStatus {
  if (record === null) {
    return { connected: false };
  }
  const remainingMs = record.expiresAt - nowMs;
  const expired = remainingMs <= 0;
  const expiringSoon = !expired && remainingMs <= T3_EXPIRY_WARNING_MS;
  const expiresInDays = Math.max(0, Math.ceil(remainingMs / MS_PER_DAY));
  return {
    connected: true,
    mcpUrl: record.mcpUrl,
    issuer: record.issuer,
    ...(record.scope ? { scope: record.scope } : {}),
    connectedAt: new Date(record.connectedAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    expiresInDays,
    expiringSoon,
    expired,
  };
}

export interface BuildT3LaunchPromptInput {
  readonly task: Task;
  readonly taskCode?: string | undefined;
  readonly code?: string | undefined;
  readonly projectName?: string | undefined;
  readonly comments?: readonly Comment[] | undefined;
}

export interface BuiltT3LaunchPrompt {
  readonly title: string;
  readonly clientRequestId: string;
  readonly prompt: string;
}

/**
 * Formats the thread title, idempotency key (`clientRequestId`), and initial prompt
 * with standing Bitig MCP instructions for launching a T3 thread on a task.
 */
export function buildT3LaunchPrompt({
  task,
  taskCode,
  code: codeAlias,
  comments = [],
}: BuildT3LaunchPromptInput): BuiltT3LaunchPrompt {
  const code = (taskCode ?? codeAlias ?? "").trim() || task.id;
  const title = `${code} ${task.title}`.slice(0, 512);
  const sections: string[] = [`# ${code}: ${task.title}`];

  if (task.description.trim().length > 0) {
    sections.push(`## Description\n\n${task.description.trim()}`);
  }

  if (task.checklist && task.checklist.length > 0) {
    const items = task.checklist
      .map((item, idx) => `${String(idx + 1)}. [${item.done ? "x" : " "}] ${item.text}`)
      .join("\n");
    sections.push(`## Checklist\n\n${items}`);
  }

  if (comments.length > 0) {
    const recent = comments.slice(-T3_PROMPT_COMMENTS_LIMIT);
    const formatted = recent
      .map((c) => {
        const who = c.author ?? c.authorType;
        return `- **${who}** (${c.createdAt}): ${c.body.trim()}`;
      })
      .join("\n");
    sections.push(`## Recent Comments\n\n${formatted}`);
  }

  sections.push(
    [
      "## Standing Instructions (Bitig MCP)",
      `1. Call \`get_task({ id: "${code}" })\` and \`resume_from_checkpoint({ taskId: "${code}" })\` first to inspect current state and any prior checkpoint.`,
      `2. Call \`save_checkpoint\` after each completed step and keep \`checklist\` items updated via \`update_task({ id: "${code}", checklist: ... })\`.`,
      `3. Call \`add_comment({ taskId: "${code}", body: ... })\` to record key findings, decisions, or verification output.`,
      `4. If you are blocked on a person (need a decision, approval, credentials, or clarification), set \`needsHuman\` via \`update_task({ id: "${code}", needsHuman: "<what you need>" })\` and stop waiting.`,
      `5. When the work is finished and verified, move the task to \`done\` via \`complete_task({ id: "${code}" })\`.`,
      "6. Never move the task to `archived` — a human reviews `done` tasks and archives them.",
    ].join("\n"),
  );

  return {
    title,
    clientRequestId: code,
    prompt: sections.join("\n\n"),
  };
}

/**
 * Maps a T3 thread's live read state and pending requests onto Bitig's display-only
 * `AgentRunState`. Never mutates the Bitig task's status.
 */
export function deriveLiveAgentRunState(input: {
  readonly threadStatus?: string | null | undefined;
  readonly activeRunId?: string | null | undefined;
  readonly pendingRequestCount?: number | undefined;
  readonly latestRunStatus?: string | null | undefined;
  readonly settled?: boolean | undefined;
  readonly pendingQuestionIds?: readonly string[] | undefined;
  readonly thread?: T3ThreadSummary | undefined;
  readonly recentRuns?: readonly T3RunSummary[] | undefined;
  readonly pendingRequestIds?: readonly string[] | undefined;
}): AgentRunState {
  const threadStatus = input.threadStatus ?? input.thread?.status ?? undefined;
  const activeRunId = input.activeRunId ?? input.thread?.activeRunId ?? undefined;
  const pendingRequestCount = input.pendingRequestCount ?? input.thread?.pendingRequestCount;
  const latestRun = input.recentRuns?.[0];
  const latestRunStatus = input.latestRunStatus ?? latestRun?.status ?? latestRun?.state ?? undefined;
  const pendingIds = input.pendingQuestionIds ?? input.pendingRequestIds;

  if (
    (pendingIds && pendingIds.length > 0) ||
    (pendingRequestCount !== undefined && pendingRequestCount > 0) ||
    threadStatus === "waiting"
  ) {
    return "waiting_for_approval";
  }

  const status = threadStatus ?? latestRunStatus ?? undefined;
  switch (status) {
    case "running":
    case "starting":
    case "preparing":
    case "queued":
    case "pending":
      return "working";
    case "failed":
    case "rolled_back":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
    case "completed":
      return "finished";
    case "idle":
      if (latestRunStatus === "failed" || latestRunStatus === "rolled_back") {
        return "failed";
      }
      if (latestRunStatus === "interrupted" || latestRunStatus === "cancelled") {
        return "stopped";
      }
      if (latestRunStatus === "completed" || input.settled === true) {
        return "finished";
      }
      return activeRunId ? "working" : "finished";
    default:
      if (activeRunId) return "working";
      if (input.settled === true) return "finished";
      return "working";
  }
}
