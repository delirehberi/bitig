import { z } from "zod";
import { formatT3CommentAttachmentContext, type T3CommentAttachmentInfo } from "./attachments";
import { CommentAuthorSchema, CommentBodySchema, IdSchema, TaskActorSchema, TimestampSchema } from "./schemas";
import type { Checkpoint, Comment, Task } from "./types";
import { COMMENT_BODY_MAX } from "./constants";
import { BitigError, ERROR_CODES, ValidationError } from "./errors";
import { HOST_PROJECTS_ROOT_CONTAINER, HOST_PROJECTS_ROOT_USER, HostFolderPathSchema } from "./host-folder";

export const T3_HOST_KINDS = ["user", "container"] as const;
export type T3HostKind = (typeof T3_HOST_KINDS)[number];
export const T3HostKindSchema = z.enum(T3_HOST_KINDS);

export const T3_HOST_ID_MAX = 200;
export const T3_HOST_LABEL_MAX = 200;
export const T3HostIdSchema = z.string().trim().min(1).max(T3_HOST_ID_MAX);
export const T3HostLabelSchema = z.string().trim().min(1).max(T3_HOST_LABEL_MAX);

/** Default projects root on a T3 host (`~/www` on user-owned hosts, `/var/www` on managed containers, #BIT-146). */
export function defaultT3HostProjectsRoot(kind: T3HostKind = "user"): string {
  return kind === "container" ? HOST_PROJECTS_ROOT_CONTAINER : HOST_PROJECTS_ROOT_USER;
}

export const AGENT_RUN_STATES = [
  "queued",
  "working",
  "waiting_for_approval",
  /** The session handed a related task to a child T3 session and waits for it to finish (#BIT-141). */
  "waiting_subagent",
  "finished",
  "failed",
  "stopped",
  "offline",
] as const;

export type AgentRunState = (typeof AGENT_RUN_STATES)[number];
export const AgentRunStateSchema = z.enum(AGENT_RUN_STATES);

export const ACTIVE_AGENT_RUN_STATES = ["queued", "working", "waiting_for_approval", "waiting_subagent"] as const;
export type ActiveAgentRunState = (typeof ACTIVE_AGENT_RUN_STATES)[number];

/**
 * Whether a T3 run state represents an active session: running, waiting on a person (#BIT-126),
 * or waiting on a child task's T3 session (#BIT-141).
 */
export function isActiveAgentRunState(state: AgentRunState): state is ActiveAgentRunState {
  return (ACTIVE_AGENT_RUN_STATES as readonly AgentRunState[]).includes(state);
}

export const T3_WORKSPACE_STRATEGIES = ["worktree", "root"] as const;
export type T3WorkspaceStrategy = (typeof T3_WORKSPACE_STRATEGIES)[number];
export const T3WorkspaceStrategySchema = z.enum(T3_WORKSPACE_STRATEGIES);

/** Permission and approval scope modes accepted by T3's `t3_thread_launch` `runtimeMode` (#BIT-166). */
export const T3_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type T3RuntimeMode = (typeof T3_RUNTIME_MODES)[number];
export const T3RuntimeModeSchema = z.enum(T3_RUNTIME_MODES);

/**
 * Only these project and thread orchestration tools may ever be called on a T3 host.
 *
 * Project changes are limited to registering an existing host folder as a T3 project
 * (`t3_project_create`, always with an explicit `workspaceRoot` and never with
 * `createWorkspaceRootIfMissing`) and unregistering it (`t3_project_delete`, which leaves the
 * folder on disk), both owner-only (#BIT-148). Bitig never edits or clones T3 projects and
 * never creates, moves or deletes files on the host.
 */
export const T3_ALLOWED_MCP_TOOLS = [
  "t3_project_list",
  "t3_project_create",
  "t3_project_delete",
  "orchestrator_capabilities",
  "t3_thread_list",
  "t3_thread_launch",
  "t3_thread_read",
  "t3_worktree_list",
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

export const T3_GIT_TEXT_MAX = 256;
export const T3_PR_URL_MAX = 2048;
export const T3_PR_COUNT_MAX = 100;
export const T3_SHORT_SHA_LENGTH = 7;
export const T3PullRequestUrlSchema = z.url({ protocol: /^https?$/ }).max(T3_PR_URL_MAX);
export const T3DiffStatSchema = z.strictObject({
  filesChanged: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export const T3GitMetadataSchema = z.strictObject({
  branch: z.string().trim().min(1).max(T3_GIT_TEXT_MAX).nullable().exactOptional(),
  headSha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).nullable().exactOptional(),
  /** Tracked changes in the working tree or latest task commit; excludes untracked files. */
  diffStat: T3DiffStatSchema.nullable().exactOptional(),
  pullRequestUrls: z.array(T3PullRequestUrlSchema).max(T3_PR_COUNT_MAX).exactOptional(),
});
export type T3GitMetadata = z.output<typeof T3GitMetadataSchema>;
export const ReportT3GitMetadataInputSchema = z.strictObject({
  taskId: z.string().trim().min(1),
  runId: IdSchema.exactOptional(),
  threadId: z.string().trim().min(1).max(T3_GIT_TEXT_MAX),
  metadata: T3GitMetadataSchema,
});
export type ReportT3GitMetadataInput = z.output<typeof ReportT3GitMetadataInputSchema>;

export const AgentRunSchema = z.strictObject({
  ...T3GitMetadataSchema.shape,
  id: IdSchema,
  taskId: IdSchema,
  hostId: T3HostIdSchema.exactOptional(),
  t3ProjectId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(256),
  link: z.string().trim().min(1).max(2048).exactOptional(),
  state: AgentRunStateSchema,
  model: z.string().trim().min(1).max(200).exactOptional(),
  /** The provider instance the thread runs on, when known (set at launch with a model, or on a switch). */
  providerInstanceId: z.string().trim().min(1).max(200).exactOptional(),
  /** Model options chosen on the last switch (#BIT-119) or resolved at launch (#BIT-186), e.g. the effort level. */
  modelOptions: T3ModelSelectionOptionsSchema.exactOptional(),
  /** Where the run's model selection came from (#BIT-186). */
  modelSource: z
    .enum([
      "explicit",
      "explicit_level",
      "profile_override",
      "profile_level",
      "project_default_level",
      "default",
    ])
    .exactOptional(),
  /** The run level key that resolved the model selection, when resolved through a level (#BIT-186). */
  levelKey: z.string().trim().min(1).max(64).exactOptional(),
  /** Reason a higher-precedence run level rule was skipped at launch (#BIT-186). */
  skippedReason: z.string().trim().min(1).max(500).exactOptional(),
  workspaceStrategy: T3WorkspaceStrategySchema.exactOptional(),
  /** On a child task's run: the umbrella task whose session started it (#BIT-141). */
  parentTaskId: IdSchema.exactOptional(),
  /** On an umbrella task's run: the child task it waits on while `waiting_subagent` (#BIT-141). */
  waitingForTaskId: IdSchema.exactOptional(),
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
  hostId: T3HostIdSchema.exactOptional(),
  t3ProjectId: z.string().trim().min(1).max(200),
  t3ProjectTitle: z.string().trim().min(1).max(500),
  workspaceRoot: HostFolderPathSchema.exactOptional(),
  updatedAt: TimestampSchema,
});

export type T3ProjectMapping = z.output<typeof T3ProjectMappingSchema>;

export const UpsertT3ProjectMappingInputSchema = z.strictObject({
  hostId: T3HostIdSchema.exactOptional(),
  t3ProjectId: z.string().trim().min(1).max(200),
  t3ProjectTitle: z.string().trim().min(1).max(500),
  workspaceRoot: HostFolderPathSchema.exactOptional(),
});

export type UpsertT3ProjectMappingInput = z.input<typeof UpsertT3ProjectMappingInputSchema>;

export const T3ConnectionStatusSchema = z.strictObject({
  connected: z.boolean(),
  id: T3HostIdSchema.exactOptional(),
  label: T3HostLabelSchema.exactOptional(),
  kind: T3HostKindSchema.exactOptional(),
  projectsRoot: HostFolderPathSchema.exactOptional(),
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

export const T3HostConnectionStatusSchema = z.strictObject({
  id: T3HostIdSchema,
  label: T3HostLabelSchema.exactOptional(),
  kind: T3HostKindSchema,
  projectsRoot: HostFolderPathSchema,
  connected: z.literal(true),
  mcpUrl: z.string(),
  issuer: z.string(),
  scope: z.string().exactOptional(),
  connectedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  expiresInDays: z.number(),
  expiringSoon: z.boolean(),
  expired: z.boolean(),
});

export type T3HostConnectionStatus = z.output<typeof T3HostConnectionStatusSchema>;

export const UpdateT3HostInputSchema = z.strictObject({
  label: z.string().trim().min(1).max(T3_HOST_LABEL_MAX).nullable().exactOptional(),
  kind: T3HostKindSchema.exactOptional(),
  projectsRoot: HostFolderPathSchema.exactOptional(),
});

export type UpdateT3HostInput = z.input<typeof UpdateT3HostInputSchema>;

export const T3StartOAuthInputSchema = z.strictObject({
  mcpUrl: z.string().trim().min(1).max(512),
  hostId: T3HostIdSchema.exactOptional(),
  label: T3HostLabelSchema.exactOptional(),
  kind: T3HostKindSchema.exactOptional(),
  projectsRoot: HostFolderPathSchema.exactOptional(),
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
  readonly itemCount?: number | undefined;
}

export interface T3RunSummary {
  readonly status?: string | undefined;
  readonly state?: string | undefined;
}

/** Max length of a thread stop/failure reason summary extracted from T3 (#BIT-132). */
export const T3_STOP_REASON_MAX = 500;

export interface T3TaskRunLiveResponse {
  /** Persisted Git/PR metadata is included on `run`, including when the host is offline. */
  readonly run: AgentRun | null;
  readonly pendingRequestId?: string | undefined;
  readonly pendingQuestions: T3PendingQuestion[];
  /** Why the thread stopped or failed (e.g. usage limit, credit exhaustion, runtime error, #BIT-132). */
  readonly stopReason?: string | undefined;
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
  readonly gitMetadata?: T3GitMetadata | undefined;
}

export interface T3ProjectActiveSession {
  readonly threadId: string;
  readonly projectId: string;
  readonly hostId?: string | undefined;
  readonly t3ProjectId: string;
  readonly state: ActiveAgentRunState;
  readonly taskId?: string | undefined;
  readonly title?: string | undefined;
  readonly link?: string | undefined;
  readonly model?: string | undefined;
  readonly updatedAt?: string | undefined;
  /** The child task this session waits on while `waiting_subagent` (#BIT-141). */
  readonly waitingForTaskId?: string | undefined;
}

/** The active T3 session that already runs in a project's root checkout (#BIT-134). */
export interface T3WorkspaceBusySession {
  readonly threadId: string;
  readonly state: ActiveAgentRunState;
  readonly taskId?: string | undefined;
  readonly taskCode?: string | undefined;
  readonly title?: string | undefined;
  readonly link?: string | undefined;
}

/**
 * Refuses a T3 launch in the project root (`workspaceStrategy: "root"`) while another active
 * session already runs there: two agents editing one checkout overwrite each other's changes.
 */
export class T3WorkspaceBusyError extends BitigError {
  readonly session: T3WorkspaceBusySession;

  constructor(session: T3WorkspaceBusySession, options?: ErrorOptions) {
    const label = session.taskCode ?? session.title ?? session.threadId;
    super(
      ERROR_CODES.workspaceBusy,
      `Another T3 session (${label}) is ${session.state.replaceAll("_", " ")} in this project's root checkout. ` +
        "Start this task in an isolated git worktree, or wait until that session finishes.",
      options,
    );
    this.name = "T3WorkspaceBusyError";
    this.session = session;
  }
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
  options: T3ModelSelectionOptionsSchema.exactOptional(),
  modelOptions: T3ModelSelectionOptionsSchema.exactOptional(),
  modelSelection: T3ModelSelectionSchema.exactOptional(),
  level: z.string().trim().min(1).max(64).exactOptional(),
  runtimeMode: T3RuntimeModeSchema.exactOptional(),
});

export type StartT3ThreadInput = z.input<typeof StartT3ThreadInputSchema>;

export interface ParsedT3RunCommand {
  readonly workspaceStrategy?: T3WorkspaceStrategy | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly level?: string | undefined;
  readonly runtimeMode?: T3RuntimeMode | undefined;
  readonly note?: string | undefined;
}

const T3_RUN_COMMAND_MAX_FIELD = 200;

/**
 * Parses an explicit `/t3 run` human comment command (#BIT-166), e.g.:
 * - `/t3 run`
 * - `/t3 run model=claude-opus-4-7 worktree`
 * - `/t3 run level=cheap worktree`
 * - `/t3 run model=prov-claude::claude-opus-4-7 root scope=approval-required`
 * - `/t3 run provider=prov-codex model=gpt-6-sol mode=auto-accept-edits`
 *
 * Only matches when the comment's first non-empty line starts with `/t3 run`. Returns `null`
 * for ordinary comments or when any token on the `/t3 run` line is unrecognized or invalid.
 */
export function parseT3RunCommentCommand(body: string): ParsedT3RunCommand | null {
  const trimmed = body.trim();
  if (!trimmed) return null;

  const lines = trimmed.split(/\r?\n/u);
  const firstLine = (lines[0] ?? "").trim();
  const match = /^\/t3\s+run(?:\s+(.*))?$/iu.exec(firstLine);
  if (!match) return null;

  const rawArgs = (match[1] ?? "").trim();
  const tokens = rawArgs.length > 0 ? rawArgs.split(/\s+/u) : [];

  let workspaceStrategy: T3WorkspaceStrategy | undefined;
  let providerInstanceId: string | undefined;
  let model: string | undefined;
  let level: string | undefined;
  let runtimeMode: T3RuntimeMode | undefined;

  for (const rawToken of tokens) {
    const token = rawToken.replace(/^--/u, "");
    if (!token) return null;

    const eqIndex = token.indexOf("=");
    if (eqIndex >= 0) {
      const key = token.slice(0, eqIndex).trim().toLowerCase();
      const val = token.slice(eqIndex + 1).trim();
      if (!key || !val) return null;

      if (key === "workspace" || key === "workspacestrategy") {
        const parsedWs = T3WorkspaceStrategySchema.safeParse(val.toLowerCase());
        if (!parsedWs.success) return null;
        if (workspaceStrategy && workspaceStrategy !== parsedWs.data) return null;
        workspaceStrategy = parsedWs.data;
        continue;
      }

      if (key === "model") {
        if (val.length > T3_RUN_COMMAND_MAX_FIELD * 2 + 2) return null;
        if (val.includes("::")) {
          const parts = val.split("::");
          if (parts.length !== 2) return null;
          const prov = (parts[0] ?? "").trim();
          const mod = (parts[1] ?? "").trim();
          if (!prov || !mod || prov.length > T3_RUN_COMMAND_MAX_FIELD || mod.length > T3_RUN_COMMAND_MAX_FIELD) {
            return null;
          }
          if (providerInstanceId && providerInstanceId !== prov) return null;
          if (model && model !== mod) return null;
          providerInstanceId = prov;
          model = mod;
        } else {
          if (val.length > T3_RUN_COMMAND_MAX_FIELD) return null;
          if (model && model !== val) return null;
          model = val;
        }
        continue;
      }

      if (key === "provider" || key === "providerinstanceid") {
        if (val.length > T3_RUN_COMMAND_MAX_FIELD) return null;
        if (providerInstanceId && providerInstanceId !== val) return null;
        providerInstanceId = val;
        continue;
      }

      if (key === "level") {
        const lowerVal = val.toLowerCase();
        if (lowerVal.length > 64) return null;
        if (level && level !== lowerVal) return null;
        level = lowerVal;
        continue;
      }

      if (key === "scope" || key === "mode" || key === "runtimemode" || key === "permissions") {
        const parsedMode = T3RuntimeModeSchema.safeParse(val.toLowerCase());
        if (!parsedMode.success) return null;
        if (runtimeMode && runtimeMode !== parsedMode.data) return null;
        runtimeMode = parsedMode.data;
        continue;
      }

      return null;
    }

    const lower = token.toLowerCase();
    const parsedWs = T3WorkspaceStrategySchema.safeParse(lower);
    if (parsedWs.success) {
      if (workspaceStrategy && workspaceStrategy !== parsedWs.data) return null;
      workspaceStrategy = parsedWs.data;
      continue;
    }

    const parsedMode = T3RuntimeModeSchema.safeParse(lower);
    if (parsedMode.success) {
      if (runtimeMode && runtimeMode !== parsedMode.data) return null;
      runtimeMode = parsedMode.data;
      continue;
    }

    return null;
  }

  const note = lines.slice(1).join("\n").trim();
  return {
    ...(workspaceStrategy ? { workspaceStrategy } : {}),
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(model ? { model } : {}),
    ...(level ? { level } : {}),
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(note ? { note } : {}),
  };
}

export const SendT3MessageInputSchema = z.strictObject({
  message: z.string().trim().min(1).max(20_000),
  mode: z.enum(["auto", "queue", "steer", "restart"]).default("auto"),
});

export type SendT3MessageInput = z.input<typeof SendT3MessageInputSchema>;

/**
 * A person's reply to a waiting T3 thread (#BIT-119, #BIT-165): saved as a Bitig comment and sent
 * to the thread. With `modelSelection`, the thread switches to that model first; with `freshSession`,
 * the previous thread is settled and a fresh checkpoint-seeded T3 thread is launched instead.
 */
export const ReplyToT3RunInputSchema = z.strictObject({
  body: CommentBodySchema,
  author: CommentAuthorSchema.exactOptional(),
  modelSelection: T3ModelSelectionSchema.exactOptional(),
  freshSession: z.boolean().exactOptional(),
});

export type ReplyToT3RunInput = z.input<typeof ReplyToT3RunInputSchema>;

/** Longest prompt or follow-up a person can send to a project-level T3 thread (#BIT-127). */
export const PROJECT_T3_PROMPT_MAX = 20_000;
/** Longest title Bitig gives a project-level T3 thread, taken from the prompt's first line. */
export const PROJECT_T3_THREAD_TITLE_MAX = 120;
/** Project threads are usually environment checks, so they run in the project root by default. */
export const DEFAULT_PROJECT_T3_WORKSPACE_STRATEGY: T3WorkspaceStrategy = "root";

/** A T3 thread Bitig started for a project without a task (#BIT-127). */
export const ProjectT3ThreadSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  hostId: T3HostIdSchema.exactOptional(),
  t3ProjectId: z.string().trim().min(1).max(200),
  threadId: z.string().trim().min(1).max(256),
  title: z.string().trim().min(1).max(PROJECT_T3_THREAD_TITLE_MAX),
  link: z.string().trim().min(1).max(2048).exactOptional(),
  state: AgentRunStateSchema,
  /** Why the thread stopped or failed (e.g. usage limit, credit exhaustion, runtime error, #BIT-132). */
  stopReason: z.string().trim().min(1).max(T3_STOP_REASON_MAX).exactOptional(),
  model: z.string().trim().min(1).max(200).exactOptional(),
  providerInstanceId: z.string().trim().min(1).max(200).exactOptional(),
  modelOptions: T3ModelSelectionOptionsSchema.exactOptional(),
  workspaceStrategy: T3WorkspaceStrategySchema,
  startedBy: TaskActorSchema.exactOptional(),
  startedAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type ProjectT3Thread = z.output<typeof ProjectT3ThreadSchema>;

export interface ProjectT3ThreadsResponse {
  readonly threads: ProjectT3Thread[];
}

/** Starts a project-level T3 thread with a person's prompt (#BIT-127). */
export const StartProjectT3ThreadInputSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(PROJECT_T3_PROMPT_MAX),
  workspaceStrategy: T3WorkspaceStrategySchema.exactOptional(),
  modelSelection: T3ModelSelectionSchema.exactOptional(),
});

export type StartProjectT3ThreadInput = z.input<typeof StartProjectT3ThreadInputSchema>;

/** A follow-up to a project-level T3 thread; with `modelSelection`, the thread switches model first. */
export const SendProjectT3MessageInputSchema = z.strictObject({
  body: z.string().trim().min(1).max(PROJECT_T3_PROMPT_MAX),
  modelSelection: T3ModelSelectionSchema.exactOptional(),
});

export type SendProjectT3MessageInput = z.input<typeof SendProjectT3MessageInputSchema>;

const ELLIPSIS = "\u2026";

/** The thread title: the prompt's first non-empty line, cut to `PROJECT_T3_THREAD_TITLE_MAX`. */
export function buildProjectT3ThreadTitle(prompt: string): string {
  const firstLine =
    prompt
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";
  const line = firstLine || "Project message";
  return line.length <= PROJECT_T3_THREAD_TITLE_MAX
    ? line
    : `${line.slice(0, PROJECT_T3_THREAD_TITLE_MAX - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** A label for the project in prompts, e.g. `"Bitig" (BIT)`. */
export function formatProjectT3Label(project: { readonly name: string; readonly key?: string | undefined }): string {
  return project.key ? `"${project.name}" (${project.key})` : `"${project.name}"`;
}

/**
 * The first prompt of a project-level thread. There is no Bitig task behind it, so the agent is told
 * not to create or change Bitig tasks unless the person asks for that.
 */
export function buildProjectT3LaunchPrompt(input: {
  readonly project: { readonly name: string; readonly key?: string | undefined };
  readonly prompt: string;
}): string {
  return [
    `Project-level message from Bitig project ${formatProjectT3Label(input.project)}.`,
    "There is no Bitig task for this thread: do not create, update, or complete Bitig tasks unless asked to.",
    "",
    input.prompt.trim(),
  ].join("\n");
}

/** The line put before a follow-up after a project thread switches models. */
export function buildProjectT3ModelSwitchNotice(to: string): string {
  return `The thread switched to ${to}. Continue from the conversation so far.`;
}

const PROJECT_LAUNCH_PROMPT_HEADER_PATTERN =
  /^Project-level message from Bitig project [^\n]+\nThere is no Bitig task for this thread: do not create, update, or complete Bitig tasks unless asked to\.\n\n/;

const PROJECT_MODEL_SWITCH_NOTICE_PATTERN =
  /^The thread switched to [^\n]+\. Continue from the conversation so far\.\n\n/;

/**
 * Strips the synthetic Bitig launch header or model-switch notice from a person's project-level
 * prompt so the conversation view shows only what the person wrote (#BIT-131).
 */
export function stripProjectT3PromptHeader(text: string): string {
  return text
    .replace(PROJECT_LAUNCH_PROMPT_HEADER_PATTERN, "")
    .replace(PROJECT_MODEL_SWITCH_NOTICE_PATTERN, "");
}

export const T3_THREAD_MESSAGE_ROLES = ["user", "assistant"] as const;
export type T3ThreadMessageRole = (typeof T3_THREAD_MESSAGE_ROLES)[number];
export const T3ThreadMessageRoleSchema = z.enum(T3_THREAD_MESSAGE_ROLES);

/** Max messages returned in a single page when reading a project T3 thread (#BIT-131). */
export const PROJECT_T3_MESSAGES_PAGE_LIMIT = 100;
/** Max characters kept per message when reading a project T3 thread (#BIT-131). */
export const PROJECT_T3_MESSAGE_MAX_CHARS = 20_000;

/** One user or assistant message from `t3_thread_read` (`view: "messages"`, #BIT-131). */
export const T3ThreadMessageSchema = z.strictObject({
  position: z.number().int().min(0),
  role: T3ThreadMessageRoleSchema,
  text: z.string(),
  truncated: z.boolean(),
  status: z.string().trim().min(1).max(100).exactOptional(),
  updatedAt: z.string().trim().min(1).max(100).exactOptional(),
});

export type T3ThreadMessage = z.output<typeof T3ThreadMessageSchema>;

export interface ProjectT3ThreadMessagesResponse {
  readonly thread: ProjectT3Thread;
  readonly messages: T3ThreadMessage[];
  readonly nextPosition: number | null;
  readonly hasMore: boolean;
  /** Why the thread stopped or failed (e.g. usage limit, credit exhaustion, runtime error, #BIT-132). */
  readonly stopReason?: string | undefined;
}

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
  const userInfo = (match[2] ?? "");
  const hostname = (match[3] ?? "").toLowerCase();
  const port = (match[4] ?? "");
  const pathname = (match[5] ?? "");
  const query = (match[6] ?? "");
  const hash = (match[7] ?? "");

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
    readonly id?: string | null | undefined;
    readonly label?: string | null | undefined;
    readonly kind?: T3HostKind | null | undefined;
    readonly projectsRoot?: string | null | undefined;
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
    ...(record.id ? { id: record.id } : {}),
    ...(record.label ? { label: record.label } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
    ...(record.projectsRoot ? { projectsRoot: record.projectsRoot } : {}),
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

export function computeT3HostConnectionStatus(
  record: {
    readonly id: string;
    readonly label?: string | null | undefined;
    readonly kind?: T3HostKind | null | undefined;
    readonly projectsRoot?: string | null | undefined;
    readonly mcpUrl: string;
    readonly issuer: string;
    readonly scope?: string | null | undefined;
    readonly connectedAt: number;
    readonly expiresAt: number;
  },
  nowMs: number = Date.now(),
): T3HostConnectionStatus {
  const kind: T3HostKind = record.kind === "container" ? "container" : "user";
  const projectsRoot = record.projectsRoot ?? defaultT3HostProjectsRoot(kind);
  const remainingMs = record.expiresAt - nowMs;
  const expired = remainingMs <= 0;
  const expiringSoon = !expired && remainingMs <= T3_EXPIRY_WARNING_MS;
  const expiresInDays = Math.max(0, Math.ceil(remainingMs / MS_PER_DAY));
  return {
    id: record.id,
    ...(record.label ? { label: record.label } : {}),
    kind,
    projectsRoot,
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
  readonly gitMetadataRunId?: string | undefined;
  readonly task: Task;
  readonly taskCode?: string | undefined;
  readonly code?: string | undefined;
  readonly projectName?: string | undefined;
  readonly comments?: readonly Comment[] | undefined;
  /** Set when an umbrella task's session started this task as a child session (#BIT-141). */
  readonly parentTaskCode?: string | undefined;
  /** Latest checkpoint snapshot to seed a fresh follow-up session (#BIT-165). */
  readonly checkpoint?: Checkpoint | null | undefined;
  /** Prior run's Git branch/commit/diff/PR summary when relaunching in a fresh session (#BIT-165). */
  readonly priorGitMetadata?: T3GitMetadata | undefined;
  /** The person's follow-up instruction that triggered a fresh session (#BIT-165). */
  readonly followUpComment?:
    | {
        readonly author: string;
        readonly body: string;
        readonly attachments?: readonly T3CommentAttachmentInfo[] | undefined;
      }
    | undefined;
  /** Override `clientRequestId` so a relaunched thread gets a distinct idempotency key (#BIT-165). */
  readonly clientRequestId?: string | undefined;
}

export interface BuiltT3LaunchPrompt {
  readonly title: string;
  readonly clientRequestId: string;
  readonly prompt: string;
}

function formatPriorGitSummaryLines(git: T3GitMetadata): string[] {
  const parts: string[] = [];
  if (git.branch) {
    parts.push(`branch \`${git.branch}\``);
  }
  if (git.headSha) {
    parts.push(`commit \`${git.headSha.slice(0, T3_SHORT_SHA_LENGTH)}\``);
  }
  if (git.diffStat) {
    parts.push(
      `${String(git.diffStat.filesChanged)} files changed (+${String(git.diffStat.insertions)} / -${String(git.diffStat.deletions)})`,
    );
  }
  if (git.pullRequestUrls && git.pullRequestUrls.length > 0) {
    parts.push(`PRs: ${git.pullRequestUrls.join(", ")}`);
  }
  return parts.length > 0 ? [`- **Prior Git State:** ${parts.join(" · ")}`] : [];
}

function formatCheckpointSnapshotSection(checkpoint: Checkpoint, priorGitMetadata?: T3GitMetadata): string {
  const { stateSnapshot } = checkpoint;
  const lines: string[] = [
    "## Latest Checkpoint (from prior session)",
    "",
    `- **Step:** ${String(checkpoint.stepIndex)} (${checkpoint.status})`,
    `- **Summary:** ${truncateText(stateSnapshot.summary, T3_HANDBACK_TEXT_MAX)}`,
  ];
  if (stateSnapshot.modifiedArtifacts.length > 0) {
    lines.push(
      `- **Modified Artifacts:** ${truncateText(stateSnapshot.modifiedArtifacts.join(", "), T3_HANDBACK_TEXT_MAX)}`,
    );
  }
  if (stateSnapshot.decisionsMade.length > 0) {
    lines.push(`- **Decisions Made:** ${truncateText(stateSnapshot.decisionsMade.join("; "), T3_HANDBACK_TEXT_MAX)}`);
  }
  if (stateSnapshot.nextStepInstructions.trim().length > 0) {
    lines.push(
      `- **Next Step Instructions:** ${truncateText(stateSnapshot.nextStepInstructions, T3_HANDBACK_TEXT_MAX)}`,
    );
  }
  if (priorGitMetadata) {
    lines.push(...formatPriorGitSummaryLines(priorGitMetadata));
  }
  return lines.join("\n");
}

/**
 * Formats the thread title, idempotency key (`clientRequestId`), and initial prompt
 * with standing Bitig MCP instructions for launching a T3 thread on a task.
 */
export function buildT3LaunchPrompt({
  gitMetadataRunId,
  task,
  taskCode,
  code: codeAlias,
  comments = [],
  parentTaskCode,
  checkpoint,
  priorGitMetadata,
  followUpComment,
  clientRequestId,
}: BuildT3LaunchPromptInput): BuiltT3LaunchPrompt {
  const code = (taskCode ?? codeAlias ?? "").trim() || task.id;
  const title = `${code} ${task.title}`.slice(0, 512);
  const sections: string[] = [`# ${code}: ${task.title}`];
  if (gitMetadataRunId) {
    sections.push(`## Git metadata reporting\n\nBefore every final response (whether completing the task, pausing for human input, or replying to a follow-up comment), call report_t3_git_metadata with taskId "${code}", runId "${gitMetadataRunId}", your current T3 threadId, and metadata. Read branch with git branch --show-current (if you merged the branch into master or main and detached the worktree, report that target branch instead of null), headSha with git rev-parse HEAD, and diffStat with git diff HEAD --numstat when uncommitted tracked changes exist, or git show --numstat --format="" HEAD when your changes are already committed (exclude untracked files; count binary files but not binary lines). diffStat is { filesChanged, insertions, deletions }. Include known HTTP(S) pullRequestUrls. Omit unknown fields, use null to clear branch/headSha/diffStat, and [] for a known empty PR list. Never guess values or substitute another run's identity. If reporting fails, mention it in your final task comment.`);
  }

  if (task.description.trim().length > 0) {
    sections.push(`## Description\n\n${task.description.trim()}`);
  }

  if (task.checklist && task.checklist.length > 0) {
    const items = task.checklist
      .map((item, idx) => `${String(idx + 1)}. [${item.done ? "x" : " "}] ${item.text}`)
      .join("\n");
    sections.push(`## Checklist\n\n${items}`);
  }

  if (checkpoint) {
    sections.push(formatCheckpointSnapshotSection(checkpoint, priorGitMetadata));
  } else if (priorGitMetadata) {
    const gitLines = formatPriorGitSummaryLines(priorGitMetadata);
    if (gitLines.length > 0) {
      sections.push(["## Prior Session Git State", "", ...gitLines].join("\n"));
    }
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

  if (followUpComment) {
    const attachmentContext = formatT3CommentAttachmentContext(
      followUpComment.body,
      followUpComment.attachments,
    );
    sections.push(
      [
        "## Follow-Up Instruction (Fresh T3 Session)",
        "",
        `This is a fresh T3 session continuing ${code} after the previous thread was settled. Follow this instruction from **${followUpComment.author}**:`,
        "",
        followUpComment.body.trim(),
        ...(attachmentContext ? ["", attachmentContext] : []),
      ].join("\n"),
    );
  }

  const parentCode = parentTaskCode?.trim();
  if (parentCode) {
    sections.push(
      [
        "## Umbrella Task",
        "",
        `This session was started from the T3 session of umbrella task ${parentCode}. Work only on ${code}; do not start, update, or complete ${parentCode}.`,
        `When ${code} is finished and verified, post the final comment and call \`complete_task({ id: "${code}" })\`: Bitig then hands your final comment and latest checkpoint back to ${parentCode}'s session.`,
      ].join("\n"),
    );
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
      `9. Checklist items are steps of ${code}, not separate tasks: do them in this session and never start child sessions for them. If ${code} is an umbrella over other Bitig tasks (tasks it mentions or that depend on it), you may hand one approved, unblocked related task to its own T3 session with \`start_t3_thread({ taskId: "<child-code>", parentTaskId: "${code}" })\`. Start one child at a time, then end your turn without polling: Bitig resumes this thread with the child's completion context when it is done, or tells you if its session fails or stops.`,
    ].join("\n"),
  );

  return {
    title,
    clientRequestId: (clientRequestId ?? "").trim() || code,
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

/** Longest text taken from a child task's comment or checkpoint field in a handback (#BIT-141). */
export const T3_HANDBACK_TEXT_MAX = 4000;
/** Most checklist items listed in a handback; the rest are only counted (#BIT-141). */
export const T3_HANDBACK_CHECKLIST_MAX = 30;

function truncateText(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

/** The comment Bitig records on an umbrella task when its session starts a child session (#BIT-141). */
export function buildT3SubagentStartedComment(input: {
  readonly childLabel: string;
  readonly childTitle: string;
  readonly link?: string | undefined;
}): string {
  const thread = input.link ? ` ([T3 thread](${input.link}))` : "";
  return (
    `Started child task #${input.childLabel} "${input.childTitle}" in a separate T3 session${thread}. ` +
    "This session waits until that task is done, then Bitig resumes it with the child's completion context."
  );
}

export interface T3SubagentHandbackInput {
  /** Ticket code (or quoted title) of the umbrella task. */
  readonly parentLabel: string;
  /** Ticket code (or ID) of the child task. */
  readonly childLabel: string;
  readonly child: Task;
  /** The child's latest checkpoint, when it saved one. */
  readonly checkpoint?: Checkpoint | undefined;
  /** The child's latest agent comment, usually its final report. */
  readonly finalComment?: Comment | undefined;
}

/** The child task's completion context: status, checklist, latest checkpoint, and final agent comment. */
function buildT3SubagentContext(input: T3SubagentHandbackInput): string {
  const { child } = input;
  const lines: string[] = [`- Task: #${input.childLabel} "${child.title}"`, `- Status: ${child.status}`];

  const checklist = child.checklist ?? [];
  if (checklist.length > 0) {
    const done = checklist.filter((item) => item.done).length;
    lines.push(`- Checklist: ${String(done)}/${String(checklist.length)} done`);
    for (const item of checklist.slice(0, T3_HANDBACK_CHECKLIST_MAX)) {
      lines.push(`  - [${item.done ? "x" : " "}] ${item.text}`);
    }
    const hidden = checklist.length - T3_HANDBACK_CHECKLIST_MAX;
    if (hidden > 0) {
      lines.push(`  - …and ${String(hidden)} more`);
    }
  }

  const snapshot = input.checkpoint?.stateSnapshot;
  if (snapshot) {
    lines.push(`- Latest checkpoint (step ${String(input.checkpoint.stepIndex)}): ${truncateText(snapshot.summary, T3_HANDBACK_TEXT_MAX)}`);
    if (snapshot.modifiedArtifacts.length > 0) {
      lines.push(`  - Modified: ${truncateText(snapshot.modifiedArtifacts.join(", "), T3_HANDBACK_TEXT_MAX)}`);
    }
    if (snapshot.decisionsMade.length > 0) {
      lines.push(`  - Decisions: ${truncateText(snapshot.decisionsMade.join("; "), T3_HANDBACK_TEXT_MAX)}`);
    }
  }

  const sections = [lines.join("\n")];
  if (input.finalComment) {
    const who = input.finalComment.author ?? input.finalComment.authorType;
    sections.push(`Final comment from ${who}:\n\n${truncateText(input.finalComment.body, T3_HANDBACK_TEXT_MAX)}`);
  }
  return sections.join("\n\n");
}

/** The comment recorded on the umbrella task when a child task is completed (#BIT-141). */
export function buildT3SubagentCompletedComment(input: T3SubagentHandbackInput): string {
  return truncateText(
    `Child task #${input.childLabel} is ${input.child.status}. Resuming this session.\n\n${buildT3SubagentContext(input)}`,
    COMMENT_BODY_MAX,
  );
}

/** The prompt sent to the umbrella task's T3 thread when a child task is completed (#BIT-141). */
export function buildT3SubagentCompletedPrompt(input: T3SubagentHandbackInput): string {
  return truncateText(
    [
      `Child task ${input.childLabel} that you started from ${input.parentLabel} is ${input.child.status}.`,
      "",
      buildT3SubagentContext(input),
      "",
      `Continue ${input.parentLabel}: call \`get_task({ id: "${input.parentLabel}" })\` and \`resume_from_checkpoint({ taskId: "${input.parentLabel}" })\`, then move on to the next related task or finish the umbrella task.`,
    ].join("\n"),
    COMMENT_BODY_MAX,
  );
}

export interface T3SubagentEndedInput extends T3SubagentHandbackInput {
  /** The child session's end state: it failed or was stopped before the task was done. */
  readonly state: "failed" | "stopped";
  readonly stopReason?: string | undefined;
}

function describeEndedChild(input: T3SubagentEndedInput): string {
  const reason = input.stopReason ? ` Reason: ${truncateText(input.stopReason, T3_STOP_REASON_MAX)}` : "";
  return `The T3 session of child task #${input.childLabel} ${input.state} before the task was done.${reason}`;
}

/** The comment recorded on the umbrella task when a child session fails or stops (#BIT-141). */
export function buildT3SubagentEndedComment(input: T3SubagentEndedInput): string {
  return truncateText(
    `${describeEndedChild(input)} This session no longer waits for it.\n\n${buildT3SubagentContext(input)}`,
    COMMENT_BODY_MAX,
  );
}

/** The prompt sent to the umbrella task's T3 thread when a child session fails or stops (#BIT-141). */
export function buildT3SubagentEndedPrompt(input: T3SubagentEndedInput): string {
  return truncateText(
    [
      `${describeEndedChild(input)} You started it from ${input.parentLabel}.`,
      "",
      buildT3SubagentContext(input),
      "",
      `Decide how ${input.parentLabel} continues: restart the child with \`start_t3_thread({ taskId: "${input.childLabel}", parentTaskId: "${input.parentLabel}" })\`, move on to another related task, or ask a person through a comment and \`needsHuman\` on ${input.parentLabel}.`,
    ].join("\n"),
    COMMENT_BODY_MAX,
  );
}
