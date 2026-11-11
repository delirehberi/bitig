import { and, asc, desc, eq, inArray, lt, or } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  AgentRunSchema,
  ValidationError,
  NotFoundError,
  ProjectBusyError,
  isActiveAgentRunState,
  T3GitMetadataSchema,
  type T3GitMetadata,
  DEFAULT_ORGANISATION_ID,
  ProjectT3ThreadSchema,
  T3ModelSelectionOptionsSchema,
  T3ProjectMappingSchema,
  defaultIdGenerator,
  defaultT3HostProjectsRoot,
  normalizeHostFolderPath,
  toTimestamp,
  type AgentRun,
  type AgentRunState,
  type ProjectT3Thread,
  type T3HostKind,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3ProjectMapping,
  type T3WorkspaceStrategy,
  type TaskActor,
} from "@bitig/core";
import * as schema from "./schema";
import { T3RequestStore } from "./t3-request-store";
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
  id?: string | undefined;
  orgId?: string | undefined;
  label?: string | null | undefined;
  kind?: T3HostKind | undefined;
  projectsRoot?: string | undefined;
  mcpUrl: string;
  issuer: string;
  clientId: string;
  encryptedAccessToken: string;
  tokenIv: string;
  scope: string;
  expiresAt: number;
  now?: number;
}

export interface UpdateT3ConnectionInput {
  label?: string | null | undefined;
  kind?: T3HostKind | undefined;
  projectsRoot?: string | undefined;
  now?: number | undefined;
}

export interface SaveT3OauthStateInput {
  state: string;
  orgId?: string | undefined;
  hostId?: string | null | undefined;
  label?: string | null | undefined;
  kind?: T3HostKind | undefined;
  projectsRoot?: string | undefined;
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
  hostId?: string | undefined;
  t3ProjectId: string;
  threadId: string;
  link?: string | undefined;
  state: AgentRunState;
  model?: string | undefined;
  providerInstanceId?: string | undefined;
  modelOptions?: readonly T3ModelSelectionOption[] | undefined;
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
  const metadata: T3GitMetadata = {};
  for (const key of ["branch", "headSha", "diffStat", "pullRequestUrls"] as const) {
    const raw = row[key];
    if (raw == null) continue;
    try {
      const value: unknown = key === "diffStat" || key === "pullRequestUrls" ? JSON.parse(raw) : raw;
      const parsed = T3GitMetadataSchema.safeParse({ [key]: value });
      if (parsed.success) Object.assign(metadata, parsed.data);
      else console.warn("ignoring invalid agent run Git metadata", key);
    } catch (err) {
      console.warn("ignoring unreadable agent run Git metadata", key, err);
    }
  }
  return AgentRunSchema.parse({
    ...metadata,
    id: row.id,
    taskId: row.taskId,
    ...(row.hostId !== null ? { hostId: row.hostId } : {}),
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
  hostId?: string | undefined;
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
    ...(row.hostId !== null ? { hostId: row.hostId } : {}),
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
    ...(row.hostId !== null ? { hostId: row.hostId } : {}),
    t3ProjectId: row.t3ProjectId,
    t3ProjectTitle: row.t3ProjectTitle,
    ...(row.workspaceRoot !== null ? { workspaceRoot: row.workspaceRoot } : {}),
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  });
}

/**
 * Worker-only D1 store for T3 OAuth connections, PKCE states, project mappings,
 * and `agent_runs`. Kept separate from `StorageProvider` so local, API, and
 * Markdown storage adapters remain untouched.
 */
export class T3D1Store {
  readonly requests: T3RequestStore;
  private readonly db: DrizzleD1Database<typeof schema>;
  private readonly orgId: string;
  private readonly explicitOrgScope: boolean;

  constructor(d1: D1Database, orgId?: string) {
    this.db = drizzle(d1, { schema });
    this.orgId = orgId ?? DEFAULT_ORGANISATION_ID;
    this.requests = new T3RequestStore(d1, this.orgId);
    this.explicitOrgScope = orgId !== undefined;
  }

  async listConnections(): Promise<T3ConnectionRecord[]> {
    return await this.db
      .select()
      .from(t3Connections)
      .where(eq(t3Connections.orgId, this.orgId))
      .orderBy(asc(t3Connections.connectedAt), asc(t3Connections.id));
  }

  private async canAccessProject(projectId: string): Promise<boolean> {
    if (!this.explicitOrgScope) return true;
    const row = await this.db.select({ id: projects.id }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.orgId, this.orgId))).get();
    return row !== undefined;
  }

  private async canAccessTask(taskId: string): Promise<boolean> {
    if (!this.explicitOrgScope) return true;
    const row = await this.db.select({ projectId: tasks.projectId }).from(tasks)
      .where(eq(tasks.id, taskId)).get();
    return row !== undefined && this.canAccessProject(row.projectId);
  }

  private static async ignoreMissingTable<T>(promise: Promise<T>, fallback: T): Promise<T> {
    try {
      return await promise;
    } catch (err) {
      const message =
        err instanceof Error
          ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
          : String(err);
      if (message.includes("no such table")) {
        return fallback;
      }
      throw err;
    }
  }

  async assertProjectIdle(projectId: string): Promise<void> {
    if (!(await this.canAccessProject(projectId))) throw new NotFoundError("project", projectId);
    const projectTasks = await T3D1Store.ignoreMissingTable(
      this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, projectId)),
      [],
    );
    const taskIds = new Set(projectTasks.map((task) => task.id));
    const [runs, threads] = await Promise.all([
      T3D1Store.ignoreMissingTable(this.listAgentRuns(), []),
      T3D1Store.ignoreMissingTable(this.listProjectThreads(projectId), []),
    ]);
    if (runs.some((run) => taskIds.has(run.taskId) && (isActiveAgentRunState(run.state) || run.state === "offline")) ||
        threads.some((thread) => isActiveAgentRunState(thread.state) || thread.state === "offline")) {
      throw new ProjectBusyError(projectId);
    }
  }

  async getConnection(hostId?: string): Promise<T3ConnectionRecord | undefined> {
    if (hostId !== undefined) {
      const rows = await this.db
        .select()
        .from(t3Connections)
        .where(and(eq(t3Connections.orgId, this.orgId), eq(t3Connections.id, hostId)))
        .limit(1);
      return rows[0];
    }
    const rows = await this.db
      .select()
      .from(t3Connections)
      .where(eq(t3Connections.orgId, this.orgId))
      .orderBy(asc(t3Connections.connectedAt), asc(t3Connections.id))
      .limit(2);
    if (rows.length > 1) {
      throw new ValidationError("t3Host", [{ code: "custom", path: ["hostId"], message: "Select a host explicitly; this organisation has multiple T3 hosts." }]);
    }
    return rows[0];
  }

  async saveConnection(input: SaveT3ConnectionInput): Promise<T3ConnectionRecord> {
    const now = input.now ?? Date.now();
    const targetOrgId = input.orgId ?? this.orgId;

    let existing: T3ConnectionRecord | undefined;
    if (input.id) {
      const byId = await this.db
        .select()
        .from(t3Connections)
        .where(eq(t3Connections.id, input.id))
        .limit(1);
      const found = byId[0];
      if (found && found.orgId !== targetOrgId) {
        throw new Error(`T3 host ${input.id} belongs to another organisation`);
      }
      existing = found;
    }
    if (!existing) {
      const byUrl = await this.db
        .select()
        .from(t3Connections)
        .where(and(eq(t3Connections.orgId, targetOrgId), eq(t3Connections.mcpUrl, input.mcpUrl)))
        .limit(1);
      existing = byUrl[0];
    }

    let id = existing?.id ?? input.id;
    if (!id) {
      if (targetOrgId === DEFAULT_ORGANISATION_ID) {
        const defaultRow = await this.db
          .select({ id: t3Connections.id })
          .from(t3Connections)
          .where(eq(t3Connections.id, DEFAULT_CONNECTION_ID))
          .limit(1);
        id = defaultRow.length === 0 ? DEFAULT_CONNECTION_ID : defaultIdGenerator();
      } else {
        id = defaultIdGenerator();
      }
    }

    const kind: T3HostKind = input.kind ?? existing?.kind ?? "user";
    const projectsRoot = normalizeHostFolderPath(
      input.projectsRoot ??
        (input.kind && input.kind !== existing?.kind ? undefined : existing?.projectsRoot) ??
        defaultT3HostProjectsRoot(kind),
    );
    const trimmedInputLabel = input.label?.trim();
    const label =
      input.label === undefined
        ? (existing?.label ?? null)
        : trimmedInputLabel !== undefined && trimmedInputLabel.length > 0
          ? trimmedInputLabel
          : null;

    const record: T3ConnectionRecord = {
      id,
      orgId: targetOrgId,
      label,
      kind,
      projectsRoot,
      mcpUrl: input.mcpUrl,
      issuer: input.issuer,
      clientId: input.clientId,
      encryptedAccessToken: input.encryptedAccessToken,
      tokenIv: input.tokenIv,
      scope: input.scope,
      expiresAt: input.expiresAt,
      connectedAt: existing?.connectedAt ?? now,
      updatedAt: now,
    };

    await this.db
      .insert(t3Connections)
      .values(record)
      .onConflictDoUpdate({
        target: t3Connections.id,
        set: {
          orgId: record.orgId,
          label: record.label,
          kind: record.kind,
          projectsRoot: record.projectsRoot,
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

  async updateConnection(
    hostId: string,
    patch: UpdateT3ConnectionInput,
  ): Promise<T3ConnectionRecord | undefined> {
    const existing = await this.getConnection(hostId);
    if (!existing) {
      return undefined;
    }
    const updatedAt = patch.now ?? Date.now();
    const nextKind: T3HostKind = patch.kind ?? existing.kind;
    let nextProjectsRoot = existing.projectsRoot;
    if (patch.projectsRoot !== undefined) {
      nextProjectsRoot = normalizeHostFolderPath(patch.projectsRoot);
    } else if (patch.kind !== undefined && patch.kind !== existing.kind) {
      const previousDefault = defaultT3HostProjectsRoot(existing.kind);
      if (existing.projectsRoot === previousDefault) {
        nextProjectsRoot = defaultT3HostProjectsRoot(nextKind);
      }
    }
    const trimmedPatchLabel = patch.label?.trim();
    const nextLabel =
      patch.label === undefined
        ? existing.label
        : trimmedPatchLabel !== undefined && trimmedPatchLabel.length > 0
          ? trimmedPatchLabel
          : null;

    const rows = await this.db
      .update(t3Connections)
      .set({
        label: nextLabel,
        kind: nextKind,
        projectsRoot: nextProjectsRoot,
        updatedAt,
      })
      .where(and(eq(t3Connections.orgId, this.orgId), eq(t3Connections.id, hostId)))
      .returning();
    return rows[0];
  }

  async deleteConnection(hostId?: string): Promise<boolean> {
    const connection = await this.getConnection(hostId);
    if (!connection) return false;
    const whereClause = and(eq(t3Connections.orgId, this.orgId), eq(t3Connections.id, connection.id));
    await this.db.delete(t3OauthStates).where(and(eq(t3OauthStates.orgId, this.orgId),
      or(eq(t3OauthStates.hostId, connection.id), eq(t3OauthStates.mcpUrl, connection.mcpUrl))));
    const deleted = await this.db
      .delete(t3Connections)
      .where(whereClause)
      .returning({ id: t3Connections.id });
    return deleted.length > 0;
  }

  async saveOauthState(input: SaveT3OauthStateInput): Promise<void> {
    const kind: T3HostKind = input.kind ?? "user";
    const projectsRoot = normalizeHostFolderPath(
      input.projectsRoot ?? defaultT3HostProjectsRoot(kind),
    );
    const trimmedStateLabel = input.label?.trim();
    await this.db.delete(t3OauthStates).where(lt(t3OauthStates.expiresAt, input.createdAt));
    await this.db.insert(t3OauthStates).values({
      state: input.state,
      orgId: input.orgId ?? this.orgId,
      hostId: input.hostId ?? null,
      label: trimmedStateLabel !== undefined && trimmedStateLabel.length > 0 ? trimmedStateLabel : null,
      kind,
      projectsRoot,
      mcpUrl: input.mcpUrl,
      issuer: input.issuer,
      tokenEndpoint: input.tokenEndpoint,
      clientId: input.clientId,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
      createdAt: input.createdAt,
      expiresAt: input.expiresAt,
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
    if (!(await this.canAccessProject(projectId))) return undefined;
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
    hostId?: string | null | undefined;
    t3ProjectId: string;
    t3ProjectTitle: string;
    workspaceRoot?: string | null | undefined;
    now?: number;
  }): Promise<T3ProjectMapping> {
    if (!(await this.canAccessProject(input.projectId))) throw new NotFoundError("project", input.projectId);
    const updatedAt = input.now ?? Date.now();
    let hostId = input.hostId;
    const previous = await this.getProjectMapping(input.projectId);
    if (hostId === undefined) {
      if (previous?.hostId) {
        hostId = previous.hostId;
      } else {
        const primaryHost = await this.getConnection();
        hostId = primaryHost?.id ?? null;
      }
    }
    if (hostId && !(await this.getConnection(hostId))) throw new NotFoundError("t3_host", hostId);
    if (previous && (previous.hostId !== hostId || previous.t3ProjectId !== input.t3ProjectId)) {
      await this.assertProjectIdle(input.projectId);
    }
    let workspaceRoot: string | null;
    if (input.workspaceRoot !== undefined) {
      workspaceRoot = input.workspaceRoot === null ? null : normalizeHostFolderPath(input.workspaceRoot);
    } else if (
      previous &&
      (previous.hostId ?? null) === (hostId ?? null) &&
      previous.t3ProjectId === input.t3ProjectId
    ) {
      workspaceRoot = previous.workspaceRoot ?? null;
    } else {
      workspaceRoot = null;
    }
    const record: T3ProjectMappingRecord = {
      projectId: input.projectId,
      hostId: hostId ?? null,
      t3ProjectId: input.t3ProjectId,
      t3ProjectTitle: input.t3ProjectTitle,
      workspaceRoot,
      updatedAt,
    };
    await this.db
      .insert(t3ProjectMappings)
      .values(record)
      .onConflictDoUpdate({
        target: t3ProjectMappings.projectId,
        set: {
          hostId: record.hostId,
          t3ProjectId: record.t3ProjectId,
          t3ProjectTitle: record.t3ProjectTitle,
          workspaceRoot: record.workspaceRoot,
          updatedAt: record.updatedAt,
        },
      });
    return toProjectMapping(record);
  }

  async deleteProjectMapping(projectId: string): Promise<void> {
    if (!(await this.canAccessProject(projectId))) throw new NotFoundError("project", projectId);
    await this.assertProjectIdle(projectId);
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
    if (!(await this.canAccessTask(taskId))) return undefined;
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.taskId, taskId))
      .limit(1);
    const row = rows[0];
    return row ? toAgentRun(row) : undefined;
  }

  async saveAgentRun(input: SaveAgentRunInput): Promise<AgentRun> {
    if (!(await this.canAccessTask(input.taskId))) throw new NotFoundError("task", input.taskId);
    const hostId = input.hostId ?? (await this.getConnection())?.id;
    const record: AgentRunRecord = {
      branch: null,
      headSha: null,
      diffStat: null,
      pullRequestUrls: null,
      id: input.id,
      taskId: input.taskId,
      hostId: hostId ?? null,
      t3ProjectId: input.t3ProjectId,
      threadId: input.threadId,
      link: input.link ?? null,
      state: input.state,
      model: input.model ?? null,
      providerInstanceId: input.providerInstanceId ?? null,
      modelOptions: serializeModelOptions(input.modelOptions),
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
          branch: null,
          headSha: null,
          diffStat: null,
          pullRequestUrls: null,
          id: record.id,
          hostId: record.hostId,
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

  /** Compare run and thread identity in SQL so a stale report cannot update a replacement run. */
  async updateAgentRunGitMetadata(
    taskId: string,
    runId: string | undefined,
    threadId: string,
    metadata: T3GitMetadata,
    now = Date.now(),
  ): Promise<AgentRun | undefined> {
    const parsed = T3GitMetadataSchema.parse(metadata);
    const whereClause = runId
      ? and(eq(agentRuns.taskId, taskId), eq(agentRuns.id, runId), eq(agentRuns.threadId, threadId))
      : and(eq(agentRuns.taskId, taskId), eq(agentRuns.threadId, threadId));
    let nextDiffStat = parsed.diffStat;
    if (
      nextDiffStat?.filesChanged === 0 &&
      nextDiffStat.insertions === 0 &&
      nextDiffStat.deletions === 0
    ) {
      const existingRows = await this.db.select().from(agentRuns).where(whereClause).limit(1);
      const existingRun = existingRows[0] ? toAgentRun(existingRows[0]) : undefined;
      if (
        existingRun?.diffStat &&
        (existingRun.diffStat.filesChanged > 0 ||
          existingRun.diffStat.insertions > 0 ||
          existingRun.diffStat.deletions > 0)
      ) {
        nextDiffStat = existingRun.diffStat;
      }
    }
    const rows = await this.db.update(agentRuns).set({
      ...(parsed.branch !== undefined ? { branch: parsed.branch } : {}),
      ...(parsed.headSha !== undefined ? { headSha: parsed.headSha } : {}),
      ...(nextDiffStat !== undefined ? { diffStat: nextDiffStat === null ? null : JSON.stringify(nextDiffStat) } : {}),
      ...(parsed.pullRequestUrls !== undefined ? { pullRequestUrls: JSON.stringify(parsed.pullRequestUrls) } : {}),
      updatedAt: now,
    }).where(whereClause).returning();
    return rows[0] ? toAgentRun(rows[0]) : undefined;
  }

  async updateAgentRunState(
    taskId: string,
    patch: { state: AgentRunState; threadId?: string | undefined; link?: string | undefined; now?: number },
  ): Promise<AgentRun | undefined> {
    const existing = await this.getAgentRunByTaskId(taskId);
    if (!existing) {
      return undefined;
    }
    const updatedAt = patch.now ?? Date.now();
    const nextThreadId = patch.threadId ?? existing.threadId;
    const nextLink = patch.link ?? existing.link ?? null;
    await this.db
      .update(agentRuns)
      .set({
        state: patch.state,
        threadId: nextThreadId,
        link: nextLink,
        updatedAt,
      })
      .where(eq(agentRuns.taskId, taskId));
    return {
      ...existing,
      threadId: nextThreadId,
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
    if (projectId && !(await this.canAccessProject(projectId))) return [];
    if (projectId !== undefined) {
      const rows = await this.db
        .select()
        .from(projectT3Threads)
        .where(eq(projectT3Threads.projectId, projectId))
        .orderBy(desc(projectT3Threads.startedAt), desc(projectT3Threads.id));
      return rows.map(toProjectT3Thread);
    }
    if (!this.explicitOrgScope) {
      const rows = await this.db
        .select()
        .from(projectT3Threads)
        .orderBy(desc(projectT3Threads.startedAt), desc(projectT3Threads.id));
      return rows.map(toProjectT3Thread);
    }
    const orgProjectIds = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, this.orgId));
    const rows = await this.db
      .select()
      .from(projectT3Threads)
      .where(inArray(projectT3Threads.projectId, orgProjectIds))
      .orderBy(desc(projectT3Threads.startedAt), desc(projectT3Threads.id));
    return rows.map(toProjectT3Thread);
  }

  /** The project's thread with this T3 thread ID; `undefined` when it belongs to another project. */
  async getProjectThread(projectId: string, threadId: string, hostId?: string): Promise<ProjectT3Thread | undefined> {
    if (!(await this.canAccessProject(projectId))) return undefined;
    const rows = await this.db
      .select()
      .from(projectT3Threads)
      .where(and(eq(projectT3Threads.projectId, projectId), eq(projectT3Threads.threadId, threadId),
        hostId === undefined ? undefined : eq(projectT3Threads.hostId, hostId)))
      .orderBy(desc(projectT3Threads.startedAt), desc(projectT3Threads.id))
      .limit(2);
    if (rows.length > 1) {
      throw new ValidationError("t3Thread", [{ code: "custom", path: ["hostId"], message: "This thread ID exists on multiple hosts. Select its recorded host." }]);
    }
    const row = rows[0];
    return row ? toProjectT3Thread(row) : undefined;
  }

  async deleteProjectThread(projectId: string, threadId: string, hostId?: string): Promise<boolean> {
    const existing = await this.getProjectThread(projectId, threadId, hostId);
    if (!existing) return false;
    const deleted = await this.db
      .delete(projectT3Threads)
      .where(eq(projectT3Threads.id, existing.id))
      .returning({ id: projectT3Threads.id });
    return deleted.length > 0;
  }

  async saveProjectThread(input: SaveProjectT3ThreadInput): Promise<ProjectT3Thread> {
    if (!(await this.canAccessProject(input.projectId))) throw new NotFoundError("project", input.projectId);
    const hostId = input.hostId ?? (await this.getConnection())?.id;
    const record: ProjectT3ThreadRecord = {
      id: input.id,
      projectId: input.projectId,
      hostId: hostId ?? null,
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
    patch: { state: AgentRunState; link?: string | undefined; now?: number; hostId?: string | undefined },
  ): Promise<ProjectT3Thread | undefined> {
    const existing = await this.getProjectThread(projectId, threadId, patch.hostId);
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
    patch: { selection: T3ModelSelection; now?: number; hostId?: string | undefined },
  ): Promise<ProjectT3Thread | undefined> {
    const existing = await this.getProjectThread(projectId, threadId, patch.hostId);
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
