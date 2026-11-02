import {
  NotFoundError,
  ValidationError,
  buildT3LaunchPrompt,
  buildT3ModelSwitchComment,
  buildT3ModelSwitchNotice,
  canSwitchT3Model,
  checkStatusChange,
  computeT3ConnectionStatus,
  defaultIdGenerator,
  deriveLiveAgentRunState,
  formatT3ModelSelection,
  isSameT3ModelSelection,
  resolveTaskRef,
  taskCode,
  type AgentRun,
  type AgentRunState,
  type Comment,
  type RealtimeEvent,
  type StorageProvider,
  type T3ConnectionStatus,
  type T3ModelCapability,
  type T3ModelSelection,
  type T3TaskRunLiveResponse,
  type T3WorkspaceStrategy,
  type Task,
} from "@bitig/core";
import type { T3D1Store } from "@bitig/storage-d1";
import { T3McpClient, T3McpError } from "./client";
import { decryptT3Token } from "./crypto";

/** How long the model list from `orchestrator_capabilities` is reused before T3 is asked again. */
export const T3_CAPABILITIES_CACHE_TTL_SECONDS = 5 * 60;

/** Synthetic origin for Cache API keys; it is never fetched. */
const T3_CAPABILITIES_CACHE_ORIGIN = "https://t3-capabilities.bitig.internal";

/**
 * A model switch was refused because the thread is mid-turn or unreachable (#BIT-119).
 * The route maps it to HTTP 409.
 */
export class T3ModelSwitchConflictError extends Error {
  override readonly name = "T3ModelSwitchConflictError";
  readonly code = "thread_busy";
  readonly state: AgentRunState;

  constructor(state: AgentRunState) {
    super(
      `The T3 thread is ${state.replaceAll("_", " ")}. Switch models only while it waits for you or after its turn ends.`,
    );
    this.state = state;
  }
}

export interface T3ServiceDeps {
  store: T3D1Store;
  storage: StorageProvider;
  encryptionKey: string;
  fetchFn?: typeof fetch | undefined;
  publishRealtime?: ((event: RealtimeEvent) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

function makeValidationIssue(path: string, message: string): never {
  throw new ValidationError("t3", [
    {
      code: "custom",
      path: [path],
      message,
      input: path,
    },
  ]);
}

export async function getT3ConnectionStatus(
  store: T3D1Store,
  now = Date.now(),
): Promise<T3ConnectionStatus> {
  const connection = await store.getConnection();
  return computeT3ConnectionStatus(
    connection
      ? {
          mcpUrl: connection.mcpUrl,
          issuer: connection.issuer,
          scope: connection.scope,
          connectedAt: connection.connectedAt,
          expiresAt: connection.expiresAt,
        }
      : null,
    now,
  );
}

export async function createActiveT3McpClient(deps: {
  store: T3D1Store;
  encryptionKey: string;
  fetchFn?: typeof fetch | undefined;
  now?: number | undefined;
}): Promise<T3McpClient> {
  if (!deps.encryptionKey) {
    makeValidationIssue(
      "t3Connection",
      "T3_ENCRYPTION_KEY is not configured on this Worker; cannot use T3 integration",
    );
  }
  const connection = await deps.store.getConnection();
  if (!connection) {
    makeValidationIssue("t3Connection", "No T3 Code host is connected. Connect one in Settings first.");
  }
  const now = deps.now ?? Date.now();
  if (connection.expiresAt <= now) {
    makeValidationIssue(
      "t3Connection",
      "The T3 Code OAuth token has expired. Reconnect in Settings before starting or controlling a thread.",
    );
  }
  const accessToken = await decryptT3Token(
    {
      ciphertext: connection.encryptedAccessToken,
      iv: connection.tokenIv,
    },
    deps.encryptionKey,
  );
  return new T3McpClient({
    mcpUrl: connection.mcpUrl,
    accessToken,
    fetchFn: deps.fetchFn,
  });
}

export interface LaunchTaskInT3Options {
  taskRef: string;
  workspaceStrategy?: T3WorkspaceStrategy | undefined;
  providerInstanceId?: string | undefined;
  model?: string | undefined;
  actor?: string | undefined;
}

export interface LaunchTaskInT3Result {
  run: AgentRun;
  task: Task;
  code?: string | undefined;
}

/**
 * Starts a T3 thread for a Bitig task after verifying:
 * 1. The task exists and is not waiting for human approval (`pendingApproval`).
 * 2. All tasks in `dependsOn` are finished (`done` or `archived`).
 * 3. The task's Bitig project is mapped to an existing T3 project.
 * 4. A valid, non-expired T3 OAuth connection is configured.
 */
export async function launchTaskInT3(
  deps: T3ServiceDeps,
  options: LaunchTaskInT3Options,
): Promise<LaunchTaskInT3Result> {
  const now = deps.now ? deps.now() : Date.now();
  const taskId = await resolveTaskRef(deps.storage, options.taskRef);
  const task = await deps.storage.getTask(taskId);
  if (!task) {
    throw new NotFoundError("task", taskId);
  }

  const project = await deps.storage.getProject(task.projectId);
  if (!project) {
    throw new NotFoundError("project", task.projectId);
  }

  // Enforce pendingApproval and unfinished dependency gates (same rules as an agent moving to in_progress)
  await checkStatusChange(deps.storage, task.id, "in_progress", "startT3Thread", {
    requireApproval: true,
  });

  const mapping = await deps.store.getProjectMapping(task.projectId);
  if (!mapping) {
    makeValidationIssue(
      "projectId",
      `Project "${project.name}" is not mapped to a T3 project. Map it in Settings first.`,
    );
  }

  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  const comments = await deps.storage.getComments(task.id);
  const code = taskCode(task, project);
  const workspaceStrategy: T3WorkspaceStrategy = options.workspaceStrategy ?? "worktree";
  const builtPrompt = buildT3LaunchPrompt({
    task,
    ...(code ? { taskCode: code } : {}),
    projectName: project.name,
    comments,
  });

  const launched = await mcpClient.launchThread({
    projectId: mapping.t3ProjectId,
    title: builtPrompt.title,
    prompt: builtPrompt.prompt,
    clientRequestId: builtPrompt.clientRequestId,
    workspaceStrategy,
    providerInstanceId: options.providerInstanceId,
    model: options.model,
  });

  const actor = (options.actor?.trim() ?? "") || "t3";
  const updatedTask =
    task.status === "in_progress"
      ? task
      : await deps.storage.updateTask(
          task.id,
          { status: "in_progress" },
          { actor },
        );

  const existingRun = await deps.store.getAgentRunByTaskId(task.id);
  const run = await deps.store.saveAgentRun({
    id: existingRun?.id ?? defaultIdGenerator(),
    taskId: task.id,
    t3ProjectId: mapping.t3ProjectId,
    threadId: launched.threadId,
    link: launched.link,
    state: "working",
    model: options.model,
    ...(options.model && options.providerInstanceId ? { providerInstanceId: options.providerInstanceId } : {}),
    workspaceStrategy,
    startedBy: actor,
    startedAt: now,
    updatedAt: now,
  });

  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run }).catch(() => undefined);
  }

  return {
    run,
    task: updatedTask,
    ...(code ? { code } : {}),
  };
}

/**
 * Checks the live T3 thread status when a task is opened.
 * Updates `agent_runs.state` in D1 and broadcasts `agent_run.updated` if changed,
 * but NEVER mutates the Bitig task's status (`in_progress`, `done`, `archived`, `needsHuman`).
 */
export async function getTaskT3RunLiveStatus(
  deps: T3ServiceDeps,
  taskId: string,
): Promise<T3TaskRunLiveResponse> {
  const existingRun = await deps.store.getAgentRunByTaskId(taskId);
  if (!existingRun) {
    return {
      run: null,
      pendingQuestions: [],
    };
  }

  const now = deps.now ? deps.now() : Date.now();
  let mcpClient: T3McpClient;
  try {
    mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      fetchFn: deps.fetchFn,
      now,
    });
  } catch {
    const offlineRun =
      existingRun.state === "offline"
        ? existingRun
        : ((await deps.store.updateAgentRunState(taskId, { state: "offline", now })) ?? existingRun);
    if (offlineRun.state !== existingRun.state && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: offlineRun }).catch(() => undefined);
    }
    return {
      run: offlineRun,
      pendingQuestions: [],
    };
  }

  try {
    const live = await mcpClient.readThreadLiveStatus(existingRun.threadId);
    const nextState = deriveLiveAgentRunState({
      thread: live.thread,
      recentRuns: live.recentRuns,
      pendingRequestIds: live.pendingRequestIds,
    });

    const updatedRun =
      nextState === existingRun.state
        ? existingRun
        : ((await deps.store.updateAgentRunState(taskId, { state: nextState, now })) ?? existingRun);

    if (updatedRun.state !== existingRun.state && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
    }

    return {
      run: updatedRun,
      ...(live.pendingRequestId ? { pendingRequestId: live.pendingRequestId } : {}),
      pendingQuestions: live.pendingQuestions,
    };
  } catch (err) {
    if (err instanceof T3McpError) {
      const offlineRun =
        existingRun.state === "offline"
          ? existingRun
          : ((await deps.store.updateAgentRunState(taskId, { state: "offline", now })) ?? existingRun);
      if (offlineRun.state !== existingRun.state && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: offlineRun }).catch(() => undefined);
      }
      return {
        run: offlineRun,
        pendingQuestions: [],
      };
    }
    throw err;
  }
}

/** Run states in which a new comment is not forwarded: the T3 host cannot be reached. */
const COMMENT_FORWARD_SKIPPED_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["offline"]);

/** Shown as the comment author in the T3 prompt when the comment has no explicit author. */
const DEFAULT_COMMENT_AUTHOR_LABEL = "a person";

/** Sends a prompt to the run's T3 thread, marks the run as working, and broadcasts the change. */
async function sendPromptToT3Run(
  deps: T3ServiceDeps,
  existingRun: AgentRun,
  prompt: string,
): Promise<T3TaskRunLiveResponse> {
  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  await mcpClient.sendThreadMessage({
    threadId: existingRun.threadId,
    prompt,
  });

  const updatedRun =
    (await deps.store.updateAgentRunState(existingRun.taskId, { state: "working", now })) ?? existingRun;
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
  }
  return {
    run: updatedRun,
    pendingQuestions: [],
  };
}

/** Builds the follow-up prompt a T3 agent receives for a new comment on its task. */
export function buildT3CommentPrompt(input: { taskLabel: string; author: string; body: string }): string {
  return `New comment on ${input.taskLabel} from ${input.author}:\n\n${input.body}`;
}

/**
 * Forwards a person's comment to the task's T3 thread so a waiting agent continues with it.
 * Agent comments are never forwarded, so an agent cannot wake itself up. Returns whether the
 * comment was sent; it is skipped when T3 is not configured, the task has no run, or the run is offline.
 */
export async function forwardCommentToT3Run(deps: T3ServiceDeps, comment: Comment): Promise<boolean> {
  if (comment.authorType !== "human") return false;
  if (!deps.encryptionKey) return false;

  const existingRun = await deps.store.getAgentRunByTaskId(comment.taskId);
  if (!existingRun) return false;
  if (COMMENT_FORWARD_SKIPPED_STATES.has(existingRun.state)) return false;

  const task = await deps.storage.getTask(comment.taskId);
  if (!task) {
    throw new NotFoundError("task", comment.taskId);
  }
  const project = await deps.storage.getProject(task.projectId);
  const prompt = buildT3CommentPrompt({
    taskLabel: taskCode(task, project ?? undefined) ?? `"${task.title}"`,
    author: comment.author ?? DEFAULT_COMMENT_AUTHOR_LABEL,
    body: comment.body,
  });

  await sendPromptToT3Run(deps, existingRun, prompt);
  return true;
}

/**
 * Marks the task's T3 thread as settled (`t3_thread_organize` with `action: "settle"`)
 * when a task is archived (#BIT-117). Returns whether the thread was settled; it is skipped
 * when T3 is not configured, the task has no run, or the run is offline.
 */
export async function settleTaskT3Run(deps: T3ServiceDeps, taskId: string): Promise<boolean> {
  if (!deps.encryptionKey) return false;

  const existingRun = await deps.store.getAgentRunByTaskId(taskId);
  if (!existingRun) return false;
  if (COMMENT_FORWARD_SKIPPED_STATES.has(existingRun.state)) return false;

  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  await mcpClient.settleThread(existingRun.threadId);

  if (existingRun.state !== "finished") {
    const updatedRun =
      (await deps.store.updateAgentRunState(taskId, { state: "finished", now })) ?? existingRun;
    if (updatedRun.state !== existingRun.state && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
    }
  }

  return true;
}

export async function stopTaskT3Run(
  deps: T3ServiceDeps,
  taskId: string,
): Promise<T3TaskRunLiveResponse> {
  const existingRun = await deps.store.getAgentRunByTaskId(taskId);
  if (!existingRun) {
    throw new NotFoundError("task", taskId);
  }
  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  await mcpClient.interruptThread(existingRun.threadId);

  const updatedRun =
    (await deps.store.updateAgentRunState(taskId, { state: "stopped", now })) ?? existingRun;
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
  }
  return {
    run: updatedRun,
    pendingQuestions: [],
  };
}

export async function respondToTaskT3Request(
  deps: T3ServiceDeps,
  taskId: string,
  input: {
    requestId: string;
    answers: Record<string, string | string[]>;
  },
): Promise<T3TaskRunLiveResponse> {
  const existingRun = await deps.store.getAgentRunByTaskId(taskId);
  if (!existingRun) {
    throw new NotFoundError("task", taskId);
  }
  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  await mcpClient.respondToPendingRequest({
    threadId: existingRun.threadId,
    requestId: input.requestId,
    answers: input.answers,
  });

  const updatedRun =
    (await deps.store.updateAgentRunState(taskId, { state: "working", now })) ?? existingRun;
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
  }
  return {
    run: updatedRun,
    pendingQuestions: [],
  };
}

async function capabilitiesCacheKey(connection: { mcpUrl: string; connectedAt: number }): Promise<Request> {
  // Hash so the cache key carries no T3 host details; a reconnect (new connectedAt) starts a new entry.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${connection.mcpUrl}\n${String(connection.connectedAt)}`),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`${T3_CAPABILITIES_CACHE_ORIGIN}/${hex}`);
}

/**
 * Lists the models the connected T3 host offers (`orchestrator_capabilities`), reusing the list for
 * `T3_CAPABILITIES_CACHE_TTL_SECONDS` through the Workers Cache API when a cache is given. A cache
 * failure only costs a fresh call to T3; it never fails the request.
 */
export async function listT3ModelCapabilities(
  deps: Pick<T3ServiceDeps, "store" | "encryptionKey" | "fetchFn">,
  cache: Cache | undefined,
): Promise<T3ModelCapability[]> {
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
  });
  const connection = await deps.store.getConnection();
  const cacheKey = cache && connection ? await capabilitiesCacheKey(connection) : undefined;

  if (cache && cacheKey) {
    const cached = await cache.match(cacheKey).catch((err: unknown) => {
      console.warn("reading cached T3 capabilities failed", err);
      return undefined;
    });
    if (cached) {
      const body: unknown = await cached.json();
      if (Array.isArray(body)) {
        return body as T3ModelCapability[];
      }
    }
  }

  const capabilities = await mcpClient.listModelCapabilities();

  if (cache && cacheKey) {
    const response = Response.json(capabilities, {
      headers: { "Cache-Control": `max-age=${String(T3_CAPABILITIES_CACHE_TTL_SECONDS)}` },
    });
    await cache.put(cacheKey, response).catch((err: unknown) => {
      console.warn("caching T3 capabilities failed", err);
    });
  }
  return capabilities;
}

/** Author of the comment Bitig records when a thread switches models. */
export const T3_MODEL_SWITCH_COMMENT_AUTHOR = "bitig";

export interface ReplyToTaskT3RunInput {
  body: string;
  author?: string | undefined;
  modelSelection?: T3ModelSelection | undefined;
  actor: string;
}

export interface ReplyToTaskT3RunResult {
  comment: Comment;
  /** The "Model switched from X to Y" comment, when the reply switched the thread's model. */
  switchComment?: Comment | undefined;
  run: AgentRun;
}

/**
 * A person's reply to a task's T3 thread (#BIT-119). When `modelSelection` differs from the thread's
 * current model, the thread must be waiting or past its turn (see `canSwitchT3Model`); it is switched
 * with `t3_thread_configure` and the switch is recorded on the run and as an agent comment. The reply
 * is then saved as a comment and sent with `t3_thread_send`, prefixed after a switch with a line
 * asking the new model to restore context from the task's checkpoint.
 *
 * Throws `T3ModelSwitchConflictError` before anything is saved when the switch is not allowed. If
 * T3 fails after the switch, the comments stay saved and the error reaches the caller.
 */
export async function replyToTaskT3Run(
  deps: T3ServiceDeps,
  taskRef: string,
  input: ReplyToTaskT3RunInput,
): Promise<ReplyToTaskT3RunResult> {
  const taskId = await resolveTaskRef(deps.storage, taskRef);
  const task = await deps.storage.getTask(taskId);
  if (!task) {
    throw new NotFoundError("task", taskId);
  }
  const existingRun = await deps.store.getAgentRunByTaskId(task.id);
  if (!existingRun) {
    makeValidationIssue("taskId", "This task has no T3 thread. Start it in T3 first.");
  }

  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  let run = existingRun;
  let switchedTo: string | undefined;
  let switchComment: Comment | undefined;
  if (input.modelSelection) {
    const selection = input.modelSelection;
    const current = await mcpClient.readThreadModel(existingRun.threadId);
    const known: T3ModelSelection | undefined =
      current ??
      (existingRun.model && existingRun.providerInstanceId
        ? {
            providerInstanceId: existingRun.providerInstanceId,
            model: existingRun.model,
            ...(existingRun.modelOptions ? { options: existingRun.modelOptions } : {}),
          }
        : undefined);

    if (!known || !isSameT3ModelSelection(known, selection)) {
      const live = await mcpClient.readThreadLiveStatus(existingRun.threadId);
      const liveState = deriveLiveAgentRunState({
        thread: live.thread,
        recentRuns: live.recentRuns,
        pendingRequestIds: live.pendingRequestIds,
      });
      // A pending request keeps a run id open while the thread waits on a person, so only an
      // active run outside the waiting state counts as mid-turn.
      const midTurn = Boolean(live.thread?.activeRunId) && liveState !== "waiting_for_approval";
      if (!canSwitchT3Model(liveState) || midTurn) {
        throw new T3ModelSwitchConflictError(midTurn ? "working" : liveState);
      }

      await mcpClient.configureThreadModel(existingRun.threadId, selection);
      run = (await deps.store.updateAgentRunModel(task.id, { selection, now })) ?? existingRun;

      const fromLabel = formatT3ModelSelection(
        known ?? { ...(existingRun.model ? { model: existingRun.model } : {}) },
      );
      switchedTo = formatT3ModelSelection(selection);
      switchComment = await deps.storage.addComment(
        {
          taskId: task.id,
          body: buildT3ModelSwitchComment(fromLabel, switchedTo),
          authorType: "agent",
          author: T3_MODEL_SWITCH_COMMENT_AUTHOR,
        },
        { actor: input.actor },
      );
    }
  }

  const comment = await deps.storage.addComment(
    {
      taskId: task.id,
      body: input.body,
      authorType: "human",
      ...(input.author ? { author: input.author } : {}),
    },
    { actor: input.actor },
  );

  const project = await deps.storage.getProject(task.projectId);
  const taskLabel = taskCode(task, project ?? undefined) ?? `"${task.title}"`;
  const replyPrompt = buildT3CommentPrompt({
    taskLabel,
    author: comment.author ?? DEFAULT_COMMENT_AUTHOR_LABEL,
    body: comment.body,
  });
  const prompt = switchedTo ? `${buildT3ModelSwitchNotice(taskLabel, switchedTo)}\n\n${replyPrompt}` : replyPrompt;

  const sent = await sendPromptToT3Run(deps, run, prompt);
  return {
    comment,
    ...(switchComment ? { switchComment } : {}),
    run: sent.run ?? run,
  };
}
