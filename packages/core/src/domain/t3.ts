import { z } from "zod";
import { CommentAuthorSchema, CommentBodySchema, IdSchema, TaskActorSchema, TimestampSchema } from "./schemas";
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

export const ACTIVE_AGENT_RUN_STATES = ["working", "waiting_for_approval"] as const;
export type ActiveAgentRunState = (typeof ACTIVE_AGENT_RUN_STATES)[number];

/**
 * Whether a T3 run state represents an active session (running or waiting on a person, #BIT-126).
 */
export function isActiveAgentRunState(state: AgentRunState): state is ActiveAgentRunState {
  return state === "working" || state === "waiting_for_approval";
}

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
  "t3_thread_list",
  "t3_thread_launch",
  "t3_thread_read",
  "t3_pending_request",
  "t3_thread_send",
  "t3_thread_interrupt",
  "t3_thread_organize",
  "t3_thread_configure",
] as const;

export type T3AllowedMcpTool = (typeof T3_ALLOWED_MCP_TOOLS)[number];

export const T3_EXPIRY_WARNING_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
export const T3_EXPIRY_WARNING_MS = T3_EXPIRY_WARNING_DAYS * MS_PER_DAY;
export const T3_PROMPT_COMMENTS_LIMIT = 5;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const T3_MODEL_OPTION_ID_MAX = 100;
const T3_MODEL_OPTION_VALUE_MAX = 100;
const T3_MODEL_OPTION_VALUES_MAX = 50;
const T3_MODEL_OPTIONS_MAX = 20;

/** One model option value from `orchestrator_capabilities` (e.g. an effort level, or a fast-mode flag). */
export const T3ModelOptionValueSchema = z.union([z.string().trim().min(1).max(T3_MODEL_OPTION_VALUE_MAX), z.boolean()]);
export type T3ModelOptionValue = z.output<typeof T3ModelOptionValueSchema>;

/** A model option a T3 provider offers, e.g. `{ id: "effort", values: ["low", "high"], default: "low" }`. */
export const T3ModelOptionSchema = z.strictObject({
  id: z.string().trim().min(1).max(T3_MODEL_OPTION_ID_MAX),
  values: z.array(T3ModelOptionValueSchema).max(T3_MODEL_OPTION_VALUES_MAX),
  default: T3ModelOptionValueSchema.exactOptional(),
});
export type T3ModelOption = z.output<typeof T3ModelOptionSchema>;

/** A chosen option value, in the `[{ id, value }]` shape T3 uses for `modelSelection.options`. */
export const T3ModelSelectionOptionSchema = z.strictObject({
  id: z.string().trim().min(1).max(T3_MODEL_OPTION_ID_MAX),
  value: T3ModelOptionValueSchema,
});
export type T3ModelSelectionOption = z.output<typeof T3ModelSelectionOptionSchema>;

export const T3ModelSelectionOptionsSchema = z.array(T3ModelSelectionOptionSchema).max(T3_MODEL_OPTIONS_MAX);

/** A provider instance, model and options for a T3 thread (`t3_thread_configure` `modelSelection`). */
export const T3ModelSelectionSchema = z.strictObject({
  providerInstanceId: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200),
  options: T3ModelSelectionOptionsSchema.exactOptional(),
});
export type T3ModelSelection = z.output<typeof T3ModelSelectionSchema>;

export const AgentRunSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  t3ProjectId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(256),
  link: z.string().trim().min(1).max(2048).exactOptional(),
  state: AgentRunStateSchema,
  model: z.string().trim().min(1).max(200).exactOptional(),
  /** The provider instance the thread runs on, when known (set at launch with a model, or on a switch). */
  providerInstanceId: z.string().trim().min(1).max(200).exactOptional(),
  /** Model options chosen on the last switch (#BIT-119), e.g. the effort level. */
  modelOptions: T3ModelSelectionOptionsSchema.exactOptional(),
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
  options: z.array(T3ModelOptionSchema).max(T3_MODEL_OPTIONS_MAX).exactOptional(),
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

export interface T3ThreadListItem {
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly status?: string | undefined;
  readonly pendingRequestCount?: number | undefined;
  readonly activeRunId?: string | null | undefined;
  readonly settled?: boolean | undefined;
  readonly model?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface T3ProjectActiveSession {
  readonly threadId: string;
  readonly projectId: string;
  readonly t3ProjectId: string;
  readonly state: ActiveAgentRunState;
  readonly taskId?: string | undefined;
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly model?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface T3RunsLiveResponse {
  readonly runs: AgentRun[];
  readonly activeSessions?: T3ProjectActiveSession[] | undefined;
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

/**
 * A person's reply to a waiting T3 thread (#BIT-119): saved as a Bitig comment and sent to the thread.
 * With `modelSelection`, the thread switches to that model first.
 */
export const ReplyToT3RunInputSchema = z.strictObject({
  body: CommentBodySchema,
  author: CommentAuthorSchema.exactOptional(),
  modelSelection: T3ModelSelectionSchema.exactOptional(),
});

export type ReplyToT3RunInput = z.input<typeof ReplyToT3RunInputSchema>;

/**
 * Run states in which a thread may switch models: it waits on a person, or its turn has ended
 * (finished, stopped, or failed, which covers usage-limit stops). Never mid-turn (`working`), and
 * never `offline`, where the host cannot be reached.
 */
export const T3_MODEL_SWITCH_ALLOWED_STATES: readonly AgentRunState[] = [
  "waiting_for_approval",
  "finished",
  "stopped",
  "failed",
];

export function canSwitchT3Model(state: AgentRunState): boolean {
  return T3_MODEL_SWITCH_ALLOWED_STATES.includes(state);
}

function sortedOptions(options: readonly T3ModelSelectionOption[] | undefined): T3ModelSelectionOption[] {
  return [...(options ?? [])].sort((a, b) => a.id.localeCompare(b.id));
}

/** Whether two model selections name the same provider instance, model and option values. */
export function isSameT3ModelSelection(a: T3ModelSelection, b: T3ModelSelection): boolean {
  if (a.providerInstanceId !== b.providerInstanceId || a.model !== b.model) return false;
  const left = sortedOptions(a.options);
  const right = sortedOptions(b.options);
  return (
    left.length === right.length &&
    left.every((opt, i) => {
      const other = right[i];
      return opt.id === other?.id && opt.value === other.value;
    })
  );
}

/** A short label for a model selection, e.g. `claude-opus-5-5 (claudeAgent, effort: high)`. */
export function formatT3ModelSelection(selection: {
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly options?: readonly T3ModelSelectionOption[] | undefined;
}): string {
  const model = selection.model ?? "the default model";
  const details = [
    ...(selection.providerInstanceId ? [selection.providerInstanceId] : []),
    ...sortedOptions(selection.options).map((opt) => `${opt.id}: ${String(opt.value)}`),
  ];
  return details.length > 0 ? `${model} (${details.join(", ")})` : model;
}

/** The comment recorded on a task when its thread switches models. */
export function buildT3ModelSwitchComment(from: string, to: string): string {
  return `Model switched from ${from} to ${to}.`;
}

/**
 * The line put before a person's reply after a model switch. The new model receives only a bounded
 * history from T3, so it is told to restore context from the task's Bitig checkpoint first.
 */
export function buildT3ModelSwitchNotice(taskLabel: string, to: string): string {
  return (
    `The thread switched to ${to}. Before continuing, call resume_from_checkpoint for ${taskLabel} ` +
    "and read the task's comments to restore context."
  );
}

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
      "4. Use Bitig MCP commands for task state, comments, and checkpoints. Use project commands only when they are needed to implement or verify the task; report command failures and do not claim unverified work is complete.",
      `5. If you need a person's decision, approval, credentials, or clarification, post a comment on ${code} that states the exact question and current progress, then set \`needsHuman\` via \`update_task({ id: "${code}", needsHuman: "<what you need>" })\`. Stop the run without polling or waiting for a reply. On a later follow-up, read the person's comment and task state before continuing; clear \`needsHuman\` only after the request is resolved.`,
      `6. Before every final response in T3, post that same substantive response as a comment on ${code} with the outcome, work done, verification, and any next action. Do this for completion, partial progress, failure, and blocked work; the comment in step 5 can satisfy this rule. If Bitig MCP cannot post the comment, say so explicitly in the T3 response.`,
      `7. When the work is finished and verified, post the final comment first, then move the task to \`done\` via \`complete_task({ id: "${code}" })\`. Leave unfinished or unverified work in progress.`,
      "8. Never move the task to `archived` — a human reviews `done` tasks and archives them.",
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
