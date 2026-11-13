import {
  DEFAULT_MAX_PARALLEL_CHILDREN,
  DEFAULT_PROJECT_T3_WORKSPACE_STRATEGY,
  ReportChildMergeInputSchema,
  ReportT3GitMetadataInputSchema,
  type ReportChildMergeInput,
  type ReportT3GitMetadataInput,
  type T3GitMetadata,
  NotFoundError,
  PROJECT_T3_MESSAGES_PAGE_LIMIT,
  PROJECT_T3_MESSAGE_MAX_CHARS,
  T3WorkspaceBusyError,
  ValidationError,
  buildMentionIndex,
  buildProjectT3LaunchPrompt,
  buildProjectT3ModelSwitchNotice,
  buildProjectT3ThreadTitle,
  buildT3LaunchPrompt,
  buildT3ModelSwitchComment,
  buildT3ModelSwitchNotice,
  buildT3SubagentBatchHandbackComment,
  buildT3SubagentBatchHandbackPrompt,
  buildT3SubagentStartedComment,
  buildUmbrellaIndex,
  canOverwriteRunProfile,
  canSwitchT3Model,
  checkStatusChange,
  compareTasks,
  computeT3ConnectionStatus,
  computeT3HostConnectionStatus,
  defaultIdGenerator,
  deriveLiveAgentRunState,
  extractCommentAttachmentReferences,
  findOutOfBoundsPaths,
  formatT3CommentAttachmentContext,
  formatT3ModelSelection,
  isActiveAgentRunState,
  isSameT3ModelSelection,
  nextLevelUp,
  parseT3RunCommentCommand,
  pickParallelBatch,
  resolveRunSelection,
  resolveTaskRef,
  taskCode,
  type ActiveAgentRunState,
  type AgentRun,
  type AgentRunChild,
  type AgentRunChildState,
  type AgentRunState,
  type Checkpoint,
  type Comment,
  type ParallelBatchCandidate,
  type ParallelSkipReason,
  type Project,
  type ProjectT3Thread,
  type ProjectT3ThreadMessagesResponse,
  type ProjectT3ThreadsResponse,
  type RealtimeEvent,
  type ResolvedRunSelection,
  type RunLevel,
  type RunLevelModelBinding,
  type RunSelectionSource,
  type RunningParallelTask,
  type StorageProvider,
  type StopUmbrellaChildrenResponse,
  type T3CommentAttachmentInfo,
  type T3ConnectionStatus,
  type T3HostConnectionStatus,
  type T3ModelCapability,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3ProjectActiveSession,
  type T3RunsLiveResponse,
  type T3RuntimeMode,
  type T3SubagentBatchHandbackChildItem,
  type T3TaskRunLiveResponse,
  type T3ThreadListItem,
  type T3WorkspaceBusySession,
  type T3WorkspaceStrategy,
  type Task,
  type TaskRunProfile,
  type UmbrellaChildItem,
  type UmbrellaChildrenStatusResponse,
  type UmbrellaLaunchReadiness,
  type UmbrellaReadyBatchItem,
} from "@bitig/core";
import type { SaveRunLevelsInput, T3ConnectionRecord, T3D1Store } from "@bitig/storage-d1";
import { T3McpClient, T3McpError } from "./client";
import { decryptT3Token } from "./crypto";
import {
  HttpRunProfileRouter,
  buildEffortValuesByLevel,
  type RunProfileRouter,
  type RunProfileSuggestion,
} from "./router";

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
  runProfileRouter?: RunProfileRouter | undefined;
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

function sameHostId(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a === b);
}

function requireRecordedHostId(hostId: string | undefined): string {
  if (!hostId) {
    makeValidationIssue("hostId", "This record has no originating T3 host. Ask the organisation owner to repair its host binding; Bitig will not select another host.");
  }
  return hostId;
}

function compositeThreadKey(hostId: string | null | undefined, threadId: string): string {
  return `${hostId ?? ""}\n${threadId}`;
}

export async function getT3ConnectionStatus(
  store: T3D1Store,
  now = Date.now(),
  hostId?: string,
): Promise<T3ConnectionStatus> {
  const connection = await store.getConnection(hostId);
  return computeT3ConnectionStatus(
    connection
      ? {
          id: connection.id,
          label: connection.label,
          kind: connection.kind,
          projectsRoot: connection.projectsRoot,
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

export async function listT3HostConnectionStatuses(
  store: T3D1Store,
  now = Date.now(),
): Promise<T3HostConnectionStatus[]> {
  const connections = await store.listConnections();
  return connections.map((connection) => computeT3HostConnectionStatus(connection, now));
}

const EXPIRED_T3_TOKEN_MESSAGE =
  "The T3 Code OAuth token has expired. Reconnect in Settings before starting or controlling a thread.";

export async function requireT3ConnectionForQueue(deps: {
  store: T3D1Store;
  encryptionKey: string;
  hostId?: string | undefined;
}): Promise<T3ConnectionRecord> {
  if (!deps.encryptionKey) {
    makeValidationIssue(
      "t3Connection",
      "T3_ENCRYPTION_KEY is not configured on this Worker; cannot use T3 integration",
    );
  }
  const connection = await deps.store.getConnection(deps.hostId);
  if (!connection) {
    makeValidationIssue(
      "t3Connection",
      deps.hostId
        ? `T3 Code host "${deps.hostId}" is not connected. Reconnect it in Settings first.`
        : "No T3 Code host is connected. Connect one in Settings first.",
    );
  }
  return connection;
}

export async function resolveActiveT3ConnectionAndClient(deps: {
  store: T3D1Store;
  encryptionKey: string;
  hostId?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  now?: number | undefined;
}): Promise<{ connection: T3ConnectionRecord; client: T3McpClient }> {
  const connection = await requireT3ConnectionForQueue({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: deps.hostId,
  });
  const now = deps.now ?? Date.now();
  if (connection.expiresAt <= now) {
    makeValidationIssue("t3Connection", `T3 host "${connection.id}": ${EXPIRED_T3_TOKEN_MESSAGE}`);
  }
  const accessToken = await decryptT3Token(
    {
      ciphertext: connection.encryptedAccessToken,
      iv: connection.tokenIv,
    },
    deps.encryptionKey,
  );
  return {
    connection,
    client: new T3McpClient({
      hostId: connection.id,
      mcpUrl: connection.mcpUrl,
      accessToken,
      fetchFn: deps.fetchFn,
    }),
  };
}

export async function createActiveT3McpClient(deps: {
  store: T3D1Store;
  encryptionKey: string;
  hostId?: string | undefined;
  fetchFn?: typeof fetch | undefined;
  now?: number | undefined;
}): Promise<T3McpClient> {
  const { client } = await resolveActiveT3ConnectionAndClient(deps);
  return client;
}

function isQueueableT3Error(err: unknown): boolean {
  if (
    err instanceof T3McpError &&
    (err.code === "connection_error" || err.code === "timeout" || err.code === "aborted")
  ) {
    return true;
  }
  if (err instanceof ValidationError) {
    return err.issues.some((issue) => issue.message.endsWith(EXPIRED_T3_TOKEN_MESSAGE));
  }
  return false;
}

interface QueuedLaunchPayload {
  hostId?: string | undefined;
  t3ProjectId: string;
  title: string;
  prompt: string;
  clientRequestId: string;
  workspaceStrategy: T3WorkspaceStrategy;
  baseRef?: string | undefined;
  branch?: string | undefined;
  startFromOrigin?: boolean | undefined;
  explicitProviderInstanceId?: string | undefined;
  explicitModel?: string | undefined;
  explicitOptions?: readonly T3ModelSelectionOption[] | undefined;
  explicitLevel?: string | undefined;
  providerInstanceId?: string | undefined;
  model?: string | undefined;
  options?: readonly T3ModelSelectionOption[] | undefined;
  modelSource?: RunSelectionSource | undefined;
  levelKey?: string | undefined;
  skippedReason?: string | undefined;
  runtimeMode?: T3RuntimeMode | undefined;
  settleThreadId?: string | undefined;
  parentTaskId?: string | undefined;
  childLabel?: string | undefined;
  childTitle?: string | undefined;
  actor: string;
}

interface QueuedMessagePayload {
  hostId?: string | undefined;
  prompt: string;
  clientRequestId: string;
  modelSelection?: T3ModelSelection | undefined;
  actor?: string | undefined;
  taskLabel?: string | undefined;
}

export interface LaunchTaskInT3Options {
  taskRef: string;
  workspaceStrategy?: T3WorkspaceStrategy | undefined;
  providerInstanceId?: string | undefined;
  model?: string | undefined;
  options?: readonly T3ModelSelectionOption[] | undefined;
  level?: string | undefined;
  runtimeMode?: T3RuntimeMode | undefined;
  actor?: string | undefined;
  /**
   * When true (e.g. for `/t3 run` comment commands, #BIT-166), requires an active and reachable
   * T3 host connection before launching or mutating task status instead of queueing offline.
   */
  requireActiveConnection?: boolean | undefined;
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

export async function resolveTaskLaunchRunSelection(
  deps: Pick<T3ServiceDeps, "store">,
  input: {
    taskId: string;
    projectId: string;
    hostId?: string | undefined;
    providerInstanceId?: string | undefined;
    model?: string | undefined;
    options?: readonly T3ModelSelectionOption[] | undefined;
    level?: string | undefined;
    now?: number | undefined;
  },
): Promise<ResolvedRunSelection> {
  const [profile, projectSettings, levels] = await Promise.all([
    deps.store.getTaskRunProfile(input.taskId),
    deps.store.getProjectRunSettings(input.projectId),
    deps.store.listRunLevels({
      hostId: input.hostId,
      ...(input.now !== undefined ? { now: input.now } : {}),
    }),
  ]);
  const explicit =
    input.model && input.model.trim().length > 0
      ? {
          ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
          model: input.model,
          ...(input.options && input.options.length > 0
            ? { options: input.options.map((opt) => ({ id: opt.id, value: opt.value })) }
            : {}),
        }
      : undefined;
  return resolveRunSelection({
    explicit,
    explicitLevel: input.level,
    profile,
    projectDefaultLevel: projectSettings?.defaultRunLevel,
    levels,
  });
}

async function resolveOriginatingTaskHostId(
  deps: T3ServiceDeps,
  taskId: string,
  existingRun?: AgentRun,
): Promise<string | undefined> {
  const run = existingRun ?? (await deps.store.getAgentRunByTaskId(taskId));
  if (run) {
    return requireRecordedHostId(run.hostId);
  }
  const task = await deps.storage.getTask(taskId);
  if (!task) {
    return undefined;
  }
  const mapping = await deps.store.getProjectMapping(task.projectId);
  return mapping?.hostId;
}

async function resolveOriginatingProjectThreadHostId(
  deps: T3ServiceDeps,
  projectId: string,
  existingThread: ProjectT3Thread,
): Promise<string | undefined> {
  await requireProject(deps.storage, projectId);
  return requireRecordedHostId(existingThread.hostId);
}

async function assertRootWorkspaceFreeOffline(
  deps: T3ServiceDeps,
  hostId: string | undefined,
  t3ProjectId: string,
  ignoredTaskId?: string,
  currentTaskId?: string,
): Promise<void> {
  const candidates = (await deps.store.listAgentRuns()).filter(
    (run) =>
      sameHostId(run.hostId, hostId) &&
      run.t3ProjectId === t3ProjectId &&
      run.workspaceStrategy === "root" &&
      run.taskId !== ignoredTaskId &&
      run.taskId !== currentTaskId &&
      isActiveAgentRunState(run.state),
  );
  const firstBusy = candidates[0];
  if (firstBusy && isActiveAgentRunState(firstBusy.state)) {
    throw new T3WorkspaceBusyError(await describeBusyRun(deps.storage, firstBusy, firstBusy.state));
  }
}

/**
 * Single-flight dispatcher for a task's queued T3 launch/reply requests (#BIT-161).
 * Claims one request at a time with a lease and token fencing in D1, preserves the original
 * `clientRequestId` across retries, and keeps the request queued when the T3 host is unreachable
 * or its OAuth token is expired.
 */
export async function dispatchQueuedTaskT3Run(
  deps: T3ServiceDeps,
  taskId: string,
  existingMcpClient?: T3McpClient,
): Promise<{
  run: AgentRun | null;
  dispatched: boolean;
  switchComment?: Comment | undefined;
}> {
  const now = deps.now ? deps.now() : Date.now();
  const initialHostId = await resolveOriginatingTaskHostId(deps, taskId);
  const clientByHostKey = new Map<string, T3McpClient>();
  if (existingMcpClient) {
    clientByHostKey.set(initialHostId ?? "", existingMcpClient);
  } else {
    try {
      const resolved = await resolveActiveT3ConnectionAndClient({
        store: deps.store,
        encryptionKey: deps.encryptionKey,
        hostId: initialHostId,
        fetchFn: deps.fetchFn,
        now,
      });
      clientByHostKey.set(initialHostId ?? "", resolved.client);
      clientByHostKey.set(resolved.connection.id, resolved.client);
    } catch (err) {
      if (isQueueableT3Error(err)) {
        return {
          run: (await deps.store.getAgentRunByTaskId(taskId)) ?? null,
          dispatched: false,
        };
      }
      throw err;
    }
  }

  let dispatched = false;
  let lastSwitchComment: Comment | undefined;

  for (;;) {
    const stepNow = deps.now ? deps.now() : Date.now();
    const claimed = await deps.store.requests.claim(taskId, defaultIdGenerator(), stepNow);
    if (!claimed) {
      break;
    }

    const requestHostId = claimed.host_id ?? initialHostId;
    const hostKey = requestHostId ?? "";

    try {
      let mcpClient = clientByHostKey.get(hostKey);
      if (!mcpClient) {
        const resolved = await resolveActiveT3ConnectionAndClient({
          store: deps.store,
          encryptionKey: deps.encryptionKey,
          hostId: requestHostId,
          fetchFn: deps.fetchFn,
          now: stepNow,
        });
        mcpClient = resolved.client;
        clientByHostKey.set(hostKey, mcpClient);
        clientByHostKey.set(resolved.connection.id, mcpClient);
      }

      if (claimed.kind === "launch") {
        const payload = JSON.parse(claimed.payload) as QueuedLaunchPayload;
        const launchHostId = payload.hostId ?? requestHostId;
        if (payload.workspaceStrategy === "root") {
          await assertRootWorkspaceFree(
            deps,
            mcpClient,
            launchHostId,
            payload.t3ProjectId,
            stepNow,
            payload.parentTaskId,
            taskId,
          );
        }

        let resolvedProviderInstanceId = payload.providerInstanceId;
        let resolvedModel = payload.model;
        let resolvedOptions = payload.options;
        let resolvedModelSource = payload.modelSource;
        let resolvedLevelKey = payload.levelKey;
        let resolvedSkippedReason = payload.skippedReason;

        if (!payload.settleThreadId) {
          const task = await deps.storage.getTask(taskId);
          if (task) {
            const hasExplicitInPayload =
              payload.explicitModel !== undefined ||
              payload.modelSource === "explicit" ||
              (payload.modelSource === undefined && payload.model !== undefined);
            const resolvedSelection = await resolveTaskLaunchRunSelection(deps, {
              taskId,
              projectId: task.projectId,
              hostId: launchHostId,
              providerInstanceId: hasExplicitInPayload
                ? (payload.explicitProviderInstanceId ?? payload.providerInstanceId)
                : undefined,
              model: hasExplicitInPayload ? (payload.explicitModel ?? payload.model) : undefined,
              options: hasExplicitInPayload ? (payload.explicitOptions ?? payload.options) : undefined,
              level: payload.explicitLevel,
              now: stepNow,
            });
            const selProvider = resolvedSelection.selection?.providerInstanceId.trim();
            resolvedProviderInstanceId =
              selProvider && selProvider.length > 0 ? selProvider : undefined;
            const selModel = resolvedSelection.selection?.model.trim();
            resolvedModel = selModel && selModel.length > 0 ? selModel : undefined;
            resolvedOptions =
              resolvedSelection.selection?.options && resolvedSelection.selection.options.length > 0
                ? [...resolvedSelection.selection.options]
                : undefined;
            resolvedModelSource = resolvedSelection.source;
            resolvedLevelKey = resolvedSelection.levelKey;
            resolvedSkippedReason = resolvedSelection.skippedReason;
          }
        }

        const claimToken = claimed.claim_token;
        if (!claimToken || !(await deps.store.requests.markAttempted(claimed.id, claimToken))) {
          break;
        }

        if (payload.settleThreadId && !payload.settleThreadId.startsWith("queued:")) {
          await mcpClient.settleThread(payload.settleThreadId);
        }

        const launched = await mcpClient.launchThread({
          projectId: payload.t3ProjectId,
          title: payload.title,
          prompt: payload.prompt,
          clientRequestId: payload.clientRequestId,
          workspaceStrategy: payload.workspaceStrategy,
          ...(payload.baseRef ? { baseRef: payload.baseRef } : {}),
          ...(payload.branch ? { branch: payload.branch } : {}),
          ...(payload.startFromOrigin !== undefined ? { startFromOrigin: payload.startFromOrigin } : {}),
          providerInstanceId: resolvedProviderInstanceId,
          model: resolvedModel,
          options: resolvedOptions,
          runtimeMode: payload.runtimeMode,
        });

        const savedRun = await deps.store.saveAgentRun({
          id: claimed.id,
          taskId,
          ...(launchHostId ? { hostId: launchHostId } : {}),
          t3ProjectId: payload.t3ProjectId,
          threadId: launched.threadId,
          link: launched.link,
          state: "working",
          model: resolvedModel,
          ...(resolvedModel && resolvedProviderInstanceId
            ? { providerInstanceId: resolvedProviderInstanceId }
            : {}),
          ...(resolvedOptions ? { modelOptions: resolvedOptions } : {}),
          ...(resolvedModelSource ? { modelSource: resolvedModelSource } : {}),
          ...(resolvedLevelKey ? { levelKey: resolvedLevelKey } : {}),
          ...(resolvedSkippedReason ? { skippedReason: resolvedSkippedReason } : {}),
          workspaceStrategy: payload.workspaceStrategy,
          ...(payload.parentTaskId ? { parentTaskId: payload.parentTaskId } : {}),
          startedBy: payload.actor,
          startedAt: stepNow,
          updatedAt: stepNow,
        });
        await persistLiveGitMetadata(deps, savedRun, launched.gitMetadata, stepNow);
        await deps.store.requests.finish(claimed, "delivered", stepNow);
        dispatched = true;

        const currentRun = (await deps.store.getAgentRunByTaskId(taskId)) ?? savedRun;
        if (deps.publishRealtime) {
          await deps.publishRealtime({ type: "agent_run.updated", run: currentRun }).catch(() => undefined);
        }

        if (payload.parentTaskId) {
          const childBranch = currentRun.branch ?? payload.branch;
          const existingChildRecord = await deps.store.getAgentRunChild(payload.parentTaskId, taskId);
          let updatedChildRecord: AgentRunChild | undefined;
          if (existingChildRecord?.state !== "running") {
            updatedChildRecord = await deps.store.addAgentRunChild({
              parentTaskId: payload.parentTaskId,
              childTaskId: taskId,
              state: "running",
              ...(childBranch ? { branch: childBranch } : {}),
              ...(currentRun.headSha ? { headSha: currentRun.headSha } : {}),
              startedAt: stepNow,
            });
          } else if (childBranch || currentRun.headSha) {
            updatedChildRecord = await deps.store.updateAgentRunChild(payload.parentTaskId, taskId, {
              ...(childBranch ? { branch: childBranch } : {}),
              ...(currentRun.headSha ? { headSha: currentRun.headSha } : {}),
              now: stepNow,
            });
          }
          await publishRunChild(deps, updatedChildRecord);
          await syncParentWaitingSubagentState(deps, payload.parentTaskId, stepNow);
          await deps.storage.addComment(
            {
              taskId: payload.parentTaskId,
              body: buildT3SubagentStartedComment({
                childLabel: payload.childLabel ?? taskId,
                childTitle: payload.childTitle ?? payload.title,
                link: currentRun.link,
              }),
              authorType: "agent",
              author: T3_BITIG_COMMENT_AUTHOR,
            },
            { actor: payload.actor },
          );
        }
      } else {
        const payload = JSON.parse(claimed.payload) as QueuedMessagePayload;
        const currentRun = await deps.store.getAgentRunByTaskId(taskId);
        if (!currentRun || currentRun.threadId.startsWith("queued:")) {
          await deps.store.requests.finish(claimed, "queued", stepNow);
          break;
        }

        let switchedTo: string | undefined;
        if (payload.modelSelection) {
          const switched = await switchT3ThreadModel(
            mcpClient,
            currentRun.threadId,
            currentRun,
            payload.modelSelection,
          );
          if (switched) {
            await deps.store.updateAgentRunModel(taskId, {
              selection: payload.modelSelection,
              now: stepNow,
            });
            switchedTo = switched.to;
            lastSwitchComment = await deps.storage.addComment(
              {
                taskId,
                body: buildT3ModelSwitchComment(switched.from, switched.to),
                authorType: "agent",
                author: T3_MODEL_SWITCH_COMMENT_AUTHOR,
              },
              { actor: payload.actor ?? T3_MODEL_SWITCH_COMMENT_AUTHOR },
            );
          }
        }

        const claimToken = claimed.claim_token;
        if (!claimToken || !(await deps.store.requests.markAttempted(claimed.id, claimToken))) {
          break;
        }

        const prompt =
          switchedTo && payload.taskLabel
            ? `${buildT3ModelSwitchNotice(payload.taskLabel, switchedTo)}\n\n${payload.prompt}`
            : payload.prompt;

        await mcpClient.sendThreadMessage({
          threadId: currentRun.threadId,
          prompt,
          clientRequestId: payload.clientRequestId,
        });

        await deps.store.requests.finish(claimed, "delivered", stepNow);
        dispatched = true;

        const updatedRun = await deps.store.getAgentRunByTaskId(taskId);
        if (updatedRun && deps.publishRealtime) {
          await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
        }
      }
    } catch (err) {
      if (isQueueableT3Error(err)) {
        await deps.store.requests.finish(claimed, "queued", stepNow);
        const queuedRun = await deps.store.getAgentRunByTaskId(taskId);
        if (queuedRun && deps.publishRealtime) {
          await deps.publishRealtime({ type: "agent_run.updated", run: queuedRun }).catch(() => undefined);
        }
        return {
          run: queuedRun ?? null,
          dispatched,
          ...(lastSwitchComment ? { switchComment: lastSwitchComment } : {}),
        };
      }
      await deps.store.requests.finish(claimed, "failed", stepNow);
      const failedRun = await deps.store.getAgentRunByTaskId(taskId);
      if (failedRun && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: failedRun }).catch(() => undefined);
      }
      throw err;
    }
  }

  return {
    run: (await deps.store.getAgentRunByTaskId(taskId)) ?? null,
    dispatched,
    ...(lastSwitchComment ? { switchComment: lastSwitchComment } : {}),
  };
}

/**
 * Drains all queued task runs/replies for the organisation when their T3 host is reachable (#BIT-161).
 */
export async function drainAllQueuedT3Runs(
  deps: T3ServiceDeps,
  existingMcpClient?: T3McpClient,
): Promise<void> {
  const pendingTaskIds = await deps.store.requests.listPendingTaskIds();
  if (pendingTaskIds.length === 0) {
    return;
  }
  for (const taskId of pendingTaskIds) {
    try {
      await dispatchQueuedTaskT3Run(deps, taskId, existingMcpClient);
    } catch {
      // Non-fatal during background/batch drain; individual task errors surface on direct actions.
    }
  }
}

/**
 * Starts a T3 thread for a Bitig task after verifying:
 * 1. The task exists and is not waiting for human approval (`pendingApproval`).
 * 2. All tasks in `dependsOn` are finished (`done` or `archived`).
 * 3. The task's Bitig project is mapped to an existing T3 project.
 * 4. A T3 OAuth connection is configured for the mapped host. When the host is offline or its token is expired,
 *    the approved launch is durably queued in D1 (`state: "queued"`) and dispatched once on reconnect (#BIT-161).
 *
 * With `parentTaskRef` (#BIT-141, #BIT-189, #BIT-190), the task starts as a child session of an umbrella task: a
 * dependency on that umbrella task does not block it, the child worktree branches from the umbrella's reported
 * branch/head (`bitig/<child-code>`), the child run is recorded in `agent_run_children`, and the umbrella task's
 * run moves to `waiting_subagent` until all running children of the batch have ended.
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
  if (parent && options.workspaceStrategy === "root") {
    makeValidationIssue(
      "workspaceStrategy",
      "Child tasks started from an umbrella session must run in an isolated git worktree (workspaceStrategy: \"worktree\"), never the root checkout.",
    );
  }

  // Enforce pendingApproval and unfinished dependency gates (same rules as an agent moving to in_progress).
  // The umbrella task is in progress while it delegates, so a dependency on it does not block its child.
  await checkStatusChange(deps.storage, task.id, "in_progress", "startT3Thread", {
    requireApproval: true,
    ...(parent ? { dependsOn: (task.dependsOn ?? []).filter((id) => id !== parent.task.id) } : {}),
  });

  const code = taskCode(task, project);
  if (parent) {
    await assertChildLaunchParallelGate(deps, parent, task, code, now);
  }

  const mapping = await deps.store.getProjectMapping(task.projectId);
  if (!mapping) {
    makeValidationIssue(
      "projectId",
      `Project "${project.name}" is not mapped to a T3 project. Map it in Settings first.`,
    );
  }

  const connection = await requireT3ConnectionForQueue({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: requireRecordedHostId(mapping.hostId),
  });
  const targetHostId = mapping.hostId ?? connection.id;

  let mcpClient: T3McpClient | undefined;
  try {
    mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      hostId: targetHostId,
      fetchFn: deps.fetchFn,
      now,
    });
  } catch (err) {
    if (options.requireActiveConnection || !isQueueableT3Error(err)) {
      throw err;
    }
    mcpClient = undefined;
  }

  const workspaceStrategy: T3WorkspaceStrategy = options.workspaceStrategy ?? "worktree";
  if (workspaceStrategy === "root") {
    if (mcpClient) {
      try {
        await assertRootWorkspaceFree(
          deps,
          mcpClient,
          targetHostId,
          mapping.t3ProjectId,
          now,
          parent?.task.id,
          task.id,
        );
      } catch (err) {
        if (options.requireActiveConnection || !isQueueableT3Error(err)) {
          throw err;
        }
        mcpClient = undefined;
        await assertRootWorkspaceFreeOffline(deps, targetHostId, mapping.t3ProjectId, parent?.task.id, task.id);
      }
    } else {
      await assertRootWorkspaceFreeOffline(deps, targetHostId, mapping.t3ProjectId, parent?.task.id, task.id);
    }
  }

  const [comments, childProfile] = await Promise.all([
    deps.storage.getComments(task.id),
    parent ? deps.store.getTaskRunProfile(task.id) : Promise.resolve(undefined),
  ]);
  const childCode = code ?? task.id;
  const childBranch = parent ? `bitig/${childCode}` : undefined;
  const childBaseRef = parent ? (parent.run.branch ?? parent.run.headSha) : undefined;
  const gitMetadataRunId = defaultIdGenerator();
  const builtPrompt = buildT3LaunchPrompt({
    gitMetadataRunId,
    task,
    ...(code ? { taskCode: code } : {}),
    projectName: project.name,
    comments,
    ...(parent ? { parentTaskCode: parent.label } : {}),
    ...(childBranch ? { childBranch } : {}),
    ...(childProfile?.touches ? { declaredTouches: childProfile.touches } : {}),
  });

  const actor = (options.actor?.trim() ?? "") || "t3";
  const resolvedSelection = await resolveTaskLaunchRunSelection(deps, {
    taskId: task.id,
    projectId: task.projectId,
    hostId: targetHostId,
    providerInstanceId: options.providerInstanceId,
    model: options.model,
    options: options.options,
    level: options.level,
    now,
  });
  const selProvider = resolvedSelection.selection?.providerInstanceId.trim();
  const resolvedProviderInstanceId =
    selProvider && selProvider.length > 0 ? selProvider : undefined;
  const selModel = resolvedSelection.selection?.model.trim();
  const resolvedModel = selModel && selModel.length > 0 ? selModel : undefined;
  const resolvedOptions =
    resolvedSelection.selection?.options && resolvedSelection.selection.options.length > 0
      ? [...resolvedSelection.selection.options]
      : undefined;
  const resolvedModelSource = resolvedSelection.source;
  const resolvedLevelKey = resolvedSelection.levelKey;
  const resolvedSkippedReason = resolvedSelection.skippedReason;

  if (options.requireActiveConnection && mcpClient) {
    const existingRun = await deps.store.getAgentRunByTaskId(task.id);
    if (existingRun && !existingRun.threadId.startsWith("queued:")) {
      if (sameHostId(existingRun.hostId, targetHostId)) {
        await mcpClient.settleThread(existingRun.threadId);
      } else if (existingRun.hostId) {
        const priorHostClient = await createActiveT3McpClient({
          store: deps.store,
          encryptionKey: deps.encryptionKey,
          hostId: existingRun.hostId,
          fetchFn: deps.fetchFn,
          now,
        }).catch(() => undefined);
        if (priorHostClient) {
          await priorHostClient.settleThread(existingRun.threadId).catch(() => undefined);
        }
      }
    }

    const launched = await mcpClient.launchThread({
      projectId: mapping.t3ProjectId,
      title: builtPrompt.title,
      prompt: builtPrompt.prompt,
      clientRequestId: existingRun
        ? `${builtPrompt.clientRequestId}:${gitMetadataRunId}`
        : builtPrompt.clientRequestId,
      workspaceStrategy,
      ...(childBaseRef ? { baseRef: childBaseRef } : {}),
      ...(childBranch ? { branch: childBranch } : {}),
      ...(parent ? { startFromOrigin: false } : {}),
      providerInstanceId: resolvedProviderInstanceId,
      model: resolvedModel,
      options: resolvedOptions,
      runtimeMode: options.runtimeMode,
    });

    const updatedTask =
      task.status === "in_progress"
        ? task
        : await deps.storage.updateTask(
            task.id,
            { status: "in_progress" },
            { actor },
          );

    const savedRun = await deps.store.saveAgentRun({
      id: gitMetadataRunId,
      taskId: task.id,
      hostId: targetHostId,
      t3ProjectId: mapping.t3ProjectId,
      threadId: launched.threadId,
      link: launched.link,
      state: "working",
      model: resolvedModel,
      ...(resolvedModel && resolvedProviderInstanceId
        ? { providerInstanceId: resolvedProviderInstanceId }
        : {}),
      ...(resolvedOptions ? { modelOptions: resolvedOptions } : {}),
      modelSource: resolvedModelSource,
      ...(resolvedLevelKey ? { levelKey: resolvedLevelKey } : {}),
      ...(resolvedSkippedReason ? { skippedReason: resolvedSkippedReason } : {}),
      workspaceStrategy,
      ...(parent ? { parentTaskId: parent.task.id } : {}),
      startedBy: actor,
      startedAt: now,
      updatedAt: now,
    });
    const finalRun = await persistLiveGitMetadata(deps, savedRun, launched.gitMetadata, now);
    if (deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: finalRun }).catch(() => undefined);
    }
    return {
      run: finalRun,
      task: updatedTask,
      ...(code ? { code } : {}),
    };
  }

  const updatedTask =
    task.status === "in_progress"
      ? task
      : await deps.storage.updateTask(
          task.id,
          { status: "in_progress" },
          { actor },
        );

  const launchPayload: QueuedLaunchPayload = {
    hostId: targetHostId,
    t3ProjectId: mapping.t3ProjectId,
    title: builtPrompt.title,
    prompt: builtPrompt.prompt,
    clientRequestId: builtPrompt.clientRequestId,
    workspaceStrategy,
    ...(childBaseRef ? { baseRef: childBaseRef } : {}),
    ...(childBranch ? { branch: childBranch } : {}),
    ...(parent ? { startFromOrigin: false } : {}),
    ...(resolvedProviderInstanceId ? { providerInstanceId: resolvedProviderInstanceId } : {}),
    ...(resolvedModel ? { model: resolvedModel } : {}),
    ...(resolvedOptions ? { options: resolvedOptions } : {}),
    modelSource: resolvedModelSource,
    ...(resolvedLevelKey ? { levelKey: resolvedLevelKey } : {}),
    ...(resolvedSkippedReason ? { skippedReason: resolvedSkippedReason } : {}),
    ...(options.providerInstanceId ? { explicitProviderInstanceId: options.providerInstanceId } : {}),
    ...(options.model ? { explicitModel: options.model } : {}),
    ...(options.options ? { explicitOptions: options.options } : {}),
    ...(options.level ? { explicitLevel: options.level } : {}),
    ...(options.runtimeMode ? { runtimeMode: options.runtimeMode } : {}),
    ...(parent
      ? {
          parentTaskId: parent.task.id,
          childLabel: code ?? task.id,
          childTitle: task.title,
        }
      : {}),
    actor,
  };

  await deps.store.requests.enqueue({
    id: gitMetadataRunId,
    hostId: targetHostId,
    taskId: task.id,
    kind: "launch",
    payload: JSON.stringify(launchPayload),
    now,
    launch: {
      id: gitMetadataRunId,
      taskId: task.id,
      hostId: targetHostId,
      t3ProjectId: mapping.t3ProjectId,
      threadId: `queued:${gitMetadataRunId}`,
      state: "queued",
      model: resolvedModel,
      ...(resolvedModel && resolvedProviderInstanceId ? { providerInstanceId: resolvedProviderInstanceId } : {}),
      ...(resolvedOptions ? { modelOptions: resolvedOptions } : {}),
      modelSource: resolvedModelSource,
      ...(resolvedLevelKey ? { levelKey: resolvedLevelKey } : {}),
      ...(resolvedSkippedReason ? { skippedReason: resolvedSkippedReason } : {}),
      workspaceStrategy,
      ...(parent ? { parentTaskId: parent.task.id } : {}),
      startedBy: actor,
      startedAt: now,
      updatedAt: now,
    },
  });

  if (parent) {
    const addedChild = await deps.store.addAgentRunChild({
      parentTaskId: parent.task.id,
      childTaskId: task.id,
      state: "running",
      ...(childBranch ? { branch: childBranch } : {}),
      startedAt: now,
    });
    if (!mcpClient) {
      await publishRunChild(deps, addedChild);
    }
  }

  if (mcpClient) {
    const dispatched = await dispatchQueuedTaskT3Run(deps, task.id, mcpClient);
    const finalRun = dispatched.run ?? (await deps.store.getAgentRunByTaskId(task.id));
    if (!finalRun) {
      throw new Error("Queued run was not persisted");
    }
    if (!dispatched.dispatched && parent) {
      await syncParentWaitingSubagentState(deps, parent.task.id, now);
    }
    return {
      run: finalRun,
      task: updatedTask,
      ...(code ? { code } : {}),
    };
  }

  const queuedRun = await deps.store.getAgentRunByTaskId(task.id);
  if (!queuedRun) {
    throw new Error("Queued run was not persisted");
  }
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: queuedRun }).catch(() => undefined);
  }
  if (parent) {
    await syncParentWaitingSubagentState(deps, parent.task.id, now);
  }

  return {
    run: queuedRun,
    task: updatedTask,
    ...(code ? { code } : {}),
  };
}

/** Alias for `launchTaskInT3` used by REST and MCP launch paths (#BIT-186). */
export const startT3Thread = launchTaskInT3;

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
 * Synchronizes an umbrella task run's `waiting_subagent` state and `waitingForTaskId` pointer
 * from its currently `"running"` rows in `agent_run_children` (#BIT-189).
 */
async function syncParentWaitingSubagentState(
  deps: T3ServiceDeps,
  parentTaskId: string,
  now: number,
): Promise<AgentRun | undefined> {
  const children = await deps.store.listAgentRunChildren(parentTaskId);
  const firstRunning = children.find((child) => child.state === "running");
  if (!firstRunning) {
    return await deps.store.getAgentRunByTaskId(parentTaskId);
  }
  const waitingRun = await deps.store.setAgentRunWaitingFor(parentTaskId, {
    childTaskId: firstRunning.childTaskId,
    now,
  });
  if (waitingRun && deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: waitingRun }).catch(() => undefined);
  }
  return waitingRun;
}

/**
 * Reconciles any stale `"running"` rows in `agent_run_children` for `parentTaskId` and returns
 * the active running children with their declared `touches` and `parallelSafe` flags (#BIT-189).
 */
async function listActiveRunningChildren(
  deps: T3ServiceDeps,
  parentTaskId: string,
  now = Date.now(),
): Promise<RunningParallelTask[]> {
  let children = await deps.store.listAgentRunChildren(parentTaskId);
  const parentRun = await deps.store.getAgentRunByTaskId(parentTaskId);
  if (
    parentRun?.waitingForTaskId &&
    !children.some((c) => c.childTaskId === parentRun.waitingForTaskId)
  ) {
    const legacyChild = await deps.storage.getTask(parentRun.waitingForTaskId);
    if (legacyChild) {
      await deps.store.addAgentRunChild({
        parentTaskId,
        childTaskId: legacyChild.id,
        state: "running",
        startedAt: Date.parse(parentRun.updatedAt) || now,
      });
      children = await deps.store.listAgentRunChildren(parentTaskId);
    }
  }

  const running: RunningParallelTask[] = [];
  for (const row of children) {
    if (row.state !== "running") continue;
    const [childTask, childRun] = await Promise.all([
      deps.storage.getTask(row.childTaskId),
      deps.store.getAgentRunByTaskId(row.childTaskId),
    ]);
    if (!childTask) {
      await deps.store.removeAgentRunChild(parentTaskId, row.childTaskId);
      continue;
    }
    if (FINISHED_TASK_STATUSES.has(childTask.status)) {
      const claimed = await deps.store.claimAgentRunChild(parentTaskId, row.childTaskId, {
        state: "done",
        branch: childRun?.branch ?? row.branch ?? null,
        headSha: childRun?.headSha ?? row.headSha ?? null,
        now,
      });
      await publishRunChild(deps, claimed);
      continue;
    }
    if (childTask.needsHuman) {
      const claimed = await deps.store.claimAgentRunChild(parentTaskId, row.childTaskId, {
        state: "needs_human",
        branch: childRun?.branch ?? row.branch ?? null,
        headSha: childRun?.headSha ?? row.headSha ?? null,
        now,
      });
      await publishRunChild(deps, claimed);
      continue;
    }
    if (!childRun || ENDED_CHILD_RUN_STATES.has(childRun.state)) {
      const claimed = await deps.store.claimAgentRunChild(parentTaskId, row.childTaskId, {
        state: childRun?.state === "failed" ? "failed" : "stopped",
        branch: childRun?.branch ?? row.branch ?? null,
        headSha: childRun?.headSha ?? row.headSha ?? null,
        now,
      });
      await publishRunChild(deps, claimed);
      continue;
    }
    if (!isActiveAgentRunState(childRun.state)) {
      continue;
    }
    const [code, profile] = await Promise.all([
      labelTask(deps.storage, childTask),
      deps.store.getTaskRunProfile(childTask.id),
    ]);
    running.push({
      id: childTask.id,
      code,
      touches: profile?.touches,
      parallelSafe: profile?.parallelSafe,
    });
  }
  return running;
}

/**
 * Enforces the server-side parallel batch gate when launching a child task under an umbrella (#BIT-189):
 * - Under the project's `maxParallelChildren` (default 3).
 * - No path overlap with a running sibling using `pickParallelBatch` rules.
 * - A task with no declared `touches`, `parallelSafe === false`, or touching a serial path only runs alone.
 */
async function assertChildLaunchParallelGate(
  deps: T3ServiceDeps,
  parent: UmbrellaParent,
  child: Task,
  childCode: string | undefined,
  now: number,
): Promise<void> {
  const [running, projectSettings, profile] = await Promise.all([
    listActiveRunningChildren(deps, parent.task.id, now),
    deps.store.getProjectRunSettings(child.projectId),
    deps.store.getTaskRunProfile(child.id),
  ]);
  const candidate: ParallelBatchCandidate = {
    id: child.id,
    code: childCode ?? child.id,
    pendingApproval: Boolean(child.pendingApproval),
    blockedBy: [],
    profile,
  };
  const batch = pickParallelBatch([candidate], {
    running,
    cap: projectSettings?.maxParallelChildren ?? DEFAULT_MAX_PARALLEL_CHILDREN,
    serialPaths: projectSettings?.serialPaths ?? [],
  });
  const skip = batch.skipped[0];
  if (skip) {
    const details =
      skip.blockingTask && !skip.message.includes(skip.blockingTask)
        ? `${skip.message} (blocked by ${skip.blockingTask}).`
        : skip.message;
    makeValidationIssue("parentTaskId", details);
  }
}

function getUmbrellaParentGitReadinessIssue(run: AgentRun, label: string): string | undefined {
  const hasBranch = typeof run.branch === "string" && run.branch.trim().length > 0;
  const hasHeadSha = typeof run.headSha === "string" && run.headSha.trim().length > 0;
  const hasWorktreePath = typeof run.worktreePath === "string" && run.worktreePath.trim().length > 0;
  if (!hasBranch || !hasHeadSha || !hasWorktreePath) {
    const missing: string[] = [];
    if (!hasBranch) missing.push("branch");
    if (!hasHeadSha) missing.push("headSha");
    if (!hasWorktreePath) missing.push("worktreePath");
    return `Umbrella task ${label} must report its git metadata (${missing.join(", ")}) via report_t3_git_metadata before starting child tasks, so each child worktree can branch from the umbrella's worktree.`;
  }
  if (run.dirty === true || run.uncommittedChanges === true) {
    return `Umbrella task ${label} has uncommitted tracked changes in its worktree. Commit your work and report clean git metadata (dirty: false) via report_t3_git_metadata before starting child tasks.`;
  }
  return undefined;
}

/**
 * Verifies that an umbrella task's T3 session has reported its integration branch, head commit,
 * and worktree path, and that it has no uncommitted tracked changes (#BIT-190).
 */
function assertUmbrellaParentGitReady(run: AgentRun, label: string): void {
  const issue = getUmbrellaParentGitReadinessIssue(run, label);
  if (issue) {
    makeValidationIssue("parentTaskId", issue);
  }
}

/**
 * Resolves the umbrella task a child session is started from (#BIT-141, #BIT-189, #BIT-190).
 * Refused when it is the task itself, has no T3 session to resume, has not reported clean git
 * metadata (`branch`, `headSha`, `worktreePath`), or when the child already has an active session
 * of its own.
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
  assertUmbrellaParentGitReady(run, label);
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
 * project's root checkout on the same host (#BIT-134, #BIT-147). Only runs Bitig recorded with
 * `workspaceStrategy: "root"` count: isolated worktrees never collide, project-level threads do not
 * edit the codebase, and threads started outside Bitig (or before the strategy was stored) have no
 * known workspace.
 *
 * Stored run states can be stale, so each candidate is re-checked against T3 and the result is
 * saved like `listT3RunsLive` does. A run whose thread T3 cannot read is saved as `offline`
 * (as `getTaskT3RunLiveStatus` does), so a deleted thread cannot block launches forever.
 */
async function assertRootWorkspaceFree(
  deps: T3ServiceDeps,
  mcpClient: T3McpClient,
  hostId: string | undefined,
  t3ProjectId: string,
  now: number,
  ignoredTaskId?: string,
  currentTaskId?: string,
): Promise<void> {
  const candidates = (await deps.store.listAgentRuns()).filter(
    (run) =>
      sameHostId(run.hostId, hostId) &&
      run.t3ProjectId === t3ProjectId &&
      run.workspaceStrategy === "root" &&
      run.taskId !== ignoredTaskId &&
      run.taskId !== currentTaskId &&
      isActiveAgentRunState(run.state),
  );
  if (candidates.length === 0) {
    return;
  }

  for (const run of candidates) {
    if (run.threadId.startsWith("queued:")) {
      throw new T3WorkspaceBusyError(await describeBusyRun(deps.storage, run, "queued"));
    }
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

async function syncAgentRunChildGitMetadata(
  deps: Pick<T3ServiceDeps, "store" | "publishRealtime">,
  run: AgentRun,
  now: number,
): Promise<void> {
  if (!run.parentTaskId) return;
  if (run.branch === undefined && run.headSha === undefined) return;
  const updatedChild = await deps.store
    .updateAgentRunChild(run.parentTaskId, run.taskId, {
      ...(run.branch !== undefined ? { branch: run.branch } : {}),
      ...(run.headSha !== undefined ? { headSha: run.headSha } : {}),
      now,
    })
    .catch(() => undefined);
  if (updatedChild && deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run_child.updated", child: updatedChild }).catch(() => undefined);
  }
}

/** Records agent-reported Git data after organisation and run identity validation. */
export async function reportTaskT3GitMetadata(
  deps: T3ServiceDeps,
  input: ReportT3GitMetadataInput,
  signal?: AbortSignal,
): Promise<AgentRun> {
  const parsed = ReportT3GitMetadataInputSchema.parse(input);
  signal?.throwIfAborted();
  // The scoped storage enforces organisation ownership before the unscoped run-table update.
  const operationOptions = signal ? { signal } : {};
  const taskId = await resolveTaskRef(deps.storage, parsed.taskId, operationOptions);
  if (!await deps.storage.getTask(taskId, operationOptions)) throw new NotFoundError("task", taskId);
  signal?.throwIfAborted();
  const now = deps.now?.() ?? Date.now();
  const run = await deps.store.updateAgentRunGitMetadata(taskId, parsed.runId, parsed.threadId, parsed.metadata, now);
  if (!run) makeValidationIssue("runId", "The run or thread no longer matches this task; metadata was not recorded.");
  await syncAgentRunChildGitMetadata(deps, run, now);
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run }).catch((err: unknown) => {
      console.warn("Could not publish T3 Git metadata update", err);
    });
  }
  return run;
}

/**
 * Records that an umbrella session merged a finished child task's branch into the integration
 * branch (`merged_at` / `merged_sha` in `agent_run_children`, #BIT-190).
 */
export async function reportChildMerge(
  deps: T3ServiceDeps,
  input: ReportChildMergeInput,
  signal?: AbortSignal,
): Promise<AgentRunChild> {
  const parsed = ReportChildMergeInputSchema.parse(input);
  signal?.throwIfAborted();
  const operationOptions = signal ? { signal } : {};
  const [parentTaskId, childTaskId] = await Promise.all([
    resolveTaskRef(deps.storage, parsed.parentTaskId, operationOptions),
    resolveTaskRef(deps.storage, parsed.childTaskId, operationOptions),
  ]);
  const [parentTask, childTask] = await Promise.all([
    deps.storage.getTask(parentTaskId, operationOptions),
    deps.storage.getTask(childTaskId, operationOptions),
  ]);
  if (!parentTask) throw new NotFoundError("task", parentTaskId);
  if (!childTask) throw new NotFoundError("task", childTaskId);
  signal?.throwIfAborted();
  const now = deps.now?.() ?? Date.now();
  const updated = await deps.store.recordAgentRunChildMerge(parentTaskId, childTaskId, {
    mergedSha: parsed.mergedSha,
    mergedAt: now,
  });
  if (!updated) {
    const [parentLabel, childLabel] = await Promise.all([
      labelTask(deps.storage, parentTask),
      labelTask(deps.storage, childTask),
    ]);
    makeValidationIssue(
      "childTaskId",
      `Task ${childLabel} has no recorded child T3 run under umbrella task ${parentLabel}.`,
    );
  }
  await publishRunChild(deps, updated);
  return updated;
}

async function persistLiveGitMetadata(deps: T3ServiceDeps, run: AgentRun, metadata: T3GitMetadata | undefined, now: number): Promise<AgentRun> {
  if (!metadata || !Object.entries(metadata).some(([key, value]) =>
    JSON.stringify(run[key as keyof T3GitMetadata] ?? null) !== JSON.stringify(value),
  )) return run;
  const updated = (await deps.store.updateAgentRunGitMetadata(run.taskId, run.id, run.threadId, metadata, now)) ?? run;
  await syncAgentRunChildGitMetadata(deps, updated, now);
  return updated;
}

async function resolveNextLevelUpForTask(
  deps: Pick<T3ServiceDeps, "store" | "storage" | "now">,
  taskId: string,
  run: AgentRun | null,
  hostId?: string,
): Promise<RunLevel | undefined> {
  const task = await deps.storage.getTask(taskId);
  const isFailedOrNeedsHuman = run?.state === "failed" || Boolean(task?.needsHuman);
  if (!isFailedOrNeedsHuman) {
    return undefined;
  }

  const now = deps.now ? deps.now() : Date.now();
  const [profile, projectSettings, levels] = await Promise.all([
    deps.store.getTaskRunProfile(taskId),
    task ? deps.store.getProjectRunSettings(task.projectId) : Promise.resolve(undefined),
    deps.store.listRunLevels({
      ...(hostId ? { hostId } : {}),
      now,
    }),
  ]);

  let currentLevelKey =
    run?.levelKey ??
    profile?.level ??
    projectSettings?.defaultRunLevel;

  if (!currentLevelKey && run?.model) {
    const matchedLevel = levels.find((l) => l.selection?.model.trim() === run.model?.trim());
    if (matchedLevel) {
      currentLevelKey = matchedLevel.key;
    }
  }

  if (!currentLevelKey) {
    return undefined;
  }
  return nextLevelUp(levels, currentLevelKey);
}

/**
 * Checks the live T3 thread status when a task is opened.
 * Updates run state and Git metadata in D1 and broadcasts `agent_run.updated` if changed,
 * but NEVER mutates the Bitig task's status (`in_progress`, `done`, `archived`, `needsHuman`).
 */
export async function getTaskT3RunLiveStatus(
  deps: T3ServiceDeps,
  taskId: string,
): Promise<T3TaskRunLiveResponse> {
  const withNextLevel = async (
    base: T3TaskRunLiveResponse,
    hostId?: string,
  ): Promise<T3TaskRunLiveResponse> => {
    const nextLevel = await resolveNextLevelUpForTask(deps, taskId, base.run, hostId);
    return nextLevel ? { ...base, nextLevelUp: nextLevel } : base;
  };

  let existingRun = await deps.store.getAgentRunByTaskId(taskId);
  if (!existingRun) {
    return await withNextLevel({
      run: null,
      pendingQuestions: [],
    });
  }

  const now = deps.now ? deps.now() : Date.now();
  const targetHostId = await resolveOriginatingTaskHostId(deps, taskId, existingRun);
  const hasPendingBefore = await deps.store.requests.hasPending(taskId);
  let mcpClient: T3McpClient;
  try {
    mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      hostId: targetHostId,
      fetchFn: deps.fetchFn,
      now,
    });
  } catch {
    if (hasPendingBefore || existingRun.state === "queued") {
      const queuedRun =
        existingRun.state === "queued"
          ? existingRun
          : ((await deps.store.updateAgentRunState(taskId, { state: "queued", now })) ?? existingRun);
      if (queuedRun.state !== existingRun.state && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: queuedRun }).catch(() => undefined);
      }
      return await withNextLevel(
        {
          run: queuedRun,
          pendingQuestions: [],
        },
        targetHostId,
      );
    }
    const offlineRun =
      existingRun.state === "offline"
        ? existingRun
        : ((await deps.store.updateAgentRunState(taskId, { state: "offline", now })) ?? existingRun);
    if (offlineRun.state !== existingRun.state && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: offlineRun }).catch(() => undefined);
    }
    return await withNextLevel(
      {
        run: offlineRun,
        pendingQuestions: [],
      },
      targetHostId,
    );
  }

  if (hasPendingBefore || existingRun.state === "queued") {
    try {
      const dispatched = await dispatchQueuedTaskT3Run(deps, taskId, mcpClient);
      if (dispatched.run) {
        existingRun = dispatched.run;
      }
    } catch (err) {
      if (!(err instanceof T3McpError)) {
        throw err;
      }
    }
  }

  if ((await deps.store.requests.hasPending(taskId)) || existingRun.threadId.startsWith("queued:")) {
    return await withNextLevel(
      {
        run: (await deps.store.getAgentRunByTaskId(taskId)) ?? existingRun,
        pendingQuestions: [],
      },
      targetHostId,
    );
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

    const stateUpdatedRun =
      nextState === existingRun.state
        ? existingRun
        : ((await deps.store.updateAgentRunState(taskId, { state: nextState, now })) ?? existingRun);

    const updatedRun = await persistLiveGitMetadata(deps, stateUpdatedRun, live.gitMetadata, now);
    if (updatedRun !== existingRun && deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
    }
    await afterRunStateChange(deps, existingRun, updatedRun, live.stopReason);

    return await withNextLevel(
      {
        run: updatedRun,
        ...(live.pendingRequestId ? { pendingRequestId: live.pendingRequestId } : {}),
        pendingQuestions: live.pendingQuestions,
        ...(live.stopReason ? { stopReason: live.stopReason } : {}),
      },
      targetHostId,
    );
  } catch (err) {
    if (err instanceof T3McpError) {
      if (await deps.store.requests.hasPending(taskId)) {
        return await withNextLevel(
          {
            run: (await deps.store.getAgentRunByTaskId(taskId)) ?? existingRun,
            pendingQuestions: [],
          },
          targetHostId,
        );
      }
      const offlineRun =
        existingRun.state === "offline"
          ? existingRun
          : ((await deps.store.updateAgentRunState(taskId, { state: "offline", now })) ?? existingRun);
      if (offlineRun.state !== existingRun.state && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: offlineRun }).catch(() => undefined);
      }
      return await withNextLevel(
        {
          run: offlineRun,
          pendingQuestions: [],
        },
        targetHostId,
      );
    }
    throw err;
  }
}

/**
 * Syncs and lists T3 agent runs and active project sessions across all connected hosts in the
 * organisation (#BIT-126, #BIT-147).
 */
export async function listT3RunsLive(deps: T3ServiceDeps): Promise<T3RunsLiveResponse> {
  const now = deps.now ? deps.now() : Date.now();
  await drainAllQueuedT3Runs(deps);

  const [connections, existingRuns, mappings, projectThreads] = await Promise.all([
    deps.store.listConnections(),
    deps.store.listAgentRuns(),
    deps.store.listProjectMappings(),
    deps.store.listProjectThreads(),
  ]);
  if (existingRuns.length === 0 && mappings.length === 0) {
    return { runs: [], activeSessions: [] };
  }

  const projectThreadsByCompositeKey = new Map(
    projectThreads.map((t) => [compositeThreadKey(t.hostId, t.threadId), t]),
  );

  // Map `(hostId, t3ProjectId)` to `projectId` so identical t3ProjectIds on two hosts never collide.
  const projectIdByHostAndT3ProjectId = new Map<string, string>();
  for (const mapping of mappings) {
    const resolvedHostId = mapping.hostId ?? "";
    projectIdByHostAndT3ProjectId.set(`${resolvedHostId}\n${mapping.t3ProjectId}`, mapping.projectId);
  }

  const clientsByHostId = new Map<string, T3McpClient>();
  const threadsByHostId = new Map<string, Map<string, T3ThreadListItem>>();
  const listedThreadsWithHost: { hostId: string; thread: T3ThreadListItem }[] = [];

  for (const connection of connections) {
    let client: T3McpClient;
    try {
      client = await createActiveT3McpClient({
        store: deps.store,
        encryptionKey: deps.encryptionKey,
        hostId: connection.id,
        fetchFn: deps.fetchFn,
        now,
      });
    } catch {
      continue;
    }
    clientsByHostId.set(connection.id, client);
    try {
      const hostThreads = await client.listThreads({
        allProjects: true,
        includeSubagents: false,
        limit: 100,
      });
      threadsByHostId.set(connection.id, new Map(hostThreads.map((t) => [t.threadId, t])));
      for (const thread of hostThreads) {
        listedThreadsWithHost.push({ hostId: connection.id, thread });
      }
    } catch (err) {
      if (!(err instanceof T3McpError)) {
        throw err;
      }
      clientsByHostId.delete(connection.id);
    }
  }

  const tasks = await deps.storage.getTasks();
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const resolveRunHostId = (run: AgentRun): string | undefined => {
    return run.hostId;
  };

  const reconciledById = new Map<string, AgentRun>();
  const runs: AgentRun[] = [];
  const pushRun = (run: AgentRun, existingRun: AgentRun): void => {
    reconciledById.set(existingRun.id, run);
  };

  // Umbrella runs waiting on a child task go last, so they see their child's reconciled state (#BIT-141, #BIT-189).
  const reconcileOrder = [
    ...existingRuns.filter((run) => !run.waitingForTaskId),
    ...existingRuns.filter((run) => run.waitingForTaskId),
  ];
  for (const snapshotRun of reconcileOrder) {
    // Re-read umbrella runs in case an earlier child's state change in this pass already handed back the batch.
    const existingRun = snapshotRun.waitingForTaskId
      ? ((await deps.store.getAgentRunByTaskId(snapshotRun.taskId)) ?? snapshotRun)
      : snapshotRun;
    if (snapshotRun.waitingForTaskId && !existingRun.waitingForTaskId && existingRun.state === "working") {
      pushRun(existingRun, snapshotRun);
      continue;
    }

    const runHostId = resolveRunHostId(existingRun);
    const mcpClient = runHostId ? clientsByHostId.get(runHostId) : undefined;
    const hostThreadsById = runHostId ? threadsByHostId.get(runHostId) : undefined;
    if (!mcpClient || !hostThreadsById || existingRun.state === "queued" || existingRun.threadId.startsWith("queued:")) {
      pushRun(existingRun, snapshotRun);
      continue;
    }

    const listedThread = hostThreadsById.get(existingRun.threadId);
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
      const refreshedAfterUmbrella = (await deps.store.getAgentRunByTaskId(existingRun.taskId)) ?? existingRun;
      const nextLink = listedThread.link ?? refreshedAfterUmbrella.link;
      const stateUpdatedRun =
        nextState === refreshedAfterUmbrella.state && nextLink === refreshedAfterUmbrella.link
          ? refreshedAfterUmbrella
          : ((await deps.store.updateAgentRunState(existingRun.taskId, {
              state: nextState,
              ...(nextLink ? { link: nextLink } : {}),
              now,
            })) ?? refreshedAfterUmbrella);
      const listedGitMetadata = listedThread.gitMetadata
        ? {
            ...(typeof listedThread.gitMetadata.branch === "string"
              ? { branch: listedThread.gitMetadata.branch }
              : {}),
            ...(listedThread.gitMetadata.pullRequestUrls !== undefined
              ? { pullRequestUrls: listedThread.gitMetadata.pullRequestUrls }
              : {}),
          }
        : undefined;
      const updatedRun = await persistLiveGitMetadata(deps, stateUpdatedRun, listedGitMetadata, now);
      if (updatedRun.state !== snapshotRun.state && deps.publishRealtime) {
        await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
      }
      await afterRunStateChange(deps, existingRun, updatedRun);
      pushRun(updatedRun, snapshotRun);
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
        const refreshedAfterUmbrella = (await deps.store.getAgentRunByTaskId(existingRun.taskId)) ?? existingRun;
        const stateUpdatedRun =
          nextState === refreshedAfterUmbrella.state
            ? refreshedAfterUmbrella
            : ((await deps.store.updateAgentRunState(existingRun.taskId, { state: nextState, now })) ?? refreshedAfterUmbrella);
        const updatedRun = await persistLiveGitMetadata(deps, stateUpdatedRun, live.gitMetadata, now);
        if (updatedRun !== snapshotRun && deps.publishRealtime) {
          await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
        }
        await afterRunStateChange(deps, existingRun, updatedRun, live.stopReason);
        pushRun(updatedRun, snapshotRun);
      } catch (err) {
        if (err instanceof T3McpError) {
          pushRun(existingRun, snapshotRun);
        } else {
          throw err;
        }
      }
    } else {
      pushRun(existingRun, snapshotRun);
    }
  }
  for (const existingRun of existingRuns) {
    runs.push(reconciledById.get(existingRun.id) ?? existingRun);
  }

  const activeSessions: T3ProjectActiveSession[] = [];
  const seenHostThreadKeys = new Set<string>();

  for (const run of runs) {
    if (!isActiveAgentRunState(run.state)) {
      continue;
    }
    const runHostId = resolveRunHostId(run);
    const task = tasksById.get(run.taskId);
    const projectId =
      task?.projectId ??
      projectIdByHostAndT3ProjectId.get(`${runHostId ?? ""}\n${run.t3ProjectId}`) ??
      projectIdByHostAndT3ProjectId.get(`\n${run.t3ProjectId}`);
    if (!projectId) {
      continue;
    }
    const listedThread = runHostId ? threadsByHostId.get(runHostId)?.get(run.threadId) : undefined;
    seenHostThreadKeys.add(compositeThreadKey(runHostId, run.threadId));
    activeSessions.push({
      threadId: run.threadId,
      projectId,
      ...(runHostId ? { hostId: runHostId } : {}),
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

  for (const { hostId, thread } of listedThreadsWithHost) {
    const compositeKey = compositeThreadKey(hostId, thread.threadId);
    if (seenHostThreadKeys.has(compositeKey)) {
      continue;
    }
    // Project-level threads Bitig started (#BIT-127) keep their stored projectId, title, and model
    // even if T3 omits `projectId` or if the project mapping was later reattached (#BIT-147).
    const projectThread = projectThreadsByCompositeKey.get(compositeKey);
    const t3ProjectId = thread.projectId ?? projectThread?.t3ProjectId;
    if (!t3ProjectId) {
      continue;
    }
    const projectId =
      projectThread?.projectId ??
      projectIdByHostAndT3ProjectId.get(`${hostId}\n${t3ProjectId}`);
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
    seenHostThreadKeys.add(compositeKey);
    const title = thread.title ?? projectThread?.title;
    const model = thread.model ?? projectThread?.model;
    activeSessions.push({
      threadId: thread.threadId,
      projectId,
      hostId,
      t3ProjectId,
      state,
      ...(title ? { title } : {}),
      ...(thread.link ? { link: thread.link } : {}),
      ...(model ? { model: model } : {}),
      ...(thread.updatedAt ? { updatedAt: thread.updatedAt } : {}),
    });
  }

  const umbrellaChildren = await deps.store.listAllAgentRunChildren();

  return {
    runs,
    activeSessions,
    umbrellaChildren,
  };
}

/** The child's latest checkpoint: checkpoints are ordered by step index, so the last is the latest step. */
async function latestCheckpoint(storage: StorageProvider, taskId: string): Promise<Checkpoint | undefined> {
  return (await storage.getCheckpoints(taskId)).at(-1);
}

async function publishRun(deps: T3ServiceDeps, run: AgentRun | undefined): Promise<void> {
  if (run && deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run }).catch(() => undefined);
  }
}

async function publishRunChild(deps: T3ServiceDeps, child: AgentRunChild | undefined): Promise<void> {
  if (child && deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run_child.updated", child }).catch(() => undefined);
  }
}

function selectCurrentBatchChildren(allChildren: readonly AgentRunChild[]): AgentRunChild[] {
  if (allChildren.length <= 1) return [...allChildren];
  const unmerged = allChildren.filter((child) => !child.mergedAt);
  const candidates = unmerged.length > 0 ? unmerged : allChildren;
  if (candidates.length <= 1) return [...candidates];
  const sorted = [...candidates].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const batches: AgentRunChild[][] = [];
  let currentBatch: AgentRunChild[] = [];
  let maxFinishedMs = -Infinity;

  for (const child of sorted) {
    const startedMs = Date.parse(child.startedAt);
    const currentBatchAllMerged =
      currentBatch.length > 0 && currentBatch.every((existing) => Boolean(existing.mergedAt));
    if (
      currentBatch.length > 0 &&
      ((currentBatchAllMerged && !child.mergedAt) ||
        (Number.isFinite(maxFinishedMs) && startedMs > maxFinishedMs))
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      maxFinishedMs = -Infinity;
    }
    currentBatch.push(child);
    if (child.finishedAt) {
      const finMs = Date.parse(child.finishedAt);
      if (Number.isFinite(finMs) && finMs > maxFinishedMs) {
        maxFinishedMs = finMs;
      }
    } else {
      maxFinishedMs = Infinity;
    }
  }
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }
  return batches.at(-1) ?? [...candidates];
}

type AgentRunChildEndState = Exclude<AgentRunChildState, "running">;

async function buildBatchChildHandbackItem(
  deps: T3ServiceDeps,
  childRow: AgentRunChild,
  stopReasonByChildId?: ReadonlyMap<string, string>,
): Promise<T3SubagentBatchHandbackChildItem | undefined> {
  const child = await deps.storage.getTask(childRow.childTaskId);
  if (!child) return undefined;
  const [childLabel, checkpoint, comments, childRun, childProfile] = await Promise.all([
    labelTask(deps.storage, child),
    latestCheckpoint(deps.storage, child.id),
    deps.storage.getComments(child.id),
    deps.store.getAgentRunByTaskId(child.id),
    deps.store.getTaskRunProfile(child.id),
  ]);
  const finalComment = comments.findLast(
    (comment) => comment.authorType === "agent" && comment.author !== T3_BITIG_COMMENT_AUTHOR,
  );
  const gitMetadata: T3GitMetadata = {
    ...(childRow.branch !== undefined
      ? { branch: childRow.branch }
      : childRun?.branch !== undefined
        ? { branch: childRun.branch }
        : {}),
    ...(childRow.headSha !== undefined
      ? { headSha: childRow.headSha }
      : childRun?.headSha !== undefined
        ? { headSha: childRun.headSha }
        : {}),
    ...(childRun?.worktreePath !== undefined ? { worktreePath: childRun.worktreePath } : {}),
    ...(childRun?.dirty !== undefined ? { dirty: childRun.dirty } : {}),
    ...(childRun?.uncommittedChanges !== undefined ? { uncommittedChanges: childRun.uncommittedChanges } : {}),
    ...(childRun?.changedPaths !== undefined ? { changedPaths: childRun.changedPaths } : {}),
    ...(childRun?.diffStat !== undefined ? { diffStat: childRun.diffStat } : {}),
    ...(childRun?.pullRequestUrls !== undefined ? { pullRequestUrls: childRun.pullRequestUrls } : {}),
  };
  const hasGitMetadata = Object.keys(gitMetadata).length > 0;
  const actualPaths = [
    ...(childRun?.changedPaths ?? []),
    ...(checkpoint?.stateSnapshot.modifiedArtifacts ?? []),
  ];
  const outOfBoundsPaths = findOutOfBoundsPaths(childProfile?.touches, actualPaths);

  let state: AgentRunChildEndState;
  if (FINISHED_TASK_STATUSES.has(child.status)) {
    state = "done";
  } else if (childRow.state === "needs_human" || Boolean(child.needsHuman)) {
    state = "needs_human";
  } else if (childRow.state === "failed" || childRun?.state === "failed") {
    state = "failed";
  } else {
    state = "stopped";
  }

  const explicitReason = stopReasonByChildId?.get(child.id);
  const stopReason =
    state === "done"
      ? undefined
      : explicitReason ?? (state === "needs_human" && child.needsHuman ? child.needsHuman : undefined);

  return {
    childLabel,
    child,
    state,
    ...(checkpoint ? { checkpoint } : {}),
    ...(finalComment ? { finalComment } : {}),
    ...(hasGitMetadata ? { gitMetadata } : {}),
    ...(stopReason ? { stopReason } : {}),
    ...(childProfile?.touches && childProfile.touches.length > 0
      ? { declaredTouches: childProfile.touches }
      : {}),
    ...(outOfBoundsPaths.length > 0 ? { outOfBoundsPaths } : {}),
  };
}

/**
 * Ensures any legacy `waitingForTaskId` on `parentRun` is mirrored into `agent_run_children` so
 * existing single-child umbrella waits and multi-child batch waits share one codepath (#BIT-189).
 */
async function ensureParentChildRows(
  deps: T3ServiceDeps,
  parentRun: AgentRun,
  now: number,
): Promise<AgentRunChild[]> {
  let children = await deps.store.listAgentRunChildren(parentRun.taskId);
  if (
    parentRun.waitingForTaskId &&
    !children.some((c) => c.childTaskId === parentRun.waitingForTaskId)
  ) {
    await deps.store.addAgentRunChild({
      parentTaskId: parentRun.taskId,
      childTaskId: parentRun.waitingForTaskId,
      state: "running",
      startedAt: now,
    });
    children = await deps.store.listAgentRunChildren(parentRun.taskId);
  }
  return children;
}

/**
 * Transitions `childTaskId` to `endState` in `agent_run_children` (and reconciles any siblings
 * whose tasks have already finished or whose sessions have ended), then checks whether every
 * running child of `parentTaskId` has ended (#BIT-189).
 *
 * - While any sibling is still `running`, the umbrella session stays in `waiting_subagent` (pointing
 *   `waitingForTaskId` at the next running child) and is NOT resumed yet.
 * - Once the last running child of the batch ends, the umbrella's wait is claimed and its T3 thread
 *   is resumed once with a single message summarizing every child in the batch.
 */
async function transitionChildAndMaybeResumeUmbrella(
  deps: T3ServiceDeps,
  input: {
    parentTaskId: string;
    childTaskId: string;
    endState: AgentRunChildEndState;
    stopReason?: string | undefined;
  },
): Promise<boolean> {
  if (!deps.encryptionKey) return false;
  const now = deps.now ? deps.now() : Date.now();
  const parentRun = await deps.store.getAgentRunByTaskId(input.parentTaskId);
  if (!parentRun) return false;

  const initialChildren = await ensureParentChildRows(deps, parentRun, now);
  if (initialChildren.length === 0) return false;

  // Claim or update the target child row if it is currently running.
  const targetRow = initialChildren.find((c) => c.childTaskId === input.childTaskId);
  if (!targetRow) return false;
  const childRunForGit = await deps.store.getAgentRunByTaskId(input.childTaskId);
  if (targetRow.state === "running") {
    const claimedTarget = await deps.store.claimAgentRunChild(input.parentTaskId, input.childTaskId, {
      state: input.endState,
      ...(childRunForGit?.branch !== undefined ? { branch: childRunForGit.branch } : {}),
      ...(childRunForGit?.headSha !== undefined ? { headSha: childRunForGit.headSha } : {}),
      now,
    });
    await publishRunChild(deps, claimedTarget);
  }

  // Reconcile any other running children that have also finished or ended concurrently.
  for (const sibling of initialChildren) {
    if (sibling.childTaskId === input.childTaskId || sibling.state !== "running") continue;
    const [sibTask, sibRun] = await Promise.all([
      deps.storage.getTask(sibling.childTaskId),
      deps.store.getAgentRunByTaskId(sibling.childTaskId),
    ]);
    let sibEndState: AgentRunChildEndState | undefined;
    if (!sibTask || FINISHED_TASK_STATUSES.has(sibTask.status)) {
      sibEndState = "done";
    } else if (sibTask.needsHuman) {
      sibEndState = "needs_human";
    } else if (sibRun && ENDED_CHILD_RUN_STATES.has(sibRun.state)) {
      sibEndState = sibRun.state === "failed" ? "failed" : "stopped";
    }
    if (sibEndState) {
      const claimedSibling = await deps.store.claimAgentRunChild(input.parentTaskId, sibling.childTaskId, {
        state: sibEndState,
        ...(sibRun?.branch !== undefined ? { branch: sibRun.branch } : {}),
        ...(sibRun?.headSha !== undefined ? { headSha: sibRun.headSha } : {}),
        now,
      });
      await publishRunChild(deps, claimedSibling);
    }
  }

  const allChildren = await deps.store.listAgentRunChildren(input.parentTaskId);
  const stillRunning = allChildren.filter((c) => c.state === "running");
  if (stillRunning.length > 0) {
    // Keep the umbrella waiting on the remaining running sibling(s).
    await syncParentWaitingSubagentState(deps, input.parentTaskId, now);
    return false;
  }

  const currentParentRun = (await deps.store.getAgentRunByTaskId(input.parentTaskId)) ?? parentRun;
  const parentTask = await deps.storage.getTask(input.parentTaskId);
  if (!parentTask || FINISHED_TASK_STATUSES.has(parentTask.status)) {
    if (currentParentRun.waitingForTaskId) {
      const dropped = await deps.store.claimAgentRunWaitingFor(
        input.parentTaskId,
        currentParentRun.waitingForTaskId,
        { state: "finished", now },
      );
      await publishRun(deps, dropped);
    }
    return false;
  }

  // Claim the umbrella's wait so concurrent endings of the last two children only resume once.
  const waitingChildId = currentParentRun.waitingForTaskId;
  let claimed: AgentRun | undefined;
  if (waitingChildId) {
    claimed = await deps.store.claimAgentRunWaitingFor(input.parentTaskId, waitingChildId, {
      state: "working",
      now,
    });
    if (!claimed) {
      return false;
    }
  } else {
    claimed = await deps.store.updateAgentRunState(input.parentTaskId, { state: "working", now });
    if (!claimed) {
      return false;
    }
  }

  const batchRows = selectCurrentBatchChildren(allChildren);
  const stopReasonByChildId = new Map<string, string>();
  if (input.stopReason) {
    stopReasonByChildId.set(input.childTaskId, input.stopReason);
  }
  const parentLabel = await labelTask(deps.storage, parentTask);
  const childItems: T3SubagentBatchHandbackChildItem[] = [];
  for (const row of batchRows) {
    const item = await buildBatchChildHandbackItem(deps, row, stopReasonByChildId);
    if (item) {
      childItems.push(item);
    }
  }
  if (childItems.length === 0) {
    await publishRun(deps, claimed);
    return false;
  }
  childItems.sort((a, b) => compareTasks(a.child, b.child));

  const batchInput = {
    parentLabel,
    children: childItems,
  };
  const comment = buildT3SubagentBatchHandbackComment(batchInput);
  const prompt = buildT3SubagentBatchHandbackPrompt(batchInput);

  const parentHostId = await resolveOriginatingTaskHostId(deps, input.parentTaskId, claimed);
  try {
    const mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      hostId: parentHostId,
      fetchFn: deps.fetchFn,
      now,
    });
    await mcpClient.sendThreadMessage({ threadId: claimed.threadId, prompt });
  } catch (err) {
    // Restore the child row and waitingForTaskId so a later live-status check retries when T3 reconnects.
    await deps.store.updateAgentRunChild(input.parentTaskId, input.childTaskId, {
      state: "running",
      finishedAt: null,
      now,
    });
    const restored = await deps.store.setAgentRunWaitingFor(input.parentTaskId, {
      childTaskId: input.childTaskId,
      now,
    });
    await publishRun(deps, restored);
    const childLabels = childItems.map((c) => c.childLabel).join(", ");
    throw new Error(`resuming the T3 session of ${parentLabel} after ${childLabels}`, { cause: err });
  }

  await publishRun(deps, claimed);
  await deps.storage.addComment(
    { taskId: parentTask.id, body: comment, authorType: "agent", author: T3_BITIG_COMMENT_AUTHOR },
    { actor: T3_BITIG_COMMENT_AUTHOR },
  );
  return claimed.state === "working";
}

async function listWaitingParentIdsForChild(deps: T3ServiceDeps, childTaskId: string): Promise<string[]> {
  const [parentRows, waitingRuns] = await Promise.all([
    deps.store.listAgentRunParentsForChild(childTaskId),
    deps.store.listAgentRunsWaitingFor(childTaskId),
  ]);
  const parentIds = new Set<string>();
  for (const row of parentRows) {
    parentIds.add(row.parentTaskId);
  }
  for (const run of waitingRuns) {
    parentIds.add(run.taskId);
  }
  return [...parentIds];
}

/**
 * Hands a finished child task back to the umbrella sessions waiting on it (#BIT-141, #BIT-189):
 * transitions the child in `agent_run_children` to `done` and, once every running child in the
 * umbrella's batch has ended, records their results on the umbrella task, sends them to its T3
 * thread, and moves its run back to `working`.
 */
export async function handBackCompletedChildTask(deps: T3ServiceDeps, childTaskId: string): Promise<number> {
  if (!deps.encryptionKey) return 0;
  const parentIds = await listWaitingParentIdsForChild(deps, childTaskId);
  if (parentIds.length === 0) return 0;
  const child = await deps.storage.getTask(childTaskId);
  if (!child || !FINISHED_TASK_STATUSES.has(child.status)) return 0;

  let resumed = 0;
  for (const parentTaskId of parentIds) {
    const didResume = await transitionChildAndMaybeResumeUmbrella(deps, {
      parentTaskId,
      childTaskId: child.id,
      endState: "done",
    });
    if (didResume) resumed += 1;
  }
  return resumed;
}

/**
 * Marks a child task that set `needsHuman` as ended (`needs_human`) in `agent_run_children` (#BIT-189).
 * Running siblings continue unaffected; once every child of the batch has ended, the umbrella is
 * resumed with all children's results.
 */
export async function handBackNeedsHumanChildTask(deps: T3ServiceDeps, childTaskId: string): Promise<number> {
  if (!deps.encryptionKey) return 0;
  const parentIds = await listWaitingParentIdsForChild(deps, childTaskId);
  if (parentIds.length === 0) return 0;
  const child = await deps.storage.getTask(childTaskId);
  if (!child?.needsHuman) return 0;

  let resumed = 0;
  for (const parentTaskId of parentIds) {
    const didResume = await transitionChildAndMaybeResumeUmbrella(deps, {
      parentTaskId,
      childTaskId: child.id,
      endState: "needs_human",
      stopReason: child.needsHuman,
    });
    if (didResume) resumed += 1;
  }
  return resumed;
}

/**
 * Tells the umbrella sessions waiting on a child task that the child's session failed or stopped
 * before the task was done (#BIT-141, #BIT-189), so they do not wait forever. A child task that is
 * finished after all is handed back as completed instead; one with `needsHuman` set is recorded as
 * `needs_human`.
 */
async function handBackEndedChildRun(
  deps: T3ServiceDeps,
  childRun: AgentRun,
  stopReason?: string,
): Promise<number> {
  const state = childRun.state === "failed" || childRun.state === "stopped" ? childRun.state : undefined;
  if (!state || !deps.encryptionKey) return 0;
  const parentIds = await listWaitingParentIdsForChild(deps, childRun.taskId);
  if (parentIds.length === 0) return 0;
  const child = await deps.storage.getTask(childRun.taskId);
  if (!child) return 0;
  if (FINISHED_TASK_STATUSES.has(child.status)) {
    return handBackCompletedChildTask(deps, child.id);
  }
  if (child.needsHuman && state === "stopped") {
    return handBackNeedsHumanChildTask(deps, child.id);
  }

  let resumed = 0;
  for (const parentTaskId of parentIds) {
    const didResume = await transitionChildAndMaybeResumeUmbrella(deps, {
      parentTaskId,
      childTaskId: child.id,
      endState: state,
      stopReason,
    });
    if (didResume) resumed += 1;
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
  stopReason?: string,
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
 * The state to store for a run whose thread T3 reports as `liveState` (#BIT-141, #BIT-189). An
 * umbrella session that waits on child tasks is idle on T3 (`finished`), but stays
 * `waiting_subagent` while any child in the batch is in progress with an active session. When all
 * children in the batch have finished, set `needsHuman`, or failed/stopped, the umbrella session is
 * handed the batch's context instead: this also retries a handback that failed earlier because T3
 * could not be reached.
 */
async function resolveUmbrellaRunState(
  deps: T3ServiceDeps,
  run: AgentRun,
  liveState: AgentRunState,
): Promise<AgentRunState> {
  if (liveState !== "finished") return liveState;
  const now = deps.now ? deps.now() : Date.now();
  const latestRun = (await deps.store.getAgentRunByTaskId(run.taskId)) ?? run;
  const children = await ensureParentChildRows(deps, latestRun, now);
  const runningRows = children.filter((c) => c.state === "running");
  if (runningRows.length === 0 && !latestRun.waitingForTaskId) {
    return liveState;
  }

  let anyStillActive = false;
  let lastEndedChildId: string | undefined;
  let lastEndedChildState: AgentRunChildEndState | undefined;

  for (const row of runningRows) {
    const child = await deps.storage.getTask(row.childTaskId);
    if (!child) {
      await deps.store.claimAgentRunChild(run.taskId, row.childTaskId, { state: "stopped", now });
      lastEndedChildId = row.childTaskId;
      lastEndedChildState = "stopped";
      continue;
    }
    const childRun = await deps.store.getAgentRunByTaskId(child.id);
    const childFinished = FINISHED_TASK_STATUSES.has(child.status);
    const childNeedsHuman = Boolean(child.needsHuman);
    const childRunEnded = Boolean(childRun && ENDED_CHILD_RUN_STATES.has(childRun.state));

    if (!childFinished && !childNeedsHuman && !childRunEnded) {
      if (child.status === "in_progress" && childRun && isActiveAgentRunState(childRun.state)) {
        anyStillActive = true;
      }
      continue;
    }

    lastEndedChildId = child.id;
    lastEndedChildState = childFinished
      ? "done"
      : childNeedsHuman
        ? "needs_human"
        : childRun?.state === "failed"
          ? "failed"
          : "stopped";
  }

  if (anyStillActive) {
    await syncParentWaitingSubagentState(deps, run.taskId, now);
    return "waiting_subagent";
  }

  const triggerChildId = lastEndedChildId ?? run.waitingForTaskId;
  if (!triggerChildId) {
    return liveState;
  }

  try {
    const triggerTask = await deps.storage.getTask(triggerChildId);
    const triggerRun = await deps.store.getAgentRunByTaskId(triggerChildId);
    if (triggerTask && FINISHED_TASK_STATUSES.has(triggerTask.status)) {
      await handBackCompletedChildTask(deps, triggerTask.id);
    } else if (triggerTask?.needsHuman) {
      await handBackNeedsHumanChildTask(deps, triggerTask.id);
    } else if (triggerRun && ENDED_CHILD_RUN_STATES.has(triggerRun.state)) {
      await handBackEndedChildRun(deps, triggerRun);
    } else if (lastEndedChildState) {
      await transitionChildAndMaybeResumeUmbrella(deps, {
        parentTaskId: run.taskId,
        childTaskId: triggerChildId,
        endState: lastEndedChildState,
      });
    }
  } catch (error) {
    console.error("handing child task batch back to its umbrella T3 session failed", {
      taskId: run.taskId,
      childTaskId: triggerChildId,
      error,
    });
  }
  return (await deps.store.getAgentRunByTaskId(run.taskId))?.state ?? liveState;
}

/** Run states in which a thread cannot be settled on archive because it is offline or not yet launched. */
const SETTLE_SKIPPED_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["offline", "queued"]);

/** Shown as the comment author in the T3 prompt when the comment has no explicit author. */
const DEFAULT_COMMENT_AUTHOR_LABEL = "a person";

async function resolveCommentAttachments(
  storage: StorageProvider,
  taskId: string,
  body: string,
): Promise<T3CommentAttachmentInfo[]> {
  const refs = extractCommentAttachmentReferences(body);
  if (refs.length === 0) return [];
  try {
    const taskAttachments = await storage.getAttachments(taskId);
    const byId = new Map(taskAttachments.map((att) => [att.id, att]));
    return refs.map((ref) => byId.get(ref.id) ?? ref);
  } catch {
    return refs;
  }
}

/** Builds the follow-up prompt a T3 agent receives for a new comment on its task. */
export function buildT3CommentPrompt(input: {
  taskLabel: string;
  author: string;
  body: string;
  attachments?: readonly T3CommentAttachmentInfo[] | undefined;
}): string {
  const attachmentContext = formatT3CommentAttachmentContext(input.body, input.attachments);
  const base = `New comment on ${input.taskLabel} from ${input.author}:\n\n${input.body}`;
  return attachmentContext ? `${base}\n\n${attachmentContext}` : base;
}

export interface ForwardCommentToT3Options {
  /**
   * Whether an explicit `/t3 run` command in this comment is permitted to start a new T3 run (#BIT-166).
   * Must only be true when the caller is an authenticated human session (never MCP or an agent header).
   */
  readonly allowCommandLaunch?: boolean | undefined;
  readonly actor?: string | undefined;
}

/**
 * Forwards a person's comment to the task's T3 thread so a waiting agent continues with it,
 * or launches a new T3 run when an authenticated human comment starts with `/t3 run` on an
 * approved, unblocked task with no active run (#BIT-166).
 *
 * When the T3 host is offline or the task's run is already queued, follow-up comment prompts are
 * durably queued in D1 and dispatched once on reconnect (#BIT-161).
 * Agent comments are never forwarded and never launch a run.
 */
export async function forwardCommentToT3Run(
  deps: T3ServiceDeps,
  comment: Comment,
  options?: ForwardCommentToT3Options,
): Promise<boolean> {
  if (comment.authorType !== "human") return false;
  if (!deps.encryptionKey) return false;

  const existingRun = await deps.store.getAgentRunByTaskId(comment.taskId);
  const command = parseT3RunCommentCommand(comment.body);
  if (command !== null) {
    if (options?.allowCommandLaunch === false) return false;
    if (existingRun && isActiveAgentRunState(existingRun.state)) return false;

    await launchTaskInT3(deps, {
      taskRef: comment.taskId,
      workspaceStrategy: command.workspaceStrategy,
      providerInstanceId: command.providerInstanceId,
      model: command.model,
      level: command.level,
      runtimeMode: command.runtimeMode,
      actor: options?.actor ?? comment.author ?? DEFAULT_COMMENT_AUTHOR_LABEL,
      requireActiveConnection: true,
    });
    return true;
  }

  if (!existingRun) return false;
  const targetHostId = await resolveOriginatingTaskHostId(deps, comment.taskId, existingRun);
  if (!(await deps.store.getConnection(targetHostId))) return false;

  const task = await deps.storage.getTask(comment.taskId);
  if (!task) {
    throw new NotFoundError("task", comment.taskId);
  }
  const [project, attachments] = await Promise.all([
    deps.storage.getProject(task.projectId),
    resolveCommentAttachments(deps.storage, task.id, comment.body),
  ]);
  const taskLabel = taskCode(task, project ?? undefined) ?? `"${task.title}"`;
  const prompt = buildT3CommentPrompt({
    taskLabel,
    author: comment.author ?? DEFAULT_COMMENT_AUTHOR_LABEL,
    body: comment.body,
    attachments,
  });

  const now = deps.now ? deps.now() : Date.now();
  const requestId = defaultIdGenerator();
  const payload: QueuedMessagePayload = {
    ...(targetHostId ? { hostId: targetHostId } : {}),
    prompt,
    clientRequestId: `${comment.id}:${requestId}`,
    taskLabel,
  };

  await deps.store.requests.enqueue({
    id: requestId,
    hostId: targetHostId,
    taskId: comment.taskId,
    kind: "message",
    payload: JSON.stringify(payload),
    now,
  });

  const dispatched = await dispatchQueuedTaskT3Run(deps, comment.taskId);
  if (!dispatched.dispatched && dispatched.run && deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: dispatched.run }).catch(() => undefined);
  }
  return true;
}

/**
 * Marks the task's T3 thread as settled (`t3_thread_organize` with `action: "settle"`)
 * when a task is archived (#BIT-117). Returns whether the thread was settled; it is skipped
 * when T3 is not configured, the task has no run, or the run is offline or queued.
 */
export async function settleTaskT3Run(deps: T3ServiceDeps, taskId: string): Promise<boolean> {
  if (!deps.encryptionKey) return false;

  const existingRun = await deps.store.getAgentRunByTaskId(taskId);
  if (!existingRun) return false;
  if (SETTLE_SKIPPED_STATES.has(existingRun.state) || existingRun.threadId.startsWith("queued:")) return false;

  const now = deps.now ? deps.now() : Date.now();
  const targetHostId = await resolveOriginatingTaskHostId(deps, taskId, existingRun);
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: targetHostId,
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
  const targetHostId = await resolveOriginatingTaskHostId(deps, taskId, existingRun);
  const hasQueuedLaunchOnly = existingRun.threadId.startsWith("queued:");
  await deps.store.requests.cancel(taskId, now);

  if (!hasQueuedLaunchOnly) {
    let mcpClient: T3McpClient | undefined;
    try {
      mcpClient = await createActiveT3McpClient({
        store: deps.store,
        encryptionKey: deps.encryptionKey,
        hostId: targetHostId,
        fetchFn: deps.fetchFn,
        now,
      });
    } catch (err) {
      if (existingRun.state !== "queued" || !isQueueableT3Error(err)) {
        throw err;
      }
      mcpClient = undefined;
    }

    if (mcpClient) {
      try {
        await mcpClient.interruptThread(existingRun.threadId);
      } catch (err) {
        if (existingRun.state !== "queued" || !isQueueableT3Error(err)) {
          throw err;
        }
      }
    }
  }

  // A person stopping an umbrella session also ends its wait on any running child tasks (#BIT-141, #BIT-189).
  const parentChildren = await deps.store.listAgentRunChildren(taskId);
  for (const child of parentChildren) {
    if (child.state === "running") {
      const claimed = await deps.store.claimAgentRunChild(taskId, child.childTaskId, { state: "stopped", now });
      await publishRunChild(deps, claimed);
    }
  }

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

export interface StartReadyChildrenInput {
  parentTaskRef: string;
  max?: number | undefined;
  actor: string;
}

export interface StartedReadyChildSummary {
  taskId: string;
  code?: string | undefined;
  title: string;
  threadId: string;
  link?: string | undefined;
  state: AgentRunState;
  queued: boolean;
  workspaceStrategy: T3WorkspaceStrategy;
  providerInstanceId?: string | undefined;
  model?: string | undefined;
  level?: string | undefined;
}

export interface SkippedReadyChildSummary {
  taskId: string;
  code?: string | undefined;
  title: string;
  reason: ParallelSkipReason;
  detail: string;
  blockingTaskId?: string | undefined;
  blockingTaskCode?: string | undefined;
  overlappingPath?: string | undefined;
}

export interface StartReadyChildrenResult {
  started: StartedReadyChildSummary[];
  skipped: SkippedReadyChildSummary[];
}

function extractEffortFromOptions(
  options: readonly T3ModelSelectionOption[] | undefined,
): string | undefined {
  if (!options) return undefined;
  const opt = options.find(
    (item) => item.id === "effort" || item.id === "reasoningEffort" || item.id === "thinkingEffort",
  );
  return typeof opt?.value === "string" ? opt.value : undefined;
}

interface EvaluatedUmbrellaChildren {
  readonly parentTask: Task;
  readonly projectById: ReadonlyMap<string, Project>;
  readonly picked: readonly ParallelBatchCandidate[];
  readonly skipped: SkippedReadyChildSummary[];
  readonly status: UmbrellaChildrenStatusResponse;
}

async function evaluateUmbrellaChildren(
  deps: T3ServiceDeps,
  parentTaskRef: string,
  options?: { max?: number | undefined; hostId?: string | undefined },
): Promise<EvaluatedUmbrellaChildren> {
  const now = deps.now ? deps.now() : Date.now();
  const parentTaskId = await resolveTaskRef(deps.storage, parentTaskRef);
  const parentTask = await deps.storage.getTask(parentTaskId);
  if (!parentTask) {
    throw new NotFoundError("task", parentTaskId);
  }
  const [parentLabel, parentRun, mapping, activeRunning] = await Promise.all([
    labelTask(deps.storage, parentTask),
    deps.store.getAgentRunByTaskId(parentTask.id),
    deps.store.getProjectMapping(parentTask.projectId),
    listActiveRunningChildren(deps, parentTask.id, now),
  ]);

  let launchReadiness: UmbrellaLaunchReadiness;
  if (FINISHED_TASK_STATUSES.has(parentTask.status)) {
    launchReadiness = {
      ready: false,
      reason: `Umbrella task ${parentLabel} is already ${parentTask.status} and cannot launch child sessions.`,
    };
  } else if (!parentRun) {
    launchReadiness = {
      ready: false,
      reason: `Umbrella task ${parentLabel} has no T3 session.`,
    };
  } else if (ENDED_CHILD_RUN_STATES.has(parentRun.state)) {
    launchReadiness = {
      ready: false,
      reason: `Umbrella task ${parentLabel}'s T3 session is ${parentRun.state}; only an active umbrella session can start child tasks.`,
    };
  } else {
    const gitIssue = getUmbrellaParentGitReadinessIssue(parentRun, parentLabel);
    launchReadiness = gitIssue ? { ready: false, reason: gitIssue } : { ready: true };
  }

  const targetHostId = options?.hostId ?? parentRun?.hostId ?? mapping?.hostId;
  const [
    allTasks,
    allProjects,
    parentComments,
    projectSettings,
    childRows,
    parentRowsForSelf,
    allRuns,
    allRunChildren,
    allProfiles,
    levels,
  ] = await Promise.all([
    deps.storage.getTasks(),
    deps.storage.getProjects(),
    deps.storage.getComments(parentTask.id),
    deps.store.getProjectRunSettings(parentTask.projectId),
    deps.store.listAgentRunChildren(parentTask.id),
    deps.store.listAgentRunParentsForChild(parentTask.id),
    deps.store.listAgentRuns(),
    deps.store.listAllAgentRunChildren(),
    deps.store.listTaskRunProfiles(),
    deps.store.listRunLevels({ ...(targetHostId ? { hostId: targetHostId } : {}), now }),
  ]);

  const projectById = new Map(allProjects.map((p) => [p.id, p]));
  const taskById = new Map(allTasks.map((t) => [t.id, t]));
  const childRowById = new Map(childRows.map((row) => [row.childTaskId, row]));
  const runByTaskId = new Map(allRuns.map((r) => [r.taskId, r]));
  const profileByTaskId = new Map(allProfiles.map((p) => [p.taskId, p]));
  const levelsByKey = new Map(levels.map((l) => [l.key, l]));

  const umbrellaIndex = buildUmbrellaIndex({
    tasks: allTasks,
    projects: allProjects,
    runs: allRuns,
    runChildren: allRunChildren,
  });

  const parentsOfSelf = new Set<string>(parentRowsForSelf.map((row) => row.parentTaskId));
  if (parentRun?.parentTaskId) {
    parentsOfSelf.add(parentRun.parentTaskId);
  }
  const siblingsUnderSharedParent = new Set<string>();
  for (const candidateParent of allTasks) {
    if (candidateParent.id === parentTask.id) continue;
    const candidateChildren = umbrellaIndex.childrenFor(candidateParent.id);
    if (candidateChildren.some((c) => c.id === parentTask.id)) {
      parentsOfSelf.add(candidateParent.id);
      for (const sibling of candidateChildren) {
        if (sibling.id !== parentTask.id) {
          siblingsUnderSharedParent.add(sibling.id);
        }
      }
    }
  }
  const ownDependencies = new Set(parentTask.dependsOn ?? []);

  const mentionIndex = buildMentionIndex(allTasks, allProjects);
  const mentionedIds = new Set(
    mentionIndex
      .linksFor(parentTask, parentComments)
      .mentions.map((m) => m.id)
      .filter(
        (id) =>
          !ownDependencies.has(id) &&
          !parentsOfSelf.has(id) &&
          !siblingsUnderSharedParent.has(id),
      ),
  );

  // All child tasks under this umbrella (finished, active, or waiting), sorted in task order.
  const allChildTasks = allTasks
    .filter((t) => {
      if (t.id === parentTask.id) return false;
      if (childRowById.has(t.id) || runByTaskId.get(t.id)?.parentTaskId === parentTask.id) {
        return true;
      }
      if (parentsOfSelf.has(t.id) || siblingsUnderSharedParent.has(t.id)) return false;
      if (mentionedIds.has(t.id)) return true;
      if ((t.dependsOn ?? []).includes(parentTask.id)) {
        const candidateRunParent = runByTaskId.get(t.id)?.parentTaskId;
        if (candidateRunParent && candidateRunParent !== parentTask.id && parentsOfSelf.has(candidateRunParent)) {
          return false;
        }
        return true;
      }
      return false;
    })
    .sort(compareTasks);

  const openChildTasks = allChildTasks.filter((t) => !FINISHED_TASK_STATUSES.has(t.status));
  const runningSet = new Set(activeRunning.map((r) => r.id));
  const candidateTasks = openChildTasks.filter((t) => !runningSet.has(t.id));

  const codeOrTitle = (
    idOrCode: string,
  ): { id?: string | undefined; code?: string | undefined; title: string; label: string } => {
    const direct = taskById.get(idOrCode);
    if (direct) {
      const code = taskCode(direct, projectById.get(direct.projectId));
      return { id: direct.id, ...(code ? { code } : {}), title: direct.title, label: code ?? `"${direct.title}"` };
    }
    for (const t of allTasks) {
      const code = taskCode(t, projectById.get(t.projectId));
      if (code === idOrCode) {
        return { id: t.id, code, title: t.title, label: code };
      }
    }
    return { title: idOrCode, label: idOrCode };
  };

  const candidates: ParallelBatchCandidate[] = [];
  const alreadyActiveSkips: SkippedReadyChildSummary[] = [];

  for (const candidateTask of candidateTasks) {
    const code = taskCode(candidateTask, projectById.get(candidateTask.projectId));
    const existingChildRun = runByTaskId.get(candidateTask.id);
    if (existingChildRun && isActiveAgentRunState(existingChildRun.state)) {
      alreadyActiveSkips.push({
        taskId: candidateTask.id,
        ...(code ? { code } : {}),
        title: candidateTask.title,
        reason: "already_running",
        detail: `${code ?? candidateTask.title} already has an active T3 session (${existingChildRun.state}).`,
      });
      continue;
    }

    const blockedBy: string[] = [];
    for (const depId of candidateTask.dependsOn ?? []) {
      if (depId === parentTask.id) continue;
      const depTask = taskById.get(depId);
      if (depTask && !FINISHED_TASK_STATUSES.has(depTask.status)) {
        const depCode = taskCode(depTask, projectById.get(depTask.projectId));
        blockedBy.push(depCode ?? depId);
      }
    }

    candidates.push({
      id: candidateTask.id,
      ...(code ? { code } : {}),
      pendingApproval: Boolean(candidateTask.pendingApproval),
      blockedBy,
      profile: profileByTaskId.get(candidateTask.id),
    });
  }

  const projectCap = projectSettings?.maxParallelChildren ?? DEFAULT_MAX_PARALLEL_CHILDREN;
  const requestedMax =
    typeof options?.max === "number" && Number.isFinite(options.max) && options.max >= 1
      ? Math.floor(options.max)
      : undefined;
  const effectiveCap =
    requestedMax !== undefined ? Math.min(projectCap, activeRunning.length + requestedMax) : projectCap;

  const batchSelection = pickParallelBatch(candidates, {
    running: activeRunning,
    cap: effectiveCap,
    serialPaths: projectSettings?.serialPaths ?? [],
  });

  const skipped: SkippedReadyChildSummary[] = [
    ...alreadyActiveSkips,
    ...batchSelection.skipped.map((skip) => {
      const self = codeOrTitle(skip.taskId);
      const blocker = skip.blockingTask ? codeOrTitle(skip.blockingTask) : undefined;
      return {
        taskId: skip.taskId,
        ...(skip.code ? { code: skip.code } : self.code ? { code: self.code } : {}),
        title: self.title,
        reason: skip.reason,
        detail: skip.message,
        ...(blocker?.id ? { blockingTaskId: blocker.id } : {}),
        ...(blocker?.code
          ? { blockingTaskCode: blocker.code }
          : skip.blockingTask
            ? { blockingTaskCode: skip.blockingTask }
            : {}),
        ...(skip.blockingPath ? { overlappingPath: skip.blockingPath } : {}),
      };
    }),
  ];

  const pickedSet = new Set(batchSelection.picked.map((p) => p.id));
  const skippedByTaskId = new Map(skipped.map((s) => [s.taskId, s]));

  let runningCount = 0;
  let mergedCount = 0;
  let doneCount = 0;
  const children: UmbrellaChildItem[] = [];
  const readyBatchByTaskId = new Map<string, UmbrellaReadyBatchItem>();

  for (const childTask of allChildTasks) {
    const code = taskCode(childTask, projectById.get(childTask.projectId));
    const childRow = childRowById.get(childTask.id);
    const childRun = runByTaskId.get(childTask.id);
    const profile = profileByTaskId.get(childTask.id);
    const resolved = resolveRunSelection({
      profile,
      projectDefaultLevel: projectSettings?.defaultRunLevel,
      levels,
    });

    const levelKey = childRun?.levelKey ?? resolved.levelKey ?? profile?.level;
    const levelLabel = levelKey ? (levelsByKey.get(levelKey)?.label ?? levelKey) : undefined;
    const providerInstanceId = childRun?.providerInstanceId ?? resolved.selection?.providerInstanceId;
    const model = childRun?.model ?? resolved.selection?.model;
    const effort =
      extractEffortFromOptions(childRun?.modelOptions) ??
      extractEffortFromOptions(resolved.selection?.options) ??
      profile?.effort;
    const profileSource = childRun?.modelSource ?? resolved.source;

    const branch = childRow?.branch ?? childRun?.branch ?? undefined;
    const headSha = childRow?.headSha ?? childRun?.headSha ?? undefined;
    const diffStat = childRun?.diffStat ?? undefined;
    const merged = Boolean(childRow?.mergedAt ?? childRow?.mergedSha);
    const finishedTask = FINISHED_TASK_STATUSES.has(childTask.status);
    const isRunning =
      !finishedTask &&
      (runningSet.has(childTask.id) || Boolean(childRun && isActiveAgentRunState(childRun.state)));
    const isDone = finishedTask || childRow?.state === "done" || merged;

    if (isRunning) runningCount += 1;
    if (merged) mergedCount += 1;
    if (isDone) doneCount += 1;

    const inReadyBatch = pickedSet.has(childTask.id);
    const skipItem = skippedByTaskId.get(childTask.id);
    const waitingReason =
      !finishedTask && !isRunning && skipItem && skipItem.reason !== "already_running"
        ? {
            reason: skipItem.reason,
            detail: skipItem.detail,
            ...(skipItem.blockingTaskId ? { blockingTaskId: skipItem.blockingTaskId } : {}),
            ...(skipItem.blockingTaskCode ? { blockingTaskCode: skipItem.blockingTaskCode } : {}),
            ...(skipItem.overlappingPath ? { overlappingPath: skipItem.overlappingPath } : {}),
          }
        : undefined;

    children.push({
      taskId: childTask.id,
      ...(code ? { code } : {}),
      title: childTask.title,
      taskStatus: childTask.status,
      ...(childTask.pendingApproval !== undefined ? { pendingApproval: childTask.pendingApproval } : {}),
      ...(childTask.needsHuman !== undefined ? { needsHuman: childTask.needsHuman } : {}),
      ...(childRow?.state !== undefined ? { childState: childRow.state } : {}),
      ...(childRun?.state !== undefined ? { runState: childRun.state } : {}),
      isRunning,
      ...(childRun?.threadId !== undefined ? { threadId: childRun.threadId } : {}),
      ...(childRun?.link !== undefined ? { link: childRun.link } : {}),
      ...(levelKey !== undefined ? { levelKey } : {}),
      ...(levelLabel !== undefined ? { levelLabel } : {}),
      ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      profileSource,
      ...(profile?.touches !== undefined ? { touches: profile.touches } : {}),
      ...(profile?.parallelSafe !== undefined ? { parallelSafe: profile.parallelSafe } : {}),
      ...(branch !== undefined ? { branch } : {}),
      ...(headSha !== undefined ? { headSha } : {}),
      ...(diffStat !== undefined ? { diffStat } : {}),
      ...(childRun?.pullRequestUrls !== undefined ? { pullRequestUrls: childRun.pullRequestUrls } : {}),
      merged,
      ...(childRow?.mergedAt !== undefined ? { mergedAt: childRow.mergedAt } : {}),
      ...(childRow?.mergedSha !== undefined ? { mergedSha: childRow.mergedSha } : {}),
      ...(waitingReason !== undefined ? { waitingReason } : {}),
      inReadyBatch,
    });

    if (inReadyBatch) {
      readyBatchByTaskId.set(childTask.id, {
        taskId: childTask.id,
        ...(code ? { code } : {}),
        title: childTask.title,
        ...(levelKey !== undefined ? { levelKey } : {}),
        ...(levelLabel !== undefined ? { levelLabel } : {}),
        ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(profile?.touches !== undefined ? { touches: profile.touches } : {}),
      });
    }
  }

  const readyBatch = batchSelection.picked
    .map((p) => readyBatchByTaskId.get(p.id))
    .filter((item): item is UmbrellaReadyBatchItem => item !== undefined);

  return {
    parentTask,
    projectById,
    picked: batchSelection.picked,
    skipped,
    status: {
      parentTaskId: parentTask.id,
      children,
      progress: {
        total: children.length,
        running: runningCount,
        merged: mergedCount,
        done: doneCount,
      },
      readyBatch,
      maxParallelChildren: projectCap,
      launchReadiness,
    },
  };
}

/**
 * Returns the live status of all child tasks under an umbrella task, including resolved tier/model,
 * git metadata, merge state, skip reasons for waiting children, and the ready batch that
 * `startReadyChildrenInT3` would pick next (#BIT-191).
 */
export async function getUmbrellaChildrenStatus(
  deps: T3ServiceDeps,
  parentTaskRef: string,
  options?: { max?: number | undefined; hostId?: string | undefined },
): Promise<UmbrellaChildrenStatusResponse> {
  const evaluated = await evaluateUmbrellaChildren(deps, parentTaskRef, options);
  return evaluated.status;
}

/**
 * Picks the next parallel-safe batch of child tasks for an umbrella task (tasks the umbrella
 * mentions or that depend on it), starts them in T3 with `workspaceStrategy: "worktree"` and their
 * resolved run profiles, and returns what started and why the rest were skipped (#BIT-189, #BIT-190).
 */
export async function startReadyChildrenInT3(
  deps: T3ServiceDeps,
  input: StartReadyChildrenInput,
): Promise<StartReadyChildrenResult> {
  const evaluated = await evaluateUmbrellaChildren(deps, input.parentTaskRef, { max: input.max });
  if (!evaluated.status.launchReadiness.ready) {
    makeValidationIssue(
      "parentTaskId",
      evaluated.status.launchReadiness.reason ?? "Umbrella task is not ready to launch child sessions.",
    );
  }

  const started: StartedReadyChildSummary[] = [];
  for (const picked of evaluated.picked) {
    const launched = await launchTaskInT3(deps, {
      taskRef: picked.id,
      parentTaskRef: evaluated.parentTask.id,
      workspaceStrategy: "worktree",
      actor: input.actor,
    });
    const code = taskCode(launched.task, evaluated.projectById.get(launched.task.projectId));
    started.push({
      taskId: launched.task.id,
      ...(code ? { code } : {}),
      title: launched.task.title,
      threadId: launched.run.threadId,
      ...(launched.run.link ? { link: launched.run.link } : {}),
      state: launched.run.state,
      queued: launched.run.state === "queued",
      workspaceStrategy: "worktree",
      ...(launched.run.providerInstanceId ? { providerInstanceId: launched.run.providerInstanceId } : {}),
      ...(launched.run.model ? { model: launched.run.model } : {}),
      ...(launched.run.levelKey ? { level: launched.run.levelKey } : {}),
    });
  }

  return { started, skipped: evaluated.skipped };
}

/**
 * Stops every active child T3 session running under `parentTaskRef` in a single coordinated
 * batch transition (#BIT-191).
 */
export async function stopAllUmbrellaChildren(
  deps: T3ServiceDeps,
  parentTaskRef: string,
): Promise<StopUmbrellaChildrenResponse> {
  const now = deps.now ? deps.now() : Date.now();
  const parentTaskId = await resolveTaskRef(deps.storage, parentTaskRef);
  const parentTask = await deps.storage.getTask(parentTaskId);
  if (!parentTask) {
    throw new NotFoundError("task", parentTaskId);
  }

  const [childRows, allRuns] = await Promise.all([
    deps.store.listAgentRunChildren(parentTask.id),
    deps.store.listAgentRuns(),
  ]);

  const candidateChildIds = new Set<string>();
  for (const row of childRows) {
    if (row.state === "running") {
      candidateChildIds.add(row.childTaskId);
    }
  }
  for (const run of allRuns) {
    if (run.parentTaskId === parentTask.id && isActiveAgentRunState(run.state)) {
      candidateChildIds.add(run.taskId);
    }
  }

  const activeChildRuns: AgentRun[] = [];
  for (const childId of candidateChildIds) {
    const run = await deps.store.getAgentRunByTaskId(childId);
    if (run && isActiveAgentRunState(run.state)) {
      activeChildRuns.push(run);
    }
  }

  if (activeChildRuns.length === 0) {
    return { stoppedTaskIds: [] };
  }

  const stoppedPairs: { existing: AgentRun; updated: AgentRun }[] = [];

  for (const existingRun of activeChildRuns) {
    const hasQueuedLaunchOnly = existingRun.threadId.startsWith("queued:");
    await deps.store.requests.cancel(existingRun.taskId, now);
    if (!hasQueuedLaunchOnly && existingRun.state !== "offline") {
      const targetHostId = await resolveOriginatingTaskHostId(deps, existingRun.taskId, existingRun);
      let mcpClient: T3McpClient | undefined;
      try {
        mcpClient = await createActiveT3McpClient({
          store: deps.store,
          encryptionKey: deps.encryptionKey,
          hostId: targetHostId,
          fetchFn: deps.fetchFn,
          now,
        });
      } catch (err) {
        if (existingRun.state !== "queued" || !isQueueableT3Error(err)) {
          throw err;
        }
        mcpClient = undefined;
      }

      if (mcpClient) {
        try {
          await mcpClient.interruptThread(existingRun.threadId);
        } catch (err) {
          if (existingRun.state !== "queued" || !isQueueableT3Error(err)) {
            throw err;
          }
        }
      }
    }

    const updatedRun =
      (await deps.store.updateAgentRunState(existingRun.taskId, { state: "stopped", now })) ?? existingRun;
    if (deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: updatedRun }).catch(() => undefined);
    }
    stoppedPairs.push({ existing: existingRun, updated: updatedRun });
  }

  // Claim all except the final child row first so the final `afterRunStateChange` sees the full
  // batch ended and hands back once.
  for (let i = 0; i < stoppedPairs.length - 1; i++) {
    const pair = stoppedPairs[i];
    if (!pair) continue;
    const claimed = await deps.store.claimAgentRunChild(parentTask.id, pair.existing.taskId, {
      state: "stopped",
      ...(pair.updated.branch !== undefined ? { branch: pair.updated.branch } : {}),
      ...(pair.updated.headSha !== undefined ? { headSha: pair.updated.headSha } : {}),
      now,
    });
    await publishRunChild(deps, claimed);
  }

  const lastPair = stoppedPairs.at(-1);
  if (lastPair) {
    await afterRunStateChange(deps, lastPair.existing, lastPair.updated);
    const remainingRow = await deps.store.getAgentRunChild(parentTask.id, lastPair.existing.taskId);
    if (remainingRow?.state === "running") {
      const claimed = await deps.store.claimAgentRunChild(parentTask.id, lastPair.existing.taskId, {
        state: "stopped",
        ...(lastPair.updated.branch !== undefined ? { branch: lastPair.updated.branch } : {}),
        ...(lastPair.updated.headSha !== undefined ? { headSha: lastPair.updated.headSha } : {}),
        now,
      });
      await publishRunChild(deps, claimed);
    }
  }

  return {
    stoppedTaskIds: stoppedPairs.map((pair) => pair.existing.taskId),
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
  const targetHostId = await resolveOriginatingTaskHostId(deps, taskId, existingRun);
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: targetHostId,
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

async function capabilitiesCacheKey(connection: {
  orgId: string;
  id: string;
  mcpUrl: string;
  connectedAt: number;
  updatedAt: number;
}): Promise<Request> {
  // Hash so the cache key carries no T3 host details; scoped to orgId + hostId + token update time.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${connection.orgId}\n${connection.id}\n${connection.mcpUrl}\n${String(connection.connectedAt)}\n${String(connection.updatedAt)}`,
    ),
  );
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`${T3_CAPABILITIES_CACHE_ORIGIN}/${hex}`);
}

/**
 * Lists the models a connected T3 host offers (`orchestrator_capabilities`), reusing the list for
 * `T3_CAPABILITIES_CACHE_TTL_SECONDS` through the Workers Cache API when a cache is given. Scoped by
 * `orgId`, `hostId`, and connection timestamp so two hosts or two organisations never share a cache
 * entry. A cache failure only costs a fresh call to T3; it never fails the request.
 */
export async function listT3ModelCapabilities(
  deps: Pick<T3ServiceDeps, "store" | "encryptionKey" | "fetchFn"> & { hostId?: string | undefined },
  cache: Cache | undefined,
): Promise<T3ModelCapability[]> {
  const { connection, client: mcpClient } = await resolveActiveT3ConnectionAndClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: deps.hostId,
    fetchFn: deps.fetchFn,
  });
  const cacheKey = cache ? await capabilitiesCacheKey(connection) : undefined;

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
  /**
   * When true, settles the existing T3 thread and launches a fresh checkpoint-seeded T3 thread
   * for the follow-up reply instead of reusing the long-running thread (#BIT-165).
   */
  freshSession?: boolean | undefined;
  actor: string;
}

export interface ReplyToTaskT3RunResult {
  comment: Comment;
  /** The "Model switched from X to Y" comment, when the reply switched the thread's model. */
  switchComment?: Comment | undefined;
  run: AgentRun;
}

function extractPriorGitMetadata(run: AgentRun): T3GitMetadata | undefined {
  const metadata: T3GitMetadata = {
    ...(run.branch !== undefined ? { branch: run.branch } : {}),
    ...(run.headSha !== undefined ? { headSha: run.headSha } : {}),
    ...(run.diffStat !== undefined ? { diffStat: run.diffStat } : {}),
    ...(run.pullRequestUrls !== undefined ? { pullRequestUrls: run.pullRequestUrls } : {}),
  };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * A person's reply to a task's T3 thread (#BIT-119, #BIT-165, #BIT-161).
 *
 * Always routes to `existingRun.hostId` (the originating host where the task run lives) so
 * reattaching a project to another host never reroutes historical thread replies (#BIT-147).
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

  const targetHostId = await resolveOriginatingTaskHostId(deps, task.id, existingRun);
  const connection = await requireT3ConnectionForQueue({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: targetHostId,
  });
  const resolvedHostId = targetHostId ?? connection.id;

  const now = deps.now ? deps.now() : Date.now();
  let mcpClient: T3McpClient | undefined;
  try {
    mcpClient = await createActiveT3McpClient({
      store: deps.store,
      encryptionKey: deps.encryptionKey,
      hostId: resolvedHostId,
      fetchFn: deps.fetchFn,
      now,
    });
  } catch (err) {
    if (!isQueueableT3Error(err)) {
      throw err;
    }
    mcpClient = undefined;
  }

  if (input.freshSession) {
    if (mcpClient && !existingRun.threadId.startsWith("queued:")) {
      try {
        const live = await mcpClient.readThreadLiveStatus(existingRun.threadId);
        const liveState = deriveLiveAgentRunState({
          thread: live.thread,
          recentRuns: live.recentRuns,
          pendingRequestIds: live.pendingRequestIds,
        });
        const midTurn = Boolean(live.thread?.activeRunId) && liveState !== "waiting_for_approval";
        if (!canSwitchT3Model(liveState) || midTurn) {
          throw new T3ModelSwitchConflictError(midTurn ? "working" : liveState);
        }
      } catch (err) {
        if (!isQueueableT3Error(err)) {
          throw err;
        }
        mcpClient = undefined;
      }
    }

    let switchComment: Comment | undefined;
    let targetModel = existingRun.model;
    let targetProviderInstanceId = existingRun.providerInstanceId;
    let targetOptions: readonly T3ModelSelectionOption[] | undefined = existingRun.modelOptions;

    if (input.modelSelection) {
      const selection = input.modelSelection;
      let current: T3ModelSelection | undefined;
      if (mcpClient && !existingRun.threadId.startsWith("queued:")) {
        try {
          current = await mcpClient.readThreadModel(existingRun.threadId);
        } catch (err) {
          if (!isQueueableT3Error(err)) {
            throw err;
          }
          mcpClient = undefined;
        }
      }
      const known = current ?? storedT3ModelSelection(existingRun);
      targetModel = selection.model;
      targetProviderInstanceId = selection.providerInstanceId;
      targetOptions = selection.options;
      if (!known || !isSameT3ModelSelection(known, selection)) {
        const fromLabel = formatT3ModelSelection(
          known ?? { ...(existingRun.model ? { model: existingRun.model } : {}) },
        );
        const toLabel = formatT3ModelSelection(selection);
        switchComment = await deps.storage.addComment(
          {
            taskId: task.id,
            body: buildT3ModelSwitchComment(fromLabel, toLabel),
            authorType: "agent",
            author: T3_MODEL_SWITCH_COMMENT_AUTHOR,
          },
          { actor: input.actor },
        );
      }
    }

    const [project, priorComments, checkpoint, parentTask] = await Promise.all([
      deps.storage.getProject(task.projectId),
      deps.storage.getComments(task.id),
      latestCheckpoint(deps.storage, task.id),
      existingRun.parentTaskId ? deps.storage.getTask(existingRun.parentTaskId) : Promise.resolve(null),
    ]);
    const parentLabel = parentTask ? await labelTask(deps.storage, parentTask) : undefined;

    const comment = await deps.storage.addComment(
      {
        taskId: task.id,
        body: input.body,
        authorType: "human",
        ...(input.author ? { author: input.author } : {}),
      },
      { actor: input.actor },
    );

    const followUpAttachments = await resolveCommentAttachments(deps.storage, task.id, comment.body);
    const code = taskCode(task, project ?? undefined);
    const gitMetadataRunId = defaultIdGenerator();
    const priorGitMetadata = extractPriorGitMetadata(existingRun);
    const workspaceStrategy: T3WorkspaceStrategy = existingRun.workspaceStrategy ?? "worktree";
    const builtPrompt = buildT3LaunchPrompt({
      gitMetadataRunId,
      task,
      ...(code ? { taskCode: code } : {}),
      ...(project ? { projectName: project.name } : {}),
      comments: priorComments,
      ...(parentLabel ? { parentTaskCode: parentLabel } : {}),
      checkpoint: checkpoint ?? null,
      ...(priorGitMetadata ? { priorGitMetadata } : {}),
      followUpComment: {
        author: comment.author ?? DEFAULT_COMMENT_AUTHOR_LABEL,
        body: comment.body,
        ...(followUpAttachments.length > 0 ? { attachments: followUpAttachments } : {}),
      },
      clientRequestId: `${code ?? task.id}:${gitMetadataRunId}`,
    });

    await deps.store.requests.cancel(task.id, now);
    const launchPayload: QueuedLaunchPayload = {
      hostId: resolvedHostId,
      t3ProjectId: existingRun.t3ProjectId,
      title: builtPrompt.title,
      prompt: builtPrompt.prompt,
      clientRequestId: builtPrompt.clientRequestId,
      workspaceStrategy,
      ...(targetProviderInstanceId ? { providerInstanceId: targetProviderInstanceId } : {}),
      ...(targetModel ? { model: targetModel } : {}),
      ...(targetOptions ? { options: targetOptions } : {}),
      ...(!existingRun.threadId.startsWith("queued:") ? { settleThreadId: existingRun.threadId } : {}),
      ...(existingRun.parentTaskId ? { parentTaskId: existingRun.parentTaskId } : {}),
      actor: input.actor,
    };

    await deps.store.requests.enqueue({
      id: gitMetadataRunId,
      hostId: resolvedHostId,
      taskId: task.id,
      kind: "launch",
      payload: JSON.stringify(launchPayload),
      now,
      launch: {
        id: gitMetadataRunId,
        taskId: task.id,
        hostId: resolvedHostId,
        t3ProjectId: existingRun.t3ProjectId,
        threadId: `queued:${gitMetadataRunId}`,
        state: "queued",
        model: targetModel,
        ...(targetModel && targetProviderInstanceId ? { providerInstanceId: targetProviderInstanceId } : {}),
        modelOptions: targetOptions,
        workspaceStrategy,
        ...(existingRun.parentTaskId ? { parentTaskId: existingRun.parentTaskId } : {}),
        startedBy: input.actor,
        startedAt: now,
        updatedAt: now,
      },
    });

    if (mcpClient) {
      const dispatched = await dispatchQueuedTaskT3Run(deps, task.id, mcpClient);
      const finalRun = dispatched.run ?? (await deps.store.getAgentRunByTaskId(task.id));
      if (!finalRun) {
        throw new Error("Queued run was not persisted");
      }
      return {
        comment,
        ...(switchComment ? { switchComment } : {}),
        run: finalRun,
      };
    }

    const queuedRun = await deps.store.getAgentRunByTaskId(task.id);
    if (!queuedRun) {
      throw new Error("Queued run was not persisted");
    }
    if (deps.publishRealtime) {
      await deps.publishRealtime({ type: "agent_run.updated", run: queuedRun }).catch(() => undefined);
    }
    return {
      comment,
      ...(switchComment ? { switchComment } : {}),
      run: queuedRun,
    };
  }

  let run = existingRun;
  let switchedTo: string | undefined;
  let switchComment: Comment | undefined;
  let modelSelectionToQueue = input.modelSelection;
  const hasPriorQueuedRequests = await deps.store.requests.hasPending(task.id);

  if (input.modelSelection && mcpClient && !hasPriorQueuedRequests && !existingRun.threadId.startsWith("queued:")) {
    try {
      const selection = input.modelSelection;
      const switched = await switchT3ThreadModel(mcpClient, existingRun.threadId, existingRun, selection);
      modelSelectionToQueue = undefined;
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
    } catch (err) {
      if (!isQueueableT3Error(err)) {
        throw err;
      }
      mcpClient = undefined;
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

  const [project, attachments] = await Promise.all([
    deps.storage.getProject(task.projectId),
    resolveCommentAttachments(deps.storage, task.id, comment.body),
  ]);
  const taskLabel = taskCode(task, project ?? undefined) ?? `"${task.title}"`;
  const replyPrompt = buildT3CommentPrompt({
    taskLabel,
    author: comment.author ?? DEFAULT_COMMENT_AUTHOR_LABEL,
    body: comment.body,
    attachments,
  });
  const prompt = switchedTo ? `${buildT3ModelSwitchNotice(taskLabel, switchedTo)}\n\n${replyPrompt}` : replyPrompt;
  const requestId = defaultIdGenerator();
  const messagePayload: QueuedMessagePayload = {
    hostId: resolvedHostId,
    prompt,
    clientRequestId: `${comment.id}:${requestId}`,
    ...(modelSelectionToQueue ? { modelSelection: modelSelectionToQueue } : {}),
    actor: input.actor,
    taskLabel,
  };

  await deps.store.requests.enqueue({
    id: requestId,
    hostId: resolvedHostId,
    taskId: task.id,
    kind: "reply",
    payload: JSON.stringify(messagePayload),
    now,
  });

  if (mcpClient) {
    const dispatched = await dispatchQueuedTaskT3Run(deps, task.id, mcpClient);
    const finalSwitchComment = switchComment ?? dispatched.switchComment;
    return {
      comment,
      ...(finalSwitchComment ? { switchComment: finalSwitchComment } : {}),
      run: dispatched.run ?? (await deps.store.getAgentRunByTaskId(task.id)) ?? run,
    };
  }

  const queuedRun = (await deps.store.getAgentRunByTaskId(task.id)) ?? run;
  if (deps.publishRealtime) {
    await deps.publishRealtime({ type: "agent_run.updated", run: queuedRun }).catch(() => undefined);
  }
  return {
    comment,
    ...(switchComment ? { switchComment } : {}),
    run: queuedRun,
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

/** Settle on the originating host before removing the project record, so failures remain retryable. */
export async function settleProjectT3Thread(
  deps: T3ServiceDeps,
  projectId: string,
  threadId: string,
  hostId?: string,
): Promise<void> {
  await requireProject(deps.storage, projectId);
  const existing = await deps.store.getProjectThread(projectId, threadId, hostId);
  if (!existing) throw new NotFoundError("t3_thread", threadId);

  const targetHostId = await resolveOriginatingProjectThreadHostId(deps, projectId, existing);
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: targetHostId,
    fetchFn: deps.fetchFn,
    now: deps.now ? deps.now() : Date.now(),
  });
  const live = await mcpClient.readThreadLiveStatus(existing.threadId);
  const state = deriveLiveAgentRunState({
    thread: live.thread,
    recentRuns: live.recentRuns,
    pendingRequestIds: live.pendingRequestIds,
  });
  if (state === "working" || state === "waiting_for_approval") {
    try {
      await mcpClient.interruptThread(existing.threadId);
    } catch (err) {
      // The turn may finish between reading its state and interrupting it.
      const alreadyStopped = err instanceof T3McpError && err.code === "tool_error" &&
        /^(?:thread is not running|no active run)(?:[.!]|$)/i.test(err.message.trim());
      if (!alreadyStopped) throw err;
    }
  }
  await mcpClient.settleThread(existing.threadId);
  await deps.store.deleteProjectThread(projectId, existing.threadId, targetHostId);
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
 * The thread runs in the project root unless `workspaceStrategy` says otherwise, and records the
 * originating `hostId` from the project mapping (#BIT-147).
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

  const { connection, client: mcpClient } = await resolveActiveT3ConnectionAndClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: requireRecordedHostId(mapping.hostId),
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
    hostId: mapping.hostId ?? connection.id,
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
  hostId?: string | undefined;
  body: string;
  modelSelection?: T3ModelSelection | undefined;
}

/**
 * Sends a follow-up to a project-level thread (#BIT-127). Only threads Bitig recorded for this
 * project can be messaged, and the message always goes to the thread's originating `hostId` (#BIT-147)
 * so reattaching the project to another host cannot reroute historical threads.
 */
export async function sendProjectT3Message(
  deps: T3ServiceDeps,
  projectId: string,
  threadId: string,
  options: SendProjectT3MessageOptions,
): Promise<ProjectT3Thread> {
  await requireProject(deps.storage, projectId);
  const existing = await deps.store.getProjectThread(projectId, threadId, options.hostId);
  if (!existing) {
    throw new NotFoundError("t3_thread", threadId);
  }

  const now = deps.now ? deps.now() : Date.now();
  const targetHostId = await resolveOriginatingProjectThreadHostId(deps, projectId, existing);
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: targetHostId,
    fetchFn: deps.fetchFn,
    now,
  });

  let thread = existing;
  let switchedTo: string | undefined;
  if (options.modelSelection) {
    const selection = options.modelSelection;
    const switched = await switchT3ThreadModel(mcpClient, existing.threadId, existing, selection);
    if (switched) {
      thread = (await deps.store.updateProjectThreadModel(projectId, threadId, { selection, now, hostId: targetHostId })) ?? existing;
      switchedTo = switched.to;
    }
  }

  const body = options.body.trim();
  const prompt = switchedTo ? `${buildProjectT3ModelSwitchNotice(switchedTo)}\n\n${body}` : body;
  await mcpClient.sendThreadMessage({ threadId: existing.threadId, prompt });

  return (await deps.store.updateProjectThreadState(projectId, threadId, { state: "working", now, hostId: targetHostId })) ?? thread;
}

/**
 * Lists a project's Bitig-started threads (#BIT-127), newest first, reconciling each thread's state
 * with its originating host's `t3_thread_list` (#BIT-147). When a thread's host cannot be reached,
 * active threads on that host are shown (and stored) as `offline`.
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
  const hostStateByKey = new Map<
    string,
    { mcpClient: T3McpClient | undefined; listedById: Map<string, T3ThreadListItem> | undefined }
  >();

  const getHostState = async (hostId: string | undefined) => {
    const key = hostId ?? "";
    const cached = hostStateByKey.get(key);
    if (cached) return cached;

    let mcpClient: T3McpClient | undefined;
    let listedById: Map<string, T3ThreadListItem> | undefined;
    try {
      mcpClient = await createActiveT3McpClient({
        store: deps.store,
        encryptionKey: deps.encryptionKey,
        hostId: requireRecordedHostId(hostId),
        fetchFn: deps.fetchFn,
        now,
      });
      const listed = await mcpClient.listThreads({ allProjects: true, includeSubagents: false, limit: 100 });
      listedById = new Map(listed.map((t) => [t.threadId, t]));
    } catch (err) {
      if (!(err instanceof T3McpError) && !(err instanceof ValidationError)) {
        throw err;
      }
      mcpClient = undefined;
      listedById = undefined;
    }

    const entry = { mcpClient, listedById };
    hostStateByKey.set(key, entry);
    return entry;
  };

  const threads: ProjectT3Thread[] = [];
  for (const thread of stored) {
    const targetHostId = thread.hostId;
    const { mcpClient, listedById } = await getHostState(targetHostId);
    const listedThread = listedById?.get(thread.threadId);
    let nextState: AgentRunState;
    let nextLink = thread.link;
    if (!listedById) {
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
            hostId: targetHostId,
            state: nextState,
            ...(nextLink ? { link: nextLink } : {}),
            now,
          })) ?? thread);

    const stopReason =
      mcpClient && listedById && (reconciled.state === "failed" || reconciled.state === "stopped")
        ? await mcpClient.readThreadStopReason(reconciled.threadId).catch(() => undefined)
        : undefined;

    threads.push(stopReason ? { ...reconciled, stopReason } : reconciled);
  }
  return { threads };
}

export interface ReadProjectT3ThreadMessagesOptions {
  readonly hostId?: string | undefined;
  readonly afterPosition?: number | undefined;
}

/**
 * Reads user and assistant messages from a project-level T3 thread (#BIT-131), paged forward with
 * `afterPosition` (exclusive). Only threads Bitig recorded for this project can be read, and the
 * readout always targets the thread's originating `hostId` (#BIT-147).
 */
export async function readProjectT3ThreadMessages(
  deps: T3ServiceDeps,
  projectId: string,
  threadId: string,
  options: ReadProjectT3ThreadMessagesOptions = {},
): Promise<ProjectT3ThreadMessagesResponse> {
  await requireProject(deps.storage, projectId);
  const existing = await deps.store.getProjectThread(projectId, threadId, options.hostId);
  if (!existing) {
    throw new NotFoundError("t3_thread", threadId);
  }

  const now = deps.now ? deps.now() : Date.now();
  const targetHostId = await resolveOriginatingProjectThreadHostId(deps, projectId, existing);
  const mcpClient = await createActiveT3McpClient({
    store: deps.store,
    encryptionKey: deps.encryptionKey,
    hostId: targetHostId,
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
          hostId: targetHostId,
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

export async function resolveTaskRunProfileWithSelection(
  deps: Pick<T3ServiceDeps, "store" | "storage" | "now">,
  taskRef: string,
  options?: { readonly hostId?: string | undefined },
): Promise<{
  readonly profile: TaskRunProfile | null;
  readonly resolved: ResolvedRunSelection;
  readonly nextLevelUp?: RunLevel | undefined;
  readonly routerEnabled: boolean;
}> {
  const taskId = await resolveTaskRef(deps.storage, taskRef);
  const task = await deps.storage.getTask(taskId);
  if (!task) {
    throw new NotFoundError("task", taskId);
  }
  const [profile, mapping, existingRun, routerSettings] = await Promise.all([
    deps.store.getTaskRunProfile(task.id),
    deps.store.getProjectMapping(task.projectId),
    deps.store.getAgentRunByTaskId(task.id).catch(() => undefined),
    deps.store.getAiRouterSettings().catch(() => undefined),
  ]);
  const targetHostId = options?.hostId ?? existingRun?.hostId ?? mapping?.hostId;
  const now = deps.now ? deps.now() : Date.now();
  const [resolved, nextLevel] = await Promise.all([
    resolveTaskLaunchRunSelection(deps, {
      taskId: task.id,
      projectId: task.projectId,
      hostId: targetHostId,
      now,
    }),
    resolveNextLevelUpForTask(deps, task.id, existingRun ?? null, targetHostId),
  ]);
  const routerEnabled = Boolean(
    routerSettings &&
      routerSettings.enabled &&
      routerSettings.baseUrl.trim().length > 0 &&
      routerSettings.model.trim().length > 0 &&
      routerSettings.hasToken,
  );
  return {
    profile: profile ?? null,
    resolved,
    ...(nextLevel ? { nextLevelUp: nextLevel } : {}),
    routerEnabled,
  };
}

export async function createOrgRunProfileRouter(
  deps: Pick<T3ServiceDeps, "store" | "encryptionKey" | "fetchFn" | "runProfileRouter">,
): Promise<RunProfileRouter | null> {
  if (deps.runProfileRouter) {
    return deps.runProfileRouter;
  }
  if (!deps.encryptionKey) {
    return null;
  }
  const record = await deps.store.getAiRouterSettingsRecord().catch(() => undefined);
  if (
    !record ||
    !record.enabled ||
    !record.baseUrl.trim() ||
    !record.model.trim() ||
    !record.encryptedApiToken ||
    !record.tokenIv
  ) {
    return null;
  }

  let apiToken: string;
  try {
    apiToken = await decryptT3Token(
      {
        ciphertext: record.encryptedApiToken,
        iv: record.tokenIv,
      },
      deps.encryptionKey,
    );
  } catch {
    return null;
  }
  if (!apiToken.trim()) {
    return null;
  }

  return new HttpRunProfileRouter({
    baseUrl: record.baseUrl,
    model: record.model,
    apiToken,
    apiStyle: record.apiStyle,
    enabled: record.enabled,
    fetchFn: deps.fetchFn,
  });
}

export async function readCachedCapabilitiesForOrg(
  store: T3D1Store,
  cache?: Cache,
): Promise<T3ModelCapability[]> {
  if (!cache) return [];
  try {
    const connections = await store.listConnections();
    const collected: T3ModelCapability[] = [];
    for (const connection of connections) {
      const key = await capabilitiesCacheKey(connection);
      const cached = await cache.match(key).catch(() => undefined);
      if (cached) {
        const body: unknown = await cached.json().catch(() => undefined);
        if (Array.isArray(body)) {
          collected.push(...(body as T3ModelCapability[]));
        }
      }
    }
    return collected;
  } catch {
    return [];
  }
}

export interface SuggestTaskRunProfileOptions {
  readonly onlyWhenUnprofiled?: boolean | undefined;
  readonly actor?: string | undefined;
  readonly hostId?: string | undefined;
  readonly cache?: Cache | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface SuggestTaskRunProfileResult {
  readonly profile: TaskRunProfile | null;
  readonly resolved: ResolvedRunSelection;
  readonly suggestion: RunProfileSuggestion | null;
  readonly stored: boolean;
  readonly suggested: boolean;
  readonly nextLevelUp?: RunLevel | undefined;
  readonly routerEnabled: boolean;
}

/**
 * Runs the organisation's AI router for a task (on approval when unprofiled, or on demand via
 * `POST /api/tasks/:id/run-profile/suggest` and MCP `suggest_run_profile`, #BIT-187).
 *
 * - Stored with `source: "router"`; never overwrites a `manual` or `agent` profile.
 * - On failure, timeout, non-2xx, invalid JSON, or low confidence, no profile is stored so the
 *   project default level applies.
 */
export async function suggestTaskRunProfile(
  deps: T3ServiceDeps,
  taskRef: string,
  options?: SuggestTaskRunProfileOptions,
): Promise<SuggestTaskRunProfileResult> {
  const taskId = await resolveTaskRef(deps.storage, taskRef);
  const task = await deps.storage.getTask(taskId);
  if (!task) {
    throw new NotFoundError("task", taskId);
  }

  const existingProfile = await deps.store.getTaskRunProfile(task.id);
  if (
    (options?.onlyWhenUnprofiled && existingProfile !== undefined) ||
    (existingProfile !== undefined && !canOverwriteRunProfile(existingProfile, "router"))
  ) {
    const current = await resolveTaskRunProfileWithSelection(deps, task.id, {
      hostId: options?.hostId,
    });
    return {
      ...current,
      suggestion: null,
      stored: false,
      suggested: false,
    };
  }

  const router = await createOrgRunProfileRouter(deps);
  if (!router) {
    const current = await resolveTaskRunProfileWithSelection(deps, task.id, {
      hostId: options?.hostId,
    });
    return {
      ...current,
      suggestion: null,
      stored: false,
      suggested: false,
    };
  }

  const now = deps.now ? deps.now() : Date.now();
  const [projectSettings, mapping, cachedCaps] = await Promise.all([
    deps.store.getProjectRunSettings(task.projectId),
    deps.store.getProjectMapping(task.projectId),
    readCachedCapabilitiesForOrg(deps.store, options?.cache),
  ]);
  const targetHostId = options?.hostId ?? mapping?.hostId;
  const levels = await deps.store.listRunLevels({
    ...(targetHostId ? { hostId: targetHostId } : {}),
    now,
  });
  const effortValuesByLevel = buildEffortValuesByLevel(levels, cachedCaps);

  const suggestion = await router.suggest(
    {
      title: task.title,
      description: task.description,
      checklist: task.checklist,
      labels: task.labels,
    },
    {
      levels,
      effortValuesByLevel,
      serialPaths: projectSettings?.serialPaths ?? [],
      ...(options?.signal ? { signal: options.signal } : {}),
    },
  );

  if (!suggestion) {
    const current = await resolveTaskRunProfileWithSelection(deps, task.id, {
      hostId: targetHostId,
    });
    return {
      ...current,
      suggestion: null,
      stored: false,
      suggested: false,
    };
  }

  const saved = await deps.store.saveTaskRunProfile({
    taskId: task.id,
    level: suggestion.level,
    effort: suggestion.effort ?? null,
    touches: suggestion.touches,
    parallelSafe: suggestion.parallelSafe,
    source: "router",
    reason: suggestion.reason,
    confidence: suggestion.confidence,
    updatedBy: options?.actor ?? "router",
    now,
  });

  const updated = await resolveTaskRunProfileWithSelection(deps, task.id, {
    hostId: targetHostId,
  });

  const wasStored = saved.source === "router";
  return {
    ...updated,
    profile: saved,
    suggestion,
    stored: wasStored,
    suggested: wasStored,
  };
}

export interface ValidateAndSaveOrgRunLevelsInput {
  readonly levels: SaveRunLevelsInput["levels"];
  readonly models?: SaveRunLevelsInput["models"] | undefined;
  readonly replacementKeys?: Readonly<Record<string, string>> | undefined;
  readonly defaultReplacementKey?: string | undefined;
}

export async function validateAndSaveOrgRunLevels(
  deps: Pick<T3ServiceDeps, "store" | "encryptionKey" | "fetchFn" | "now">,
  input: ValidateAndSaveOrgRunLevelsInput,
  cache?: Cache,
): Promise<{
  readonly levels: RunLevel[];
  readonly models: RunLevelModelBinding[];
}> {
  const bindingsByHost = new Map<string, { levelKey: string; selection: T3ModelSelection }[]>();
  const addBinding = (levelKey: string, hostId: string | null | undefined, selection: T3ModelSelection) => {
    const hostKey = (hostId ?? "").trim();
    const bucket = bindingsByHost.get(hostKey) ?? [];
    bucket.push({ levelKey, selection });
    bindingsByHost.set(hostKey, bucket);
  };

  for (const level of input.levels) {
    if (level.selection) {
      addBinding(level.key, null, level.selection);
    }
  }
  for (const entry of input.models ?? []) {
    addBinding(entry.levelKey, entry.hostId, entry.selection);
  }

  for (const [hostKey, bindings] of bindingsByHost.entries()) {
    let capabilities: T3ModelCapability[];
    if (hostKey) {
      capabilities = await listT3ModelCapabilities(
        {
          store: deps.store,
          encryptionKey: deps.encryptionKey,
          fetchFn: deps.fetchFn,
          hostId: hostKey,
        },
        cache,
      );
    } else {
      const connections = await deps.store.listConnections();
      if (connections.length === 0) {
        capabilities = await listT3ModelCapabilities(
          {
            store: deps.store,
            encryptionKey: deps.encryptionKey,
            fetchFn: deps.fetchFn,
          },
          cache,
        );
      } else {
        const allCaps = await Promise.all(
          connections.map((conn) =>
            listT3ModelCapabilities(
              {
                store: deps.store,
                encryptionKey: deps.encryptionKey,
                fetchFn: deps.fetchFn,
                hostId: conn.id,
              },
              cache,
            ),
          ),
        );
        capabilities = allCaps.flat();
      }
    }

    for (const binding of bindings) {
      const providerInstanceId = binding.selection.providerInstanceId.trim();
      const model = binding.selection.model.trim();
      const cap = capabilities.find(
        (c) => c.providerInstanceId === providerInstanceId && c.model === model,
      );
      if (!cap) {
        makeValidationIssue(
          "models",
          `Model "${model}" on provider "${providerInstanceId}" is not available in orchestrator_capabilities for level "${binding.levelKey}".`,
        );
      }

      if (binding.selection.options && binding.selection.options.length > 0) {
        for (const opt of binding.selection.options) {
          const optDescriptor = cap.options?.find((d) => d.id === opt.id);
          if (!optDescriptor) {
            makeValidationIssue(
              "models",
              `Option "${opt.id}" is not supported by model "${model}" for level "${binding.levelKey}".`,
            );
          }
          if (
            optDescriptor.values.length > 0 &&
            !optDescriptor.values.includes(opt.value)
          ) {
            makeValidationIssue(
              "models",
              `Option value "${opt.id}=${String(opt.value)}" is not supported by model "${model}" for level "${binding.levelKey}".`,
            );
          }
        }
      }
    }
  }

  const now = deps.now ? deps.now() : Date.now();
  await deps.store.saveRunLevels({
    levels: input.levels,
    models: input.models,
    replacementKeys: input.replacementKeys,
    defaultReplacementKey: input.defaultReplacementKey,
    now,
  });

  const [levels, models] = await Promise.all([
    deps.store.listRunLevels({ now }),
    deps.store.listRunLevelModels(),
  ]);
  return { levels, models };
}



