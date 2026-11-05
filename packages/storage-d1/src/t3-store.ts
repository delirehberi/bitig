import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  AgentRunSchema,
  DEFAULT_ORGANISATION_ID,
  ProjectT3ThreadSchema,
  T3ModelSelectionOptionsSchema,
  T3ProjectMappingSchema,
  toTimestamp,
  type AgentRun,
  type AgentRunState,
  type ProjectT3Thread,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3ProjectMapping,
  type T3WorkspaceStrategy,
  type TaskActor,
} from "@bitig/core";
import * as schema from "./schema";
import {
  agentRuns,
  projects,
  projectT3Threads,
  t3Connections,
  t3OauthStates,
  t3ProjectMappings,
  tasks,
  type AgentRunRecord,
  type ProjectT3ThreadRecord,
  type T3ConnectionRecord,
  type T3OauthStateRecord,
  type T3ProjectMappingRecord,
} from "./schema";

const DEFAULT_CONNECTION_ID = "default";

export interface SaveT3ConnectionInput {
  orgId?: string | undefined;
  mcpUrl: string;
  issuer: string;
  clientId: string;
  encryptedAccessToken: string;
  tokenIv: string;
  scope: string;
  expiresAt: number;
  now?: number;
}

export interface SaveT3OauthStateInput {
  state: string;
  orgId?: string | undefined;
  mcpUrl: string;
  issuer: string;
  tokenEndpoint: string;
  clientId: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface SaveAgentRunInput {
  id: string;
  taskId: string;
  t3ProjectId: string;
  threadId: string;
  link?: string | undefined;
  state: AgentRunState;
  model?: string | undefined;
  providerInstanceId?: string | undefined;
  workspaceStrategy?: T3WorkspaceStrategy | undefined;
  /** The umbrella task whose session started this run (#BIT-141); cleared when absent. */
  parentTaskId?: string | undefined;
  startedBy?: TaskActor | undefined;
  startedAt: number;
  updatedAt: number;
}

/**
 * Reads the `model_options` JSON column. A value that is not valid JSON or not a list of
 * `{ id, value }` options is treated as absent: it only labels the run's model, so the run stays readable.
 */
function parseModelOptions(raw: string | null): T3ModelSelectionOption[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn("ignoring unreadable agent_runs.model_options", err);
    return undefined;
  }
  const result = T3ModelSelectionOptionsSchema.safeParse(parsed);
  return result.success && result.data.length > 0 ? result.data : undefined;
}

function toAgentRun(row: AgentRunRecord): AgentRun {
  const modelOptions = parseModelOptions(row.modelOptions);
  return AgentRunSchema.parse({
    id: row.id,
    taskId: row.taskId,
    t3ProjectId: row.t3ProjectId,
    threadId: row.threadId,
    ...(row.link !== null ? { link: row.link } : {}),
    state: row.state,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    ...(modelOptions ? { modelOptions } : {}),
    ...(row.workspaceStrategy !== null ? { workspaceStrategy: row.workspaceStrategy } : {}),
    ...(row.parentTaskId !== null ? { parentTaskId: row.parentTaskId } : {}),
    ...(row.waitingForTaskId !== null ? { waitingForTaskId: row.waitingForTaskId } : {}),
    ...(row.startedBy !== null ? { startedBy: row.startedBy } : {}),
    startedAt: toTimestamp(new Date(row.startedAt)),
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  });
}

export interface SaveProjectT3ThreadInput {
  id: string;
  projectId: string;
  t3ProjectId: string;
  threadId: string;
  title: string;
  link?: string | undefined;
  state: AgentRunState;
  selection?: T3ModelSelection | undefined;
  workspaceStrategy: T3WorkspaceStrategy;
  startedBy?: TaskActor | undefined;
  startedAt: number;
  updatedAt: number;
}

function serializeModelOptions(options: readonly T3ModelSelectionOption[] | undefined): string | null {
  return options && options.length > 0 ? JSON.stringify(options) : null;
}

function toProjectT3Thread(row: ProjectT3ThreadRecord): ProjectT3Thread {
  const modelOptions = parseModelOptions(row.modelOptions);
  return ProjectT3ThreadSchema.parse({
    id: row.id,
    projectId: row.projectId,
    t3ProjectId: row.t3ProjectId,
    threadId: row.threadId,
    title: row.title,
    ...(row.link !== null ? { link: row.link } : {}),
    state: row.state,
    ...(row.model !== null ? { model: row.model } : {}),
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    ...(modelOptions ? { modelOptions } : {}),
    workspaceStrategy: row.workspaceStrategy,
    ...(row.startedBy !== null ? { startedBy: row.startedBy } : {}),
    startedAt: toTimestamp(new Date(row.startedAt)),
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  });
}

function toProjectMapping(row: T3ProjectMappingRecord): T3ProjectMapping {
  return T3ProjectMappingSchema.parse({
    projectId: row.projectId,
    t3ProjectId: row.t3ProjectId,
    t3ProjectTitle: row.t3ProjectTitle,
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  });
}

/**
 * Worker-only D1 store for T3 OAuth connection, PKCE states, project mappings,
 * and `agent_runs`. Kept separate from `StorageProvider` so local, API, and
 * Markdown storage adapters remain untouched.
 */
export class T3D1Store {
  private readonly db: DrizzleD1Database<typeof schema>;
  private readonly orgId: string;
  private readonly explicitOrgScope: boolean;

  constructor(d1: D1Database, orgId?: string) {
    this.db = drizzle(d1, { schema });
    this.orgId = orgId ?? DEFAULT_ORGANISATION_ID;
    this.explicitOrgScope = orgId !== undefined;
  }

  private connectionRowId(targetOrgId: string): string {
    return targetOrgId === DEFAULT_ORGANISATION_ID ? DEFAULT_CONNECTION_ID : targetOrgId;
  }

  async getConnection(): Promise<T3ConnectionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(t3Connections)
      .where(eq(t3Connections.orgId, this.orgId))
      .limit(1);
    return rows[0];
  }

  async saveConnection(input: SaveT3ConnectionInput): Promise<T3ConnectionRecord> {
    const now = input.now ?? Date.now();
    const targetOrgId = input.orgId ?? this.orgId;
    const record: T3ConnectionRecord = {
      id: this.connectionRowId(targetOrgId),
      orgId: targetOrgId,
      mcpUrl: input.mcpUrl,
      issuer: input.issuer,
      clientId: input.clientId,
      encryptedAccessToken: input.encryptedAccessToken,
      tokenIv: input.tokenIv,
      scope: input.scope,
      expiresAt: input.expiresAt,
      connectedAt: now,
      updatedAt: now,
    };

    await this.db
      .insert(t3Connections)
      .values(record)
      .onConflictDoUpdate({
        target: t3Connections.id,
        set: {
          orgId: record.orgId,
          mcpUrl: record.mcpUrl,
          issuer: record.issuer,
          clientId: record.clientId,
          encryptedAccessToken: record.encryptedAccessToken,
          tokenIv: record.tokenIv,
          scope: record.scope,
          expiresAt: record.expiresAt,
          connectedAt: record.connectedAt,
          updatedAt: record.updatedAt,
        },
      });

    return record;
  }

  async deleteConnection(): Promise<void> {
    await this.db.delete(t3Connections).where(eq(t3Connections.orgId, this.orgId));
  }

  async saveOauthState(input: SaveT3OauthStateInput): Promise<void> {
    await this.db.delete(t3OauthStates).where(lt(t3OauthStates.expiresAt, input.createdAt));
    await this.db.insert(t3OauthStates).values({
      ...input,
      orgId: input.orgId ?? this.orgId,
    });
  }

  async consumeOauthState(state: string, now = Date.now()): Promise<T3OauthStateRecord | undefined> {
    const rows = await this.db
      .select()
      .from(t3OauthStates)
      .where(eq(t3OauthStates.state, state))
      .limit(1);
    const record = rows[0];
    if (!record) {
      return undefined;
    }
    await this.db.delete(t3OauthStates).where(eq(t3OauthStates.state, state));
    if (record.expiresAt <= now) {
      return undefined;
    }
    return record;
  }

  async listProjectMappings(): Promise<T3ProjectMapping[]> {
    if (!this.explicitOrgScope) {
      const rows = await this.db.select().from(t3ProjectMappings);
      return rows.map(toProjectMapping);
    }
    const orgProjectIds = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, this.orgId));
    const rows = await this.db
      .select()
      .from(t3ProjectMappings)
      .where(inArray(t3ProjectMappings.projectId, orgProjectIds));
    return rows.map(toProjectMapping);
  }

  async getProjectMapping(projectId: string): Promise<T3ProjectMapping | undefined> {
    const rows = await this.db
      .select()
      .from(t3ProjectMappings)
      .where(eq(t3ProjectMappings.projectId, projectId))
      .limit(1);
    const row = rows[0];
    return row ? toProjectMapping(row) : undefined;
  }

  async upsertProjectMapping(input: {
    projectId: string;
    t3ProjectId: string;
    t3ProjectTitle: string;
    now?: number;
  }): Promise<T3ProjectMapping> {
    const updatedAt = input.now ?? Date.now();
    const record: T3ProjectMappingRecord = {
      projectId: input.projectId,
      t3ProjectId: input.t3ProjectId,
      t3ProjectTitle: input.t3ProjectTitle,
      updatedAt,
    };
    await this.db
      .insert(t3ProjectMappings)
      .values(record)
      .onConflictDoUpdate({
        target: t3ProjectMappings.projectId,
        set: {
          t3ProjectId: record.t3ProjectId,
          t3ProjectTitle: record.t3ProjectTitle,
          updatedAt: record.updatedAt,
        },
      });
    return toProjectMapping(record);
  }

  async deleteProjectMapping(projectId: string): Promise<void> {
    await this.db.delete(t3ProjectMappings).where(eq(t3ProjectMappings.projectId, projectId));
  }

  async listAgentRuns(): Promise<AgentRun[]> {
    if (!this.explicitOrgScope) {
      const rows = await this.db.select().from(agentRuns);
      return rows.map(toAgentRun);
    }
    const orgProjectIds = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, this.orgId));
    const orgTaskIds = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.projectId, orgProjectIds));
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(inArray(agentRuns.taskId, orgTaskIds));
    return rows.map(toAgentRun);
  }

  async getAgentRunByTaskId(taskId: string): Promise<AgentRun | undefined> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.taskId, taskId))
      .limit(1);
    const row = rows[0];
    return row ? toAgentRun(row) : undefined;
  }

  async saveAgentRun(input: SaveAgentRunInput): Promise<AgentRun> {
    const record: AgentRunRecord = {
      id: input.id,
      taskId: input.taskId,
      t3ProjectId: input.t3ProjectId,
      threadId: input.threadId,
      link: input.link ?? null,
      state: input.state,
      model: input.model ?? null,
      providerInstanceId: input.providerInstanceId ?? null,
      modelOptions: null,
      workspaceStrategy: input.workspaceStrategy ?? null,
      parentTaskId: input.parentTaskId ?? null,
      // A new launch never waits on a child yet; a relaunch drops any earlier wait.
      waitingForTaskId: null,
      startedBy: input.startedBy ?? null,
      startedAt: input.startedAt,
      updatedAt: input.updatedAt,
    };

    await this.db
      .insert(agentRuns)
      .values(record)
      .onConflictDoUpdate({
        target: agentRuns.taskId,
        set: {
          id: record.id,
          t3ProjectId: record.t3ProjectId,
          threadId: record.threadId,
          link: record.link,
          state: record.state,
          model: record.model,
          providerInstanceId: record.providerInstanceId,
          modelOptions: record.modelOptions,
          workspaceStrategy: record.workspaceStrategy,
          parentTaskId: record.parentTaskId,
          waitingForTaskId: record.waitingForTaskId,
          startedBy: record.startedBy,
          startedAt: record.startedAt,
          updatedAt: record.updatedAt,
        },
      });

    return toAgentRun(record);
  }

  async updateAgentRunState(
    taskId: string,
    patch: { state: AgentRunState; link?: string | undefined; now?: number },
  ): Promise<AgentRun | undefined> {
    const existing = await this.getAgentRunByTaskId(taskId);
    if (!existing) {
      return undefined;
    }
    const updatedAt = patch.now ?? Date.now();
    const nextLink = patch.link ?? existing.link ?? null;
    await this.db
      .update(agentRuns)
      .set({
        state: patch.state,
        link: nextLink,
        updatedAt,
      })
      .where(eq(agentRuns.taskId, taskId));
    return {
      ...existing,
      ...(nextLink ? { link: nextLink } : {}),
      state: patch.state,
      updatedAt: toTimestamp(new Date(updatedAt)),
    };
  }

  /**
   * Marks an umbrella task's run as `waiting_subagent` on `childTaskId` (#BIT-141).
   * Resolves to `undefined` when the task has no run.
   */
  async setAgentRunWaitingFor(
    taskId: string,
    patch: { childTaskId: string; now?: number },
  ): Promise<AgentRun | undefined> {
    const updatedAt = patch.now ?? Date.now();
    const rows = await this.db
      .update(agentRuns)
      .set({ state: "waiting_subagent", waitingForTaskId: patch.childTaskId, updatedAt })
      .where(eq(agentRuns.taskId, taskId))
      .returning();
    const row = rows[0];
    return row ? toAgentRun(row) : undefined;
  }

  /** The runs that wait on `childTaskId` (#BIT-141); normally at most one umbrella session. */
  async listAgentRunsWaitingFor(childTaskId: string): Promise<AgentRun[]> {
    const rows = await this.db.select().from(agentRuns).where(eq(agentRuns.waitingForTaskId, childTaskId));
    return rows.map(toAgentRun);
  }

  /**
   * Stops `taskId`'s run from waiting on `childTaskId` and moves it to `state` in one conditional
   * update (#BIT-141). Only one caller can claim a wait, so concurrent completion and live-status
   * checks hand a child's result back to the umbrella session once. Resolves to `undefined` when
   * the run does not wait on that child (any more).
   */
  async claimAgentRunWaitingFor(
    taskId: string,
    childTaskId: string,
    patch: { state: AgentRunState; now?: number },
  ): Promise<AgentRun | undefined> {
    const updatedAt = patch.now ?? Date.now();
    const rows = await this.db
      .update(agentRuns)
      .set({ state: patch.state, waitingForTaskId: null, updatedAt })
      .where(and(eq(agentRuns.taskId, taskId), eq(agentRuns.waitingForTaskId, childTaskId)))
      .returning();
    const row = rows[0];
    return row ? toAgentRun(row) : undefined;
  }

  /** Records the model a thread switched to (#BIT-119). Resolves to `undefined` when the task has no run. */
  async updateAgentRunModel(
    taskId: string,
    patch: { selection: T3ModelSelection; now?: number },
  ): Promise<AgentRun | undefined> {
    const existing = await this.getAgentRunByTaskId(taskId);
    if (!existing) {
      return undefined;
    }
    const updatedAt = patch.now ?? Date.now();
    const options = patch.selection.options ?? [];
    await this.db
      .update(agentRuns)
      .set({
        model: patch.selection.model,
        providerInstanceId: patch.selection.providerInstanceId,
        modelOptions: options.length > 0 ? JSON.stringify(options) : null,
        updatedAt,
      })
      .where(eq(agentRuns.taskId, taskId));
    const updated: AgentRun = {
      ...existing,
      model: patch.selection.model,
      providerInstanceId: patch.selection.providerInstanceId,
      updatedAt: toTimestamp(new Date(updatedAt)),
    };
    if (options.length > 0) {
      updated.modelOptions = options.map((opt) => ({ ...opt }));
    } else {
      delete updated.modelOptions;
    }
    return updated;
  }

  /** Project-level threads (#BIT-127), newest first. Pass a project ID to list one project's threads. */
  async listProjectThreads(projectId?: string): Promise<ProjectT3Thread[]> {
    const query = this.db.select().from(projectT3Threads);
    const rows = await (projectId ? query.where(eq(projectT3Threads.projectId, projectId)) : query).orderBy(
      desc(projectT3Threads.startedAt),
      desc(projectT3Threads.id),
    );
    return rows.map(toProjectT3Thread);
  }

  /** The project's thread with this T3 thread ID; `undefined` when it belongs to another project. */
  async getProjectThread(projectId: string, threadId: string): Promise<ProjectT3Thread | undefined> {
    const rows = await this.db
      .select()
      .from(projectT3Threads)
      .where(and(eq(projectT3Threads.projectId, projectId), eq(projectT3Threads.threadId, threadId)))
      .limit(1);
    const row = rows[0];
    return row ? toProjectT3Thread(row) : undefined;
  }

  async saveProjectThread(input: SaveProjectT3ThreadInput): Promise<ProjectT3Thread> {
    const record: ProjectT3ThreadRecord = {
      id: input.id,
      projectId: input.projectId,
      t3ProjectId: input.t3ProjectId,
      threadId: input.threadId,
      title: input.title,
      link: input.link ?? null,
      state: input.state,
      model: input.selection?.model ?? null,
      providerInstanceId: input.selection?.providerInstanceId ?? null,
      modelOptions: serializeModelOptions(input.selection?.options),
      workspaceStrategy: input.workspaceStrategy,
      startedBy: input.startedBy ?? null,
      startedAt: input.startedAt,
      updatedAt: input.updatedAt,
    };
    await this.db.insert(projectT3Threads).values(record);
    return toProjectT3Thread(record);
  }

  async updateProjectThreadState(
    projectId: string,
    threadId: string,
    patch: { state: AgentRunState; link?: string | undefined; now?: number },
  ): Promise<ProjectT3Thread | undefined> {
    const existing = await this.getProjectThread(projectId, threadId);
    if (!existing) {
      return undefined;
    }
    const updatedAt = patch.now ?? Date.now();
    const nextLink = patch.link ?? existing.link ?? null;
    await this.db
      .update(projectT3Threads)
      .set({ state: patch.state, link: nextLink, updatedAt })
      .where(eq(projectT3Threads.id, existing.id));
    return {
      ...existing,
      ...(nextLink ? { link: nextLink } : {}),
      state: patch.state,
      updatedAt: toTimestamp(new Date(updatedAt)),
    };
  }

  async updateProjectThreadModel(
    projectId: string,
    threadId: string,
    patch: { selection: T3ModelSelection; now?: number },
  ): Promise<ProjectT3Thread | undefined> {
    const existing = await this.getProjectThread(projectId, threadId);
    if (!existing) {
      return undefined;
    }
    const updatedAt = patch.now ?? Date.now();
    const options = patch.selection.options ?? [];
    await this.db
      .update(projectT3Threads)
      .set({
        model: patch.selection.model,
        providerInstanceId: patch.selection.providerInstanceId,
        modelOptions: serializeModelOptions(options),
        updatedAt,
      })
      .where(eq(projectT3Threads.id, existing.id));
    const updated: ProjectT3Thread = {
      ...existing,
      model: patch.selection.model,
      providerInstanceId: patch.selection.providerInstanceId,
      updatedAt: toTimestamp(new Date(updatedAt)),
    };
    if (options.length > 0) {
      updated.modelOptions = options.map((opt) => ({ ...opt }));
    } else {
      delete updated.modelOptions;
    }
    return updated;
  }
}
