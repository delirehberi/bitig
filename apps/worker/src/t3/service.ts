import {
  NotFoundError,
  ValidationError,
  buildT3LaunchPrompt,
  checkStatusChange,
  computeT3ConnectionStatus,
  defaultIdGenerator,
  deriveLiveAgentRunState,
  resolveTaskRef,
  taskCode,
  type AgentRun,
  type AgentRunState,
  type Comment,
  type RealtimeEvent,
  type StorageProvider,
  type T3ConnectionStatus,
  type T3TaskRunLiveResponse,
  type T3WorkspaceStrategy,
  type Task,
} from "@bitig/core";
import type { T3D1Store } from "@bitig/storage-d1";
import { T3McpClient, T3McpError } from "./client";
import { decryptT3Token } from "./crypto";

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
