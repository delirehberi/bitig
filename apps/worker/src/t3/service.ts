import {
  DEFAULT_PROJECT_T3_WORKSPACE_STRATEGY,
  NotFoundError,
  PROJECT_T3_MESSAGES_PAGE_LIMIT,
  PROJECT_T3_MESSAGE_MAX_CHARS,
  T3WorkspaceBusyError,
  ValidationError,
  buildProjectT3LaunchPrompt,
  buildProjectT3ModelSwitchNotice,
  buildProjectT3ThreadTitle,
  buildT3LaunchPrompt,
  buildT3ModelSwitchComment,
  buildT3ModelSwitchNotice,
  buildT3SubagentCompletedComment,
  buildT3SubagentCompletedPrompt,
  buildT3SubagentEndedComment,
  buildT3SubagentEndedPrompt,
  buildT3SubagentStartedComment,
  canSwitchT3Model,
  checkStatusChange,
  computeT3ConnectionStatus,
  defaultIdGenerator,
  deriveLiveAgentRunState,
  formatT3ModelSelection,
  isActiveAgentRunState,
  isSameT3ModelSelection,
  resolveTaskRef,
  taskCode,
  type ActiveAgentRunState,
  type AgentRun,
  type AgentRunState,
  type Checkpoint,
  type Comment,
  type Project,
  type ProjectT3Thread,
  type ProjectT3ThreadMessagesResponse,
  type ProjectT3ThreadsResponse,
  type RealtimeEvent,
  type StorageProvider,
  type T3ConnectionStatus,
  type T3ModelCapability,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3ProjectActiveSession,
  type T3RunsLiveResponse,
  type T3SubagentHandbackInput,
  type T3TaskRunLiveResponse,
  type T3ThreadListItem,
  type T3WorkspaceBusySession,
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
  /**
   * The umbrella task whose session starts this task as a child session (#BIT-141), as an ID or
   * ticket code. Its run then waits (`waiting_subagent`) until this task is done.
   */
  parentTaskRef?: string | undefined;
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
 *
 * With `parentTaskRef` (#BIT-141), the task starts as a child session of an umbrella task: a
 * dependency on that umbrella task does not block it, the child run records the umbrella task,
 * and the umbrella task's run moves to `waiting_subagent` until the child task is done.
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

  const parent = options.parentTaskRef ? await requireUmbrellaParent(deps, task, options.parentTaskRef) : undefined;

  // Enforce pendingApproval and unfinished dependency gates (same rules as an agent moving to in_progress).
  // The umbrella task is in progress while it delegates, so a dependency on it does not block its child.
  await checkStatusChange(deps.storage, task.id, "in_progress", "startT3Thread", {
    requireApproval: true,
    ...(parent ? { dependsOn: (task.dependsOn ?? []).filter((id) => id !== parent.task.id) } : {}),
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

  const workspaceStrategy: T3WorkspaceStrategy = options.workspaceStrategy ?? "worktree";
  if (workspaceStrategy === "root") {
    // The umbrella session ends its turn and waits while its child works, so it never collides with it.
    await assertRootWorkspaceFree(deps, mcpClient, mapping.t3ProjectId, now, parent?.task.id);
  }

  const comments = await deps.storage.getComments(task.id);
  const code = taskCode(task, project);
  const builtPrompt = buildT3LaunchPrompt({
    task,
    ...(code ? { taskCode: code } : {}),
    projectName: project.name,
    comments,
    ...(parent ? { parentTaskCode: parent.label } : {}),
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
    ...(parent ? { parentTaskId: parent.task.id } : {}),
    startedBy: actor,
    startedAt: now,
    updatedAt: now,
  });

  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run }).catch(() => undefined);
  }

  if (parent) {
    const waitingRun = await deps.store.setAgentRunWaitingFor(parent.task.id, { childTaskId: task.id, now });
    if (waitingRun && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: waitingRun }).catch(() => undefined);
    }
    await deps.storage.addComment(
      {
        taskId: parent.task.id,
        body: buildT3SubagentStartedComment({
          childLabel: code ?? task.id,
          childTitle: task.title,
          link: run.link,
        }),
        authorType: "agent",
        author: T3_BITIG_COMMENT_AUTHOR,
      },
      { actor },
    );
  }

  return {
    run,
    task: updatedTask,
    ...(code ? { code } : {}),
  };
}

/** Author of the comments Bitig itself records on tasks (model switches, child sessions). */
export const T3_BITIG_COMMENT_AUTHOR = "bitig";

/** Task statuses after which a child task no longer keeps its umbrella session waiting (#BIT-141). */
const FINISHED_TASK_STATUSES: ReadonlySet<Task["status"]> = new Set<Task["status"]>(["done", "archived"]);

/** Child run states that end the umbrella session's wait without the child task being done (#BIT-141). */
const ENDED_CHILD_RUN_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["failed", "stopped"]);

interface UmbrellaParent {
  readonly task: Task;
  readonly run: AgentRun;
  /** Ticket code, or ID when the task has none. */
  readonly label: string;
}

async function labelTask(storage: StorageProvider, task: Task): Promise<string> {
  const project = await storage.getProject(task.projectId);
  return taskCode(task, project ?? undefined) ?? task.id;
}

/**
 * Resolves the umbrella task a child session is started from (#BIT-141). Refused when it is the
 * task itself, has no T3 session to resume, already waits on another unfinished child task, or
 * when the child already has an active session of its own.
 */
async function requireUmbrellaParent(deps: T3ServiceDeps, child: Task, parentRef: string): Promise<UmbrellaParent> {
  const parentId = await resolveTaskRef(deps.storage, parentRef);
  const parentTask = await deps.storage.getTask(parentId);
  if (!parentTask) {
    throw new NotFoundError("task", parentId);
  }
  if (parentTask.id === child.id) {
    makeValidationIssue("parentTaskId", "A task cannot be its own umbrella task.");
  }
  const label = await labelTask(deps.storage, parentTask);
  const run = await deps.store.getAgentRunByTaskId(parentTask.id);
  if (!run) {
    makeValidationIssue(
      "parentTaskId",
      `Umbrella task ${label} has no T3 session, so Bitig cannot resume it when the child task is done. Start ${label} in T3 first.`,
    );
  }
  if (run.waitingForTaskId && run.waitingForTaskId !== child.id) {
    const waitedOn = await deps.storage.getTask(run.waitingForTaskId);
    if (waitedOn && !FINISHED_TASK_STATUSES.has(waitedOn.status)) {
      makeValidationIssue(
        "parentTaskId",
        `Umbrella task ${label} already waits on ${await labelTask(deps.storage, waitedOn)}. Start one child task at a time.`,
      );
    }
  }
  const childRun = await deps.store.getAgentRunByTaskId(child.id);
  if (childRun && isActiveAgentRunState(childRun.state)) {
    makeValidationIssue(
      "taskId",
      `This task already has an active T3 session (${childRun.state.replaceAll("_", " ")}). Wait for it instead of starting another one.`,
    );
  }
  return { task: parentTask, run, label };
}

/** Most threads `t3_thread_list` returns for one T3 project when the root-workspace guard checks it. */
const ROOT_WORKSPACE_THREAD_LIST_LIMIT = 100;

/**
 * Refuses a root-workspace launch while another task's T3 session is active in the same T3
 * project's root checkout (#BIT-134). Only runs Bitig recorded with `workspaceStrategy: "root"`
 * count: isolated worktrees never collide, project-level threads do not edit the codebase, and
 * threads started outside Bitig (or before the strategy was stored) have no known workspace.
 *
 * Stored run states can be stale, so each candidate is re-checked against T3 and the result is
 * saved like `listT3RunsLive` does. A run whose thread T3 cannot read is saved as `offline`
 * (as `getTaskT3RunLiveStatus` does), so a deleted thread cannot block launches forever.
 */
async function assertRootWorkspaceFree(
  deps: T3ServiceDeps,
  mcpClient: T3McpClient,
  t3ProjectId: string,
  now: number,
  ignoredTaskId?: string,
): Promise<void> {
  const candidates = (await deps.store.listAgentRuns()).filter(
    (run) =>
      run.t3ProjectId === t3ProjectId &&
      run.workspaceStrategy === "root" &&
      run.taskId !== ignoredTaskId &&
      isActiveAgentRunState(run.state),
  );
  if (candidates.length === 0) {
    return;
  }

  // A T3McpError here propagates: the host is unreachable, so the launch could not succeed either.
  const listed = await mcpClient.listThreads({
    allProjects: false,
    projectId: t3ProjectId,
    includeSubagents: false,
    limit: ROOT_WORKSPACE_THREAD_LIST_LIMIT,
  });
  const listedById = new Map(listed.map((thread) => [thread.threadId, thread]));

  for (const run of candidates) {
    const listedThread = listedById.get(run.threadId);
    let liveState: AgentRunState;
    if (listedThread) {
      liveState = deriveLiveAgentRunState({
        threadStatus: listedThread.status,
        pendingRequestCount: listedThread.pendingRequestCount,
        activeRunId: listedThread.activeRunId,
        settled: listedThread.settled,
      });
    } else {
      try {
        const live = await mcpClient.readThreadLiveStatus(run.threadId);
        liveState = deriveLiveAgentRunState({
          thread: live.thread,
          recentRuns: live.recentRuns,
          pendingRequestIds: live.pendingRequestIds,
        });
      } catch (err) {
        if (!(err instanceof T3McpError)) {
          throw err;
        }
        liveState = "offline";
      }
    }
    liveState = await resolveUmbrellaRunState(deps, run, liveState);

    if (liveState !== run.state) {
      const updatedRun = await deps.store.updateAgentRunState(run.taskId, { state: liveState, now });
      if (updatedRun && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
      }
      if (updatedRun) {
        await afterRunStateChange(deps, run, updatedRun);
      }
    }

    if (isActiveAgentRunState(liveState)) {
      throw new T3WorkspaceBusyError(await describeBusyRun(deps.storage, run, liveState));
    }
  }
}

async function describeBusyRun(
  storage: StorageProvider,
  run: AgentRun,
  state: ActiveAgentRunState,
): Promise<T3WorkspaceBusySession> {
  const busyTask = await storage.getTask(run.taskId);
  const busyProject = (busyTask ? await storage.getProject(busyTask.projectId) : null) ?? undefined;
  const busyCode = busyTask ? taskCode(busyTask, busyProject) : undefined;
  return {
    threadId: run.threadId,
    state,
    taskId: run.taskId,
    ...(busyCode ? { taskCode: busyCode } : {}),
    ...(busyTask ? { title: busyTask.title } : {}),
    ...(run.link ? { link: run.link } : {}),
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
    const nextState = await resolveUmbrellaRunState(
      deps,
      existingRun,
      deriveLiveAgentRunState({
        thread: live.thread,
        recentRuns: live.recentRuns,
        pendingRequestIds: live.pendingRequestIds,
      }),
    );

    const updatedRun =
      nextState === existingRun.state
        ? existingRun
        : ((await deps.store.updateAgentRunState(taskId, { state: nextState, now })) ?? existingRun);

    if (updatedRun.state !== existingRun.state && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
    }
    await afterRunStateChange(deps, existingRun, updatedRun, live.stopReason);

    return {
      run: updatedRun,
      ...(live.pendingRequestId ? { pendingRequestId: live.pendingRequestId } : {}),
      pendingQuestions: live.pendingQuestions,
      ...(live.stopReason ? { stopReason: live.stopReason } : {}),
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

/**
 * Syncs and lists T3 agent runs and active project sessions (#BIT-126).
 * Uses `t3_thread_list` when a T3 host is connected so runs that finished or entered waiting state
 * on the T3 host are reconciled in D1 without opening each task modal individually.
 */
export async function listT3RunsLive(deps: T3ServiceDeps): Promise<T3RunsLiveResponse> {
  const [existingRuns, mappings, projectThreads] = await Promise.all([
    deps.store.listAgentRuns(),
    deps.store.listProjectMappings(),
    deps.store.listProjectThreads(),
  ]);
  const projectThreadsById = new Map(projectThreads.map((t) => [t.threadId, t]));
  if (existingRuns.length === 0 && mappings.length === 0) {
    return { runs: [], activeSessions: [] };
  }

  const projectIdByT3ProjectId = new Map(mappings.map((m) => [m.t3ProjectId, m.projectId]));
  const now = deps.now ? deps.now() : Date.now();

  let mcpClient: T3McpClient | undefined;
  try {
    mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      fetchFn: deps.fetchFn,
      now,
    });
  } catch {
    mcpClient = undefined;
  }

  let threads: T3ThreadListItem[] = [];
  let hostReachable = false;
  if (mcpClient) {
    try {
      threads = await mcpClient.listThreads({
        allProjects: true,
        includeSubagents: false,
        limit: 100,
      });
      hostReachable = true;
    } catch (err) {
      if (!(err instanceof T3McpError)) {
        throw err;
      }
      hostReachable = false;
    }
  }

  const threadsById = new Map(threads.map((t) => [t.threadId, t]));
  const reconciledById = new Map<string, AgentRun>();
  const runs: AgentRun[] = [];
  const pushRun = (run: AgentRun, existingRun: AgentRun): void => {
    reconciledById.set(existingRun.id, run);
  };

  // Umbrella runs waiting on a child task go last, so they see their child's reconciled state (#BIT-141).
  const reconcileOrder = [
    ...existingRuns.filter((run) => !run.waitingForTaskId),
    ...existingRuns.filter((run) => run.waitingForTaskId),
  ];
  for (const existingRun of reconcileOrder) {
    if (!hostReachable || !mcpClient) {
      pushRun(existingRun, existingRun);
      continue;
    }

    const listedThread = threadsById.get(existingRun.threadId);
    if (listedThread) {
      const nextState = await resolveUmbrellaRunState(
        deps,
        existingRun,
        deriveLiveAgentRunState({
          threadStatus: listedThread.status,
          pendingRequestCount: listedThread.pendingRequestCount,
          activeRunId: listedThread.activeRunId,
          settled: listedThread.settled,
        }),
      );
      const nextLink = listedThread.link ?? existingRun.link;
      const updatedRun =
        nextState === existingRun.state && nextLink === existingRun.link
          ? existingRun
          : ((await deps.store.updateAgentRunState(existingRun.taskId, {
              state: nextState,
              ...(nextLink ? { link: nextLink } : {}),
              now,
            })) ?? existingRun);
      if (updatedRun.state !== existingRun.state && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
      }
      await afterRunStateChange(deps, existingRun, updatedRun);
      pushRun(updatedRun, existingRun);
    } else if (isActiveAgentRunState(existingRun.state)) {
      try {
        const live = await mcpClient.readThreadLiveStatus(existingRun.threadId);
        const nextState = await resolveUmbrellaRunState(
          deps,
          existingRun,
          deriveLiveAgentRunState({
            thread: live.thread,
            recentRuns: live.recentRuns,
            pendingRequestIds: live.pendingRequestIds,
          }),
        );
        const updatedRun =
          nextState === existingRun.state
            ? existingRun
            : ((await deps.store.updateAgentRunState(existingRun.taskId, { state: nextState, now })) ?? existingRun);
        if (updatedRun.state !== existingRun.state && deps.publishRealtime) {
          await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
        }
        await afterRunStateChange(deps, existingRun, updatedRun, live.stopReason);
        pushRun(updatedRun, existingRun);
      } catch (err) {
        if (err instanceof T3McpError) {
          pushRun(existingRun, existingRun);
        } else {
          throw err;
        }
      }
    } else {
      pushRun(existingRun, existingRun);
    }
  }
  for (const existingRun of existingRuns) {
    runs.push(reconciledById.get(existingRun.id) ?? existingRun);
  }

  const tasks = await deps.storage.getTasks();
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const activeSessions: T3ProjectActiveSession[] = [];
  const seenThreadIds = new Set<string>();

  for (const run of runs) {
    if (!isActiveAgentRunState(run.state)) {
      continue;
    }
    const task = tasksById.get(run.taskId);
    const projectId = task?.projectId ?? projectIdByT3ProjectId.get(run.t3ProjectId);
    if (!projectId) {
      continue;
    }
    const listedThread = threadsById.get(run.threadId);
    seenThreadIds.add(run.threadId);
    activeSessions.push({
      threadId: run.threadId,
      projectId,
      t3ProjectId: run.t3ProjectId,
      state: run.state,
      taskId: run.taskId,
      ...(task?.title ? { title: task.title } : listedThread?.title ? { title: listedThread.title } : {}),
      ...(run.link ? { link: run.link } : {}),
      ...(run.model ? { model: run.model } : listedThread?.model ? { model: listedThread.model } : {}),
      updatedAt: listedThread?.updatedAt ?? run.updatedAt,
      ...(run.state === "waiting_subagent" && run.waitingForTaskId ? { waitingForTaskId: run.waitingForTaskId } : {}),
    });
  }

  for (const thread of threads) {
    if (seenThreadIds.has(thread.threadId) || !thread.projectId) {
      continue;
    }
    const projectId = projectIdByT3ProjectId.get(thread.projectId);
    if (!projectId) {
      continue;
    }
    const state = deriveLiveAgentRunState({
      threadStatus: thread.status,
      pendingRequestCount: thread.pendingRequestCount,
      activeRunId: thread.activeRunId,
      settled: thread.settled,
    });
    if (!isActiveAgentRunState(state)) {
      continue;
    }
    seenThreadIds.add(thread.threadId);
    // Project-level threads Bitig started (#BIT-127) keep their stored title and model when T3 omits them.
    const projectThread = projectThreadsById.get(thread.threadId);
    const title = thread.title ?? projectThread?.title;
    const model = thread.model ?? projectThread?.model;
    activeSessions.push({
      threadId: thread.threadId,
      projectId,
      t3ProjectId: thread.projectId,
      state,
      ...(title ? { title } : {}),
      ...(thread.link ? { link: thread.link } : {}),
      ...(model ? { model } : {}),
      ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    });
  }

  return {
    runs,
    activeSessions,
  };
}

/** The child's latest checkpoint: checkpoints are ordered by step index, so the last is the latest step. */
async function latestCheckpoint(storage: StorageProvider, taskId: string): Promise<Checkpoint | undefined> {
  return (await storage.getCheckpoints(taskId)).at(-1);
}

/** Collects the child task's completion context for its umbrella session (#BIT-141). */
async function buildHandbackInput(
  deps: T3ServiceDeps,
  parentTask: Task,
  child: Task,
): Promise<T3SubagentHandbackInput> {
  const [parentLabel, childLabel, checkpoint, comments] = await Promise.all([
    labelTask(deps.storage, parentTask),
    labelTask(deps.storage, child),
    latestCheckpoint(deps.storage, child.id),
    deps.storage.getComments(child.id),
  ]);
  // The child agent's final report; Bitig's own notes (e.g. model switches) are not a report.
  const finalComment = comments.findLast(
    (comment) => comment.authorType === "agent" && comment.author !== T3_BITIG_COMMENT_AUTHOR,
  );
  return {
    parentLabel,
    childLabel,
    child,
    ...(checkpoint ? { checkpoint } : {}),
    ...(finalComment ? { finalComment } : {}),
  };
}

interface UmbrellaHandbackMessage {
  readonly comment: string;
  readonly prompt: string;
}

async function publishRun(deps: T3ServiceDeps, run: AgentRun | undefined): Promise<void> {
  if (run && deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run }).catch(() => undefined);
  }
}

/**
 * Ends an umbrella session's wait on `child` and resumes its thread with `buildMessage`'s prompt,
 * then records the comment on the umbrella task (#BIT-141). The wait is claimed first, so a
 * concurrent handback for the same child does nothing. When T3 cannot be reached, the wait is
 * restored (a later live-status check retries) and the error is rethrown with context. An umbrella
 * task that is already done or archived only drops the wait. Resolves to the updated umbrella run,
 * or `undefined` when another caller already handed the child back.
 */
async function resumeUmbrellaSession(
  deps: T3ServiceDeps,
  parentRun: AgentRun,
  child: Task,
  buildMessage: (input: T3SubagentHandbackInput) => UmbrellaHandbackMessage,
): Promise<AgentRun | undefined> {
  const now = deps.now ? deps.now() : Date.now();
  const parentTask = await deps.storage.getTask(parentRun.taskId);
  if (!parentTask || FINISHED_TASK_STATUSES.has(parentTask.status)) {
    const dropped = await deps.store.claimAgentRunWaitingFor(parentRun.taskId, child.id, { state: "finished", now });
    await publishRun(deps, dropped);
    return dropped;
  }

  const input = await buildHandbackInput(deps, parentTask, child);
  const message = buildMessage(input);
  const claimed = await deps.store.claimAgentRunWaitingFor(parentRun.taskId, child.id, { state: "working", now });
  if (!claimed) {
    return undefined;
  }

  try {
    const mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      fetchFn: deps.fetchFn,
      now,
    });
    await mcpClient.sendThreadMessage({ threadId: claimed.threadId, prompt: message.prompt });
  } catch (err) {
    const restored = await deps.store.setAgentRunWaitingFor(parentRun.taskId, { childTaskId: child.id, now });
    await publishRun(deps, restored);
    throw new Error(`resuming the T3 session of ${input.parentLabel} after ${input.childLabel}`, { cause: err });
  }

  await publishRun(deps, claimed);
  await deps.storage.addComment(
    { taskId: parentTask.id, body: message.comment, authorType: "agent", author: T3_BITIG_COMMENT_AUTHOR },
    { actor: T3_BITIG_COMMENT_AUTHOR },
  );
  return claimed;
}

/**
 * Hands a finished child task back to the umbrella sessions waiting on it (#BIT-141): records the
 * child's status, checklist, latest checkpoint and final agent comment on the umbrella task, sends
 * them to its T3 thread, and moves its run back to `working`. Called when a task moves to `done`
 * (or `archived`) over MCP or HTTP. Resolves to how many umbrella sessions were resumed; it is a
 * no-op when T3 is not configured, nothing waits on the task, or the task is not finished.
 */
export async function handBackCompletedChildTask(deps: T3ServiceDeps, childTaskId: string): Promise<number> {
  if (!deps.encryptionKey) return 0;
  const waiting = await deps.store.listAgentRunsWaitingFor(childTaskId);
  if (waiting.length === 0) return 0;
  const child = await deps.storage.getTask(childTaskId);
  if (!child || !FINISHED_TASK_STATUSES.has(child.status)) return 0;

  let resumed = 0;
  for (const parentRun of waiting) {
    const run = await resumeUmbrellaSession(deps, parentRun, child, (input) => ({
      comment: buildT3SubagentCompletedComment(input),
      prompt: buildT3SubagentCompletedPrompt(input),
    }));
    if (run?.state === "working") resumed += 1;
  }
  return resumed;
}

/**
 * Tells the umbrella sessions waiting on a child task that the child's session failed or stopped
 * before the task was done (#BIT-141), so they do not wait forever. A child task that is finished
 * after all is handed back as completed instead.
 */
async function handBackEndedChildRun(
  deps: T3ServiceDeps,
  childRun: AgentRun,
  stopReason?: string | undefined,
): Promise<number> {
  const state = childRun.state === "failed" || childRun.state === "stopped" ? childRun.state : undefined;
  if (!state || !deps.encryptionKey) return 0;
  const waiting = await deps.store.listAgentRunsWaitingFor(childRun.taskId);
  if (waiting.length === 0) return 0;
  const child = await deps.storage.getTask(childRun.taskId);
  if (!child) return 0;
  if (FINISHED_TASK_STATUSES.has(child.status)) {
    return handBackCompletedChildTask(deps, child.id);
  }

  let resumed = 0;
  for (const parentRun of waiting) {
    const run = await resumeUmbrellaSession(deps, parentRun, child, (input) => {
      const ended = { ...input, state, ...(stopReason ? { stopReason } : {}) };
      return { comment: buildT3SubagentEndedComment(ended), prompt: buildT3SubagentEndedPrompt(ended) };
    });
    if (run?.state === "working") resumed += 1;
  }
  return resumed;
}

/**
 * Runs after a run's stored state changed: when a child session just failed or stopped, its
 * umbrella session is told (#BIT-141). A failed handback is logged, never thrown, so reading live
 * status or stopping a thread does not fail because of the umbrella task.
 */
async function afterRunStateChange(
  deps: T3ServiceDeps,
  previous: AgentRun,
  updated: AgentRun,
  stopReason?: string | undefined,
): Promise<void> {
  if (updated.state === previous.state || !ENDED_CHILD_RUN_STATES.has(updated.state)) return;
  try {
    await handBackEndedChildRun(deps, updated, stopReason);
  } catch (error) {
    console.error("handing an ended child T3 session back to its umbrella task failed", {
      taskId: updated.taskId,
      state: updated.state,
      error,
    });
  }
}

/**
 * The state to store for a run whose thread T3 reports as `liveState` (#BIT-141). An umbrella
 * session that waits on a child task is idle on T3 (`finished`), but stays `waiting_subagent` while
 * the child task is in progress with an active session. When the child task is already finished,
 * or its session failed or stopped, the umbrella session is handed the child's context instead:
 * this also retries a handback that failed earlier because T3 could not be reached.
 */
async function resolveUmbrellaRunState(
  deps: T3ServiceDeps,
  run: AgentRun,
  liveState: AgentRunState,
): Promise<AgentRunState> {
  const childId = run.waitingForTaskId;
  if (!childId || liveState !== "finished") return liveState;

  const child = await deps.storage.getTask(childId);
  if (!child) return liveState;
  const childRun = await deps.store.getAgentRunByTaskId(child.id);
  const childFinished = FINISHED_TASK_STATUSES.has(child.status);
  if (!childFinished && !(childRun && ENDED_CHILD_RUN_STATES.has(childRun.state))) {
    return child.status === "in_progress" && childRun && isActiveAgentRunState(childRun.state)
      ? "waiting_subagent"
      : liveState;
  }

  try {
    if (childFinished) {
      await handBackCompletedChildTask(deps, child.id);
    } else if (childRun) {
      await handBackEndedChildRun(deps, childRun);
    }
  } catch (error) {
    console.error("handing a child task back to its umbrella T3 session failed", {
      taskId: run.taskId,
      childTaskId: child.id,
      error,
    });
  }
  // The handback stored the umbrella run's new state (working, or waiting again after a failure).
  return (await deps.store.getAgentRunByTaskId(run.taskId))?.state ?? liveState;
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

  // A person stopping an umbrella session also ends its wait on a child task (#BIT-141).
  const updatedRun =
    (existingRun.waitingForTaskId
      ? await deps.store.claimAgentRunWaitingFor(taskId, existingRun.waitingForTaskId, { state: "stopped", now })
      : undefined) ??
    (await deps.store.updateAgentRunState(taskId, { state: "stopped", now })) ??
    existingRun;
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
  }
  await afterRunStateChange(deps, existingRun, updatedRun);
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

/** The model a thread was last recorded with, as a full selection when both model and provider are known. */
function storedT3ModelSelection(stored: {
  readonly model?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly modelOptions?: readonly T3ModelSelectionOption[] | undefined;
}): T3ModelSelection | undefined {
  if (!stored.model || !stored.providerInstanceId) return undefined;
  return {
    providerInstanceId: stored.providerInstanceId,
    model: stored.model,
    ...(stored.modelOptions ? { options: stored.modelOptions.map((opt) => ({ ...opt })) } : {}),
  };
}

/**
 * Switches a thread to `selection` when it runs a different model (#BIT-119), shared by task replies
 * and project-level follow-ups (#BIT-127). The thread must be waiting or past its turn (see
 * `canSwitchT3Model`); otherwise `T3ModelSwitchConflictError` is thrown before anything changes.
 * Resolves to the from/to labels after a switch, or `undefined` when the model already matches.
 */
async function switchT3ThreadModel(
  mcpClient: T3McpClient,
  threadId: string,
  stored: {
    readonly model?: string | undefined;
    readonly providerInstanceId?: string | undefined;
    readonly modelOptions?: readonly T3ModelSelectionOption[] | undefined;
  },
  selection: T3ModelSelection,
): Promise<{ from: string; to: string } | undefined> {
  const current = await mcpClient.readThreadModel(threadId);
  const known = current ?? storedT3ModelSelection(stored);
  if (known && isSameT3ModelSelection(known, selection)) {
    return undefined;
  }

  const live = await mcpClient.readThreadLiveStatus(threadId);
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

  await mcpClient.configureThreadModel(threadId, selection);
  return {
    from: formatT3ModelSelection(known ?? { ...(stored.model ? { model: stored.model } : {}) }),
    to: formatT3ModelSelection(selection),
  };
}

/** Author of the comment Bitig records when a thread switches models. */
export const T3_MODEL_SWITCH_COMMENT_AUTHOR = T3_BITIG_COMMENT_AUTHOR;

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
    const switched = await switchT3ThreadModel(mcpClient, existingRun.threadId, existingRun, selection);
    if (switched) {
      run = (await deps.store.updateAgentRunModel(task.id, { selection, now })) ?? existingRun;
      switchedTo = switched.to;
      switchComment = await deps.storage.addComment(
        {
          taskId: task.id,
          body: buildT3ModelSwitchComment(switched.from, switched.to),
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

/** Project-level thread states that `t3_thread_list` reconciliation turns offline when T3 is unreachable. */
function toOfflineIfActive(thread: ProjectT3Thread): AgentRunState {
  return isActiveAgentRunState(thread.state) ? "offline" : thread.state;
}

async function requireProject(storage: StorageProvider, projectId: string): Promise<Project> {
  const project = await storage.getProject(projectId);
  if (!project) {
    throw new NotFoundError("project", projectId);
  }
  return project;
}

export interface LaunchProjectThreadInT3Options {
  projectId: string;
  prompt: string;
  workspaceStrategy?: T3WorkspaceStrategy | undefined;
  modelSelection?: T3ModelSelection | undefined;
  actor?: string | undefined;
}

/**
 * Starts a T3 thread for a Bitig project without a task (#BIT-127), e.g. to check the environment.
 * Refused when the project is archived, is not mapped to a T3 project, or no valid T3 connection exists.
 * The thread runs in the project root unless `workspaceStrategy` says otherwise.
 */
export async function launchProjectThreadInT3(
  deps: T3ServiceDeps,
  options: LaunchProjectThreadInT3Options,
): Promise<ProjectT3Thread> {
  const now = deps.now ? deps.now() : Date.now();
  const project = await requireProject(deps.storage, options.projectId);
  if (project.archived) {
    makeValidationIssue("projectId", `Project "${project.name}" is archived. Restore it before messaging T3.`);
  }

  const mapping = await deps.store.getProjectMapping(project.id);
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

  // The record ID doubles as T3's idempotency key, so a retried request cannot start a second thread.
  const id = defaultIdGenerator();
  const workspaceStrategy = options.workspaceStrategy ?? DEFAULT_PROJECT_T3_WORKSPACE_STRATEGY;
  const title = buildProjectT3ThreadTitle(options.prompt);
  const selection = options.modelSelection;
  const launched = await mcpClient.launchThread({
    projectId: mapping.t3ProjectId,
    title,
    prompt: buildProjectT3LaunchPrompt({ project, prompt: options.prompt }),
    clientRequestId: id,
    workspaceStrategy,
    providerInstanceId: selection?.providerInstanceId,
    model: selection?.model,
    options: selection?.options,
  });

  const actor = (options.actor?.trim() ?? "") || "t3";
  return deps.store.saveProjectThread({
    id,
    projectId: project.id,
    t3ProjectId: mapping.t3ProjectId,
    threadId: launched.threadId,
    title,
    link: launched.link,
    state: "working",
    selection,
    workspaceStrategy,
    startedBy: actor,
    startedAt: now,
    updatedAt: now,
  });
}

export interface SendProjectT3MessageOptions {
  body: string;
  modelSelection?: T3ModelSelection | undefined;
}

/**
 * Sends a follow-up to a project-level thread (#BIT-127). Only threads Bitig recorded for this
 * project can be messaged, so the endpoint cannot reach arbitrary T3 threads. With `modelSelection`,
 * the thread switches models first under the same rules as task replies (409 while mid-turn).
 */
export async function sendProjectT3Message(
  deps: T3ServiceDeps,
  projectId: string,
  threadId: string,
  options: SendProjectT3MessageOptions,
): Promise<ProjectT3Thread> {
  await requireProject(deps.storage, projectId);
  const existing = await deps.store.getProjectThread(projectId, threadId);
  if (!existing) {
    throw new NotFoundError("t3_thread", threadId);
  }

  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  let thread = existing;
  let switchedTo: string | undefined;
  if (options.modelSelection) {
    const selection = options.modelSelection;
    const switched = await switchT3ThreadModel(mcpClient, existing.threadId, existing, selection);
    if (switched) {
      thread = (await deps.store.updateProjectThreadModel(projectId, threadId, { selection, now })) ?? existing;
      switchedTo = switched.to;
    }
  }

  const body = options.body.trim();
  const prompt = switchedTo ? `${buildProjectT3ModelSwitchNotice(switchedTo)}\n\n${body}` : body;
  await mcpClient.sendThreadMessage({ threadId: existing.threadId, prompt });

  return (await deps.store.updateProjectThreadState(projectId, threadId, { state: "working", now })) ?? thread;
}

/**
 * Lists a project's Bitig-started threads (#BIT-127), newest first, reconciling their state with
 * `t3_thread_list`. When T3 cannot be reached, active threads are shown (and stored) as `offline`.
 */
export async function listProjectT3ThreadsLive(
  deps: T3ServiceDeps,
  projectId: string,
): Promise<ProjectT3ThreadsResponse> {
  await requireProject(deps.storage, projectId);
  const stored = await deps.store.listProjectThreads(projectId);
  if (stored.length === 0) {
    return { threads: [] };
  }

  const now = deps.now ? deps.now() : Date.now();
  let mcpClient: T3McpClient | undefined;
  let listed: T3ThreadListItem[] | undefined;
  try {
    mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      fetchFn: deps.fetchFn,
      now,
    });
    listed = await mcpClient.listThreads({ allProjects: true, includeSubagents: false, limit: 100 });
  } catch (err) {
    if (!(err instanceof T3McpError) && !(err instanceof ValidationError)) {
      throw err;
    }
    listed = undefined;
  }

  const listedById = new Map((listed ?? []).map((t) => [t.threadId, t]));
  const threads: ProjectT3Thread[] = [];
  for (const thread of stored) {
    const listedThread = listedById.get(thread.threadId);
    let nextState: AgentRunState;
    let nextLink = thread.link;
    if (!listed) {
      nextState = toOfflineIfActive(thread);
    } else if (listedThread) {
      nextState = deriveLiveAgentRunState({
        threadStatus: listedThread.status,
        pendingRequestCount: listedThread.pendingRequestCount,
        activeRunId: listedThread.activeRunId,
        settled: listedThread.settled,
      });
      nextLink = listedThread.link ?? thread.link;
    } else {
      // Not in the bounded listing (older or deleted on the host): keep what Bitig last saw.
      nextState = thread.state;
    }

    const reconciled =
      nextState === thread.state && nextLink === thread.link
        ? thread
        : ((await deps.store.updateProjectThreadState(projectId, thread.threadId, {
            state: nextState,
            ...(nextLink ? { link: nextLink } : {}),
            now,
          })) ?? thread);

    const stopReason =
      mcpClient && listed && (reconciled.state === "failed" || reconciled.state === "stopped")
        ? await mcpClient.readThreadStopReason(reconciled.threadId).catch(() => undefined)
        : undefined;

    threads.push(stopReason ? { ...reconciled, stopReason } : reconciled);
  }
  return { threads };
}

export interface ReadProjectT3ThreadMessagesOptions {
  readonly afterPosition?: number | undefined;
}

/**
 * Reads user and assistant messages from a project-level T3 thread (#BIT-131), paged forward with
 * `afterPosition` (exclusive). Only threads Bitig recorded for this project can be read, so the
 * endpoint cannot read arbitrary T3 threads. Also reconciles the thread's live state in D1.
 */
export async function readProjectT3ThreadMessages(
  deps: T3ServiceDeps,
  projectId: string,
  threadId: string,
  options: ReadProjectT3ThreadMessagesOptions = {},
): Promise<ProjectT3ThreadMessagesResponse> {
  await requireProject(deps.storage, projectId);
  const existing = await deps.store.getProjectThread(projectId, threadId);
  if (!existing) {
    throw new NotFoundError("t3_thread", threadId);
  }

  const now = deps.now ? deps.now() : Date.now();
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    fetchFn: deps.fetchFn,
    now,
  });

  const readout = await mcpClient.readThreadMessages(existing.threadId, {
    afterPosition: options.afterPosition,
    limit: PROJECT_T3_MESSAGES_PAGE_LIMIT,
    maxCharsPerItem: PROJECT_T3_MESSAGE_MAX_CHARS,
  });

  let thread = existing;
  if (readout.thread || readout.recentRuns.length > 0) {
    const nextState = deriveLiveAgentRunState({
      thread: readout.thread,
      recentRuns: readout.recentRuns,
    });
    if (nextState !== existing.state) {
      thread =
        (await deps.store.updateProjectThreadState(projectId, existing.threadId, {
          state: nextState,
          now,
        })) ?? existing;
    }
  }

  const threadWithReason =
    readout.stopReason && (thread.state === "failed" || thread.state === "stopped")
      ? { ...thread, stopReason: readout.stopReason }
      : thread;

  return {
    thread: threadWithReason,
    messages: readout.messages,
    nextPosition: readout.nextPosition,
    hasMore: readout.hasMore,
    ...(readout.stopReason ? { stopReason: readout.stopReason } : {}),
  };
}

