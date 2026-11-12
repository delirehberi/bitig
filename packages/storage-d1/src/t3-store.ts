import { and, asc, desc, eq, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  AgentRunChildSchema,
  AgentRunChildStateSchema,
  AgentRunSchema,
  AiRouterApiStyleSchema,
  DEFAULT_MAX_PARALLEL_CHILDREN,
  DEFAULT_ORGANISATION_ID,
  DEFAULT_RUN_LEVELS,
  NotFoundError,
  OrgAiRouterSettingsSchema,
  ProjectBusyError,
  ProjectRunSettingsSchema,
  ProjectT3ThreadSchema,
  RunLevelDescriptionSchema,
  RunLevelKeySchema,
  RunLevelLabelSchema,
  RunLevelModelBindingSchema,
  RunLevelSchema,
  RunProfileTouchesSchema,
  T3GitMetadataSchema,
  T3ModelSelectionOptionsSchema,
  T3ModelSelectionSchema,
  T3ProjectMappingSchema,
  TaskRunProfileSchema,
  UpsertProjectRunSettingsInputSchema,
  ValidationError,
  canOverwriteRunProfile,
  defaultIdGenerator,
  defaultT3HostProjectsRoot,
  isActiveAgentRunState,
  normalizeHostFolderPath,
  parseOrThrow,
  sortRunLevels,
  toTimestamp,
  type AgentRun,
  type AgentRunChild,
  type AgentRunChildState,
  type AgentRunState,
  type AiRouterApiStyle,
  type OrgAiRouterSettings,
  type ProjectRunSettings,
  type ProjectT3Thread,
  type RunLevel,
  type RunLevelModelBinding,
  type RunProfileSource,
  type RunSelectionSource,
  type T3GitMetadata,
  type T3HostKind,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3ProjectMapping,
  type T3WorkspaceStrategy,
  type TaskActor,
  type TaskRunProfile,
  type UpsertProjectRunSettingsInput,
} from "@bitig/core";
import * as schema from "./schema";
import { T3RequestStore } from "./t3-request-store";
import {
  agentRunChildren,
  agentRuns,
  orgAiRouterSettings,
  organisations,
  projectRunSettings,
  projects,
  projectT3Threads,
  runLevelModels,
  runLevels,
  t3Connections,
  t3OauthStates,
  t3ProjectMappings,
  taskRunProfiles,
  tasks,
  type AgentRunChildRecord,
  type AgentRunRecord,
  type OrgAiRouterSettingsRecord,
  type ProjectRunSettingsRecord,
  type ProjectT3ThreadRecord,
  type RunLevelModelRecord,
  type RunLevelRecord,
  type T3ConnectionRecord,
  type T3OauthStateRecord,
  type T3ProjectMappingRecord,
  type TaskRunProfileRecord,
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
  modelSource?: RunSelectionSource | undefined;
  levelKey?: string | undefined;
  skippedReason?: string | undefined;
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
      if (key === "diffStat" && value !== null && typeof value === "object" && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        if (
          typeof obj.filesChanged === "number" &&
          typeof obj.insertions === "number" &&
          typeof obj.deletions === "number"
        ) {
          const parsedDiff = T3GitMetadataSchema.safeParse({
            diffStat: {
              filesChanged: obj.filesChanged,
              insertions: obj.insertions,
              deletions: obj.deletions,
            },
          });
          if (parsedDiff.success) Object.assign(metadata, parsedDiff.data);
          else console.warn("ignoring invalid agent run Git metadata", "diffStat");
        } else if (obj.diffStat !== undefined && obj.diffStat !== null) {
          const parsedDiff = T3GitMetadataSchema.safeParse({ diffStat: obj.diffStat });
          if (parsedDiff.success) Object.assign(metadata, parsedDiff.data);
          else console.warn("ignoring invalid agent run Git metadata", "diffStat");
        }
        for (const extraKey of ["worktreePath", "dirty", "uncommittedChanges", "changedPaths"] as const) {
          if (obj[extraKey] !== undefined && obj[extraKey] !== null) {
            const parsedExtra = T3GitMetadataSchema.safeParse({ [extraKey]: obj[extraKey] });
            if (parsedExtra.success) Object.assign(metadata, parsedExtra.data);
          }
        }
        continue;
      }
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
    ...(row.modelSource !== null ? { modelSource: row.modelSource } : {}),
    ...(row.levelKey !== null ? { levelKey: row.levelKey } : {}),
    ...(row.modelSkipReason !== null ? { skippedReason: row.modelSkipReason } : {}),
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
      modelSource: input.modelSource ?? null,
      levelKey: input.levelKey ?? null,
      modelSkipReason: input.skippedReason ?? null,
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
          modelSource: record.modelSource,
          levelKey: record.levelKey,
          modelSkipReason: record.modelSkipReason,
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
    const hasEnvelopeUpdate =
      parsed.diffStat !== undefined ||
      parsed.worktreePath !== undefined ||
      parsed.dirty !== undefined ||
      parsed.uncommittedChanges !== undefined ||
      parsed.changedPaths !== undefined;

    let serializedDiffStat: string | null | undefined;
    if (hasEnvelopeUpdate) {
      const existingRows = await this.db.select().from(agentRuns).where(whereClause).limit(1);
      const existingRun = existingRows[0] ? toAgentRun(existingRows[0]) : undefined;
      let nextDiffStat = parsed.diffStat === undefined ? existingRun?.diffStat : parsed.diffStat;
      if (
        nextDiffStat?.filesChanged === 0 &&
        nextDiffStat.insertions === 0 &&
        nextDiffStat.deletions === 0 &&
        existingRun?.diffStat &&
        (existingRun.diffStat.filesChanged > 0 ||
          existingRun.diffStat.insertions > 0 ||
          existingRun.diffStat.deletions > 0)
      ) {
        nextDiffStat = existingRun.diffStat;
      }
      const nextWorktreePath =
        parsed.worktreePath === undefined ? existingRun?.worktreePath : parsed.worktreePath;
      const nextDirty =
        parsed.dirty !== undefined
          ? parsed.dirty
          : parsed.uncommittedChanges !== undefined
            ? parsed.uncommittedChanges
            : existingRun?.dirty;
      const nextUncommittedChanges =
        parsed.uncommittedChanges !== undefined
          ? parsed.uncommittedChanges
          : parsed.dirty !== undefined && existingRun?.uncommittedChanges !== undefined
            ? parsed.dirty
            : existingRun?.uncommittedChanges;
      const nextChangedPaths =
        parsed.changedPaths === undefined ? existingRun?.changedPaths : parsed.changedPaths;

      const envelope: Record<string, unknown> = {
        ...(nextDiffStat ?? {}),
        ...(nextWorktreePath ? { worktreePath: nextWorktreePath } : {}),
        ...(nextDirty !== undefined && nextDirty !== null ? { dirty: nextDirty } : {}),
        ...(nextUncommittedChanges !== undefined && nextUncommittedChanges !== null
          ? { uncommittedChanges: nextUncommittedChanges }
          : {}),
        ...(nextChangedPaths ? { changedPaths: nextChangedPaths } : {}),
      };
      serializedDiffStat = Object.keys(envelope).length > 0 ? JSON.stringify(envelope) : null;
    }

    const rows = await this.db.update(agentRuns).set({
      ...(parsed.branch !== undefined ? { branch: parsed.branch } : {}),
      ...(parsed.headSha !== undefined ? { headSha: parsed.headSha } : {}),
      ...(serializedDiffStat !== undefined ? { diffStat: serializedDiffStat } : {}),
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
        modelSource: "explicit",
        levelKey: null,
        modelSkipReason: null,
        updatedAt,
      })
      .where(eq(agentRuns.taskId, taskId));
    const updated: AgentRun = {
      ...existing,
      model: patch.selection.model,
      providerInstanceId: patch.selection.providerInstanceId,
      modelSource: "explicit",
      updatedAt: toTimestamp(new Date(updatedAt)),
    };
    delete updated.levelKey;
    delete updated.skippedReason;
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

  // ---------------------------------------------------------------------------
  // Run Levels & Run Level Models (#BIT-185)
  // ---------------------------------------------------------------------------

  private async ensureDefaultRunLevelsSeeded(now = Date.now()): Promise<RunLevelRecord[]> {
    const existing = await this.db
      .select()
      .from(runLevels)
      .where(eq(runLevels.orgId, this.orgId))
      .orderBy(asc(runLevels.sortOrder), asc(runLevels.key));
    if (existing.length > 0) {
      return existing;
    }

    // Ensure the organisation row exists if foreign keys are enabled in D1 before seeding.
    const orgRow = await T3D1Store.ignoreMissingTable(
      this.db
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, this.orgId))
        .get(),
      undefined,
    );
    if (orgRow === undefined) {
      await T3D1Store.ignoreMissingTable(
        this.db
          .insert(organisations)
          .values({
            id: this.orgId,
            name: this.orgId === DEFAULT_ORGANISATION_ID ? "Default Organisation" : this.orgId,
            slug: this.orgId === DEFAULT_ORGANISATION_ID ? "default" : `org-${this.orgId.slice(0, 12)}`,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoNothing(),
        undefined,
      );
    }

    for (const def of DEFAULT_RUN_LEVELS) {
      await this.db
        .insert(runLevels)
        .values({
          orgId: this.orgId,
          key: def.key,
          label: def.label,
          description: def.description,
          sortOrder: def.order,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    return await this.db
      .select()
      .from(runLevels)
      .where(eq(runLevels.orgId, this.orgId))
      .orderBy(asc(runLevels.sortOrder), asc(runLevels.key));
  }

  /**
   * Lists the organisation's ordered run levels (#BIT-185).
   * Seeds `cheap`, `standard`, and `strong` (`DEFAULT_RUN_LEVELS`) when first read for an organisation.
   * When `hostId` is given, resolves each level's `selection` using the host-specific binding if
   * present, falling back to the default (`host_id IS NULL`) binding. When `hostId` is omitted or `null`,
   * uses the default (`host_id IS NULL`) binding.
   */
  async listRunLevels(options?: { hostId?: string | null | undefined; now?: number }): Promise<RunLevel[]> {
    const levelRows = await this.ensureDefaultRunLevelsSeeded(options?.now);
    const modelRows = await this.db
      .select()
      .from(runLevelModels)
      .where(eq(runLevelModels.orgId, this.orgId));

    const defaultByKey = new Map<string, T3ModelSelection>();
    const hostByKey = new Map<string, T3ModelSelection>();
    const targetHostId = nonEmptyTrimmed(options?.hostId);

    for (const row of modelRows) {
      const sel = toRunLevelSelection(row);
      if (!sel) continue;
      if (row.hostId === null) {
        defaultByKey.set(row.levelKey, sel);
      } else if (targetHostId && row.hostId === targetHostId) {
        hostByKey.set(row.levelKey, sel);
      }
    }

    return sortRunLevels(
      levelRows.map((row) => {
        const selection = (targetHostId ? hostByKey.get(row.key) : undefined) ?? defaultByKey.get(row.key);
        return RunLevelSchema.parse({
          key: row.key,
          label: row.label,
          description: row.description,
          order: row.sortOrder,
          ...(selection ? { selection } : {}),
        });
      }),
    );
  }

  async getRunLevel(
    key: string,
    options?: { hostId?: string | null | undefined; now?: number },
  ): Promise<RunLevel | undefined> {
    const normalizedKey = parseOrThrow(RunLevelKeySchema, key, "getRunLevel key");
    const levels = await this.listRunLevels(options);
    return levels.find((level) => level.key === normalizedKey);
  }

  async listRunLevelModels(): Promise<RunLevelModelBinding[]> {
    await this.ensureDefaultRunLevelsSeeded();
    const rows = await this.db
      .select()
      .from(runLevelModels)
      .where(eq(runLevelModels.orgId, this.orgId))
      .orderBy(asc(runLevelModels.levelKey), asc(runLevelModels.hostId));
    const bindings: RunLevelModelBinding[] = [];
    for (const row of rows) {
      const selection = toRunLevelSelection(row);
      if (!selection) continue;
      bindings.push(
        RunLevelModelBindingSchema.parse({
          levelKey: row.levelKey,
          hostId: row.hostId,
          selection,
          updatedAt: toTimestamp(new Date(row.updatedAt)),
        }),
      );
    }
    return bindings;
  }

  async upsertRunLevel(input: UpsertRunLevelInput): Promise<RunLevel> {
    const now = input.now ?? Date.now();
    const existingRows = await this.ensureDefaultRunLevelsSeeded(now);
    const key = parseOrThrow(RunLevelKeySchema, input.key, "upsertRunLevel key");
    const label = parseOrThrow(RunLevelLabelSchema, input.label, "upsertRunLevel label");
    const description = parseOrThrow(
      RunLevelDescriptionSchema,
      input.description,
      "upsertRunLevel description",
    );
    const existing = existingRows.find((r) => r.key === key);
    const maxOrder = existingRows.reduce((max, r) => Math.max(max, r.sortOrder), -1);
    const sortOrder =
      input.order !== undefined
        ? Math.max(0, Math.floor(input.order))
        : (existing?.sortOrder ?? maxOrder + 1);

    if (existing) {
      await this.db
        .update(runLevels)
        .set({
          label,
          description,
          sortOrder,
          updatedAt: now,
        })
        .where(and(eq(runLevels.orgId, this.orgId), eq(runLevels.key, key)));
    } else {
      await this.db.insert(runLevels).values({
        orgId: this.orgId,
        key,
        label,
        description,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      });
    }

    if (input.selection !== undefined) {
      if (input.selection === null) {
        await this.deleteRunLevelModel(key, null);
      } else {
        await this.setRunLevelModel({
          levelKey: key,
          hostId: null,
          selection: input.selection,
          now,
        });
      }
    }

    const updated = await this.getRunLevel(key, { now });
    if (!updated) {
      throw new NotFoundError("run_level", key);
    }
    return updated;
  }

  async setRunLevelModel(input: SetRunLevelModelInput): Promise<RunLevelModelBinding> {
    const now = input.now ?? Date.now();
    const levelKey = parseOrThrow(RunLevelKeySchema, input.levelKey, "setRunLevelModel levelKey");
    const selection = parseOrThrow(T3ModelSelectionSchema, input.selection, "setRunLevelModel selection");
    const hostId = nonEmptyTrimmed(input.hostId);

    const existingLevels = await this.ensureDefaultRunLevelsSeeded(now);
    if (!existingLevels.some((l) => l.key === levelKey)) {
      throw new NotFoundError("run_level", levelKey);
    }
    if (hostId !== null && !(await this.getConnection(hostId))) {
      throw new NotFoundError("t3_host", hostId);
    }

    const options = selection.options && selection.options.length > 0 ? [...selection.options] : null;
    const whereClause =
      hostId === null
        ? and(
            eq(runLevelModels.orgId, this.orgId),
            eq(runLevelModels.levelKey, levelKey),
            isNull(runLevelModels.hostId),
          )
        : and(
            eq(runLevelModels.orgId, this.orgId),
            eq(runLevelModels.levelKey, levelKey),
            eq(runLevelModels.hostId, hostId),
          );

    const existing = await this.db.select().from(runLevelModels).where(whereClause).get();
    if (existing) {
      await this.db
        .update(runLevelModels)
        .set({
          providerInstanceId: selection.providerInstanceId,
          model: selection.model,
          options,
          updatedAt: now,
        })
        .where(whereClause);
    } else {
      await this.db.insert(runLevelModels).values({
        orgId: this.orgId,
        levelKey,
        hostId,
        providerInstanceId: selection.providerInstanceId,
        model: selection.model,
        options,
        updatedAt: now,
      });
    }

    return RunLevelModelBindingSchema.parse({
      levelKey,
      hostId,
      selection,
      updatedAt: toTimestamp(new Date(now)),
    });
  }

  async deleteRunLevelModel(levelKey: string, hostId?: string | null): Promise<boolean> {
    const normalizedKey = parseOrThrow(RunLevelKeySchema, levelKey, "deleteRunLevelModel levelKey");
    const normalizedHostId = nonEmptyTrimmed(hostId);
    const whereClause =
      normalizedHostId === null
        ? and(
            eq(runLevelModels.orgId, this.orgId),
            eq(runLevelModels.levelKey, normalizedKey),
            isNull(runLevelModels.hostId),
          )
        : and(
            eq(runLevelModels.orgId, this.orgId),
            eq(runLevelModels.levelKey, normalizedKey),
            eq(runLevelModels.hostId, normalizedHostId),
          );
    const deleted = await this.db
      .delete(runLevelModels)
      .where(whereClause)
      .returning({ levelKey: runLevelModels.levelKey });
    return deleted.length > 0;
  }

  private async findRunLevelReferences(levelKeys: readonly string[]): Promise<{
    taskIds: string[];
    projectIds: string[];
  }> {
    if (levelKeys.length === 0) {
      return { taskIds: [], projectIds: [] };
    }
    const orgProjectIds = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, this.orgId));
    const orgTaskIds = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.projectId, orgProjectIds));

    const [taskRefs, projectRefs] = await Promise.all([
      T3D1Store.ignoreMissingTable(
        this.db
          .select({ taskId: taskRunProfiles.taskId })
          .from(taskRunProfiles)
          .where(
            and(
              inArray(taskRunProfiles.taskId, orgTaskIds),
              inArray(taskRunProfiles.levelKey, [...levelKeys]),
            ),
          ),
        [],
      ),
      T3D1Store.ignoreMissingTable(
        this.db
          .select({ projectId: projectRunSettings.projectId })
          .from(projectRunSettings)
          .where(
            and(
              inArray(projectRunSettings.projectId, orgProjectIds),
              inArray(projectRunSettings.defaultRunLevel, [...levelKeys]),
            ),
          ),
        [],
      ),
    ]);

    return {
      taskIds: taskRefs.map((r) => r.taskId),
      projectIds: projectRefs.map((r) => r.projectId),
    };
  }

  private async reassignRunLevelReferences(
    fromKeys: readonly string[],
    toKey: string,
    now: number,
  ): Promise<void> {
    if (fromKeys.length === 0) return;
    const orgProjectIds = this.db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.orgId, this.orgId));
    const orgTaskIds = this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(inArray(tasks.projectId, orgProjectIds));

    await this.db
      .update(taskRunProfiles)
      .set({ levelKey: toKey, updatedAt: now })
      .where(
        and(
          inArray(taskRunProfiles.taskId, orgTaskIds),
          inArray(taskRunProfiles.levelKey, [...fromKeys]),
        ),
      );

    await this.db
      .update(projectRunSettings)
      .set({ defaultRunLevel: toKey, updatedAt: now })
      .where(
        and(
          inArray(projectRunSettings.projectId, orgProjectIds),
          inArray(projectRunSettings.defaultRunLevel, [...fromKeys]),
        ),
      );
  }

  /**
   * Deletes a run level from the organisation (#BIT-185).
   * Refuses deletion when any task run profile or project default run level in the organisation
   * still uses `key`, unless `options.replacementKey` names another existing level in the organisation
   * (in which case those references are updated to `replacementKey`).
   */
  async deleteRunLevel(
    key: string,
    options?: { replacementKey?: string | null | undefined; now?: number },
  ): Promise<boolean> {
    const now = options?.now ?? Date.now();
    const normalizedKey = parseOrThrow(RunLevelKeySchema, key, "deleteRunLevel key");
    const existingRows = await this.ensureDefaultRunLevelsSeeded(now);
    if (!existingRows.some((r) => r.key === normalizedKey)) {
      return false;
    }
    if (existingRows.length <= 1) {
      throw new ValidationError("runLevel", [
        {
          code: "custom",
          path: ["key"],
          message: "An organisation must keep at least one run level.",
          input: normalizedKey,
        },
      ]);
    }

    const rawReplacement = options?.replacementKey?.trim();
    const replacementKey = rawReplacement
      ? parseOrThrow(RunLevelKeySchema, rawReplacement, "deleteRunLevel replacementKey")
      : undefined;

    if (replacementKey !== undefined) {
      if (replacementKey === normalizedKey) {
        throw new ValidationError("runLevel", [
          {
            code: "custom",
            path: ["replacementKey"],
            message: `Replacement level "${replacementKey}" must be different from the deleted level "${normalizedKey}".`,
            input: replacementKey,
          },
        ]);
      }
      if (!existingRows.some((r) => r.key === replacementKey)) {
        throw new ValidationError("runLevel", [
          {
            code: "custom",
            path: ["replacementKey"],
            message: `Replacement run level "${replacementKey}" does not exist in this organisation.`,
            input: replacementKey,
          },
        ]);
      }
    }

    const refs = await this.findRunLevelReferences([normalizedKey]);
    if (refs.taskIds.length > 0 || refs.projectIds.length > 0) {
      if (!replacementKey) {
        const parts: string[] = [];
        if (refs.taskIds.length > 0) {
          parts.push(`${String(refs.taskIds.length)} task${refs.taskIds.length === 1 ? "" : "s"}`);
        }
        if (refs.projectIds.length > 0) {
          parts.push(`${String(refs.projectIds.length)} project${refs.projectIds.length === 1 ? "" : "s"}`);
        }
        throw new ValidationError("runLevel", [
          {
            code: "custom",
            path: ["replacementKey"],
            message: `Run level "${normalizedKey}" is still used by ${parts.join(" and ")}. Pass a replacementKey to reassign them before deleting.`,
            input: normalizedKey,
          },
        ]);
      }
      await this.reassignRunLevelReferences([normalizedKey], replacementKey, now);
    }

    await this.db
      .delete(runLevelModels)
      .where(and(eq(runLevelModels.orgId, this.orgId), eq(runLevelModels.levelKey, normalizedKey)));
    const deleted = await this.db
      .delete(runLevels)
      .where(and(eq(runLevels.orgId, this.orgId), eq(runLevels.key, normalizedKey)))
      .returning({ key: runLevels.key });
    return deleted.length > 0;
  }

  /**
   * Replaces the organisation's ordered list of run levels and optional model bindings in one call (#BIT-185, #BIT-186).
   * If any previously existing level is removed and still referenced by tasks or projects in the organisation,
   * refuses unless `replacementKeys` (or `defaultReplacementKey`) maps it to a kept level.
   */
  async saveRunLevels(input: SaveRunLevelsInput): Promise<RunLevel[]> {
    const now = input.now ?? Date.now();
    if (input.levels.length === 0) {
      throw new ValidationError("runLevelMap", [
        {
          code: "custom",
          path: ["levels"],
          message: "An organisation must keep at least one run level.",
        },
      ]);
    }

    const normalizedLevels = input.levels.map((item, idx) => ({
      key: parseOrThrow(RunLevelKeySchema, item.key, `saveRunLevels levels[${String(idx)}].key`),
      label: parseOrThrow(RunLevelLabelSchema, item.label, `saveRunLevels levels[${String(idx)}].label`),
      description: parseOrThrow(
        RunLevelDescriptionSchema,
        item.description,
        `saveRunLevels levels[${String(idx)}].description`,
      ),
      order: item.order !== undefined ? Math.max(0, Math.floor(item.order)) : idx,
      selection:
        item.selection === undefined
          ? undefined
          : item.selection === null
            ? null
            : parseOrThrow(
                T3ModelSelectionSchema,
                item.selection,
                `saveRunLevels levels[${String(idx)}].selection`,
              ),
    }));

    const seenKeys = new Set<string>();
    for (const level of normalizedLevels) {
      if (seenKeys.has(level.key)) {
        throw new ValidationError("runLevelMap", [
          {
            code: "custom",
            path: ["levels"],
            message: `Duplicate run level key "${level.key}"`,
            input: level.key,
          },
        ]);
      }
      seenKeys.add(level.key);
    }

    const existingRows = await this.ensureDefaultRunLevelsSeeded(now);
    const existingByKey = new Map(existingRows.map((r) => [r.key, r]));
    const removedKeys = existingRows.map((r) => r.key).filter((k) => !seenKeys.has(k));

    for (const removedKey of removedKeys) {
      const refs = await this.findRunLevelReferences([removedKey]);
      if (refs.taskIds.length === 0 && refs.projectIds.length === 0) {
        continue;
      }
      const rawReplacement =
        nonEmptyTrimmed(input.replacementKeys?.[removedKey]) ??
        nonEmptyTrimmed(input.defaultReplacementKey);
      if (!rawReplacement) {
        throw new ValidationError("runLevel", [
          {
            code: "custom",
            path: ["replacementKey"],
            message: `Run level "${removedKey}" is still used by tasks or projects. Pass a replacementKey to reassign them before removing it.`,
            input: removedKey,
          },
        ]);
      }
      const replacementKey = parseOrThrow(
        RunLevelKeySchema,
        rawReplacement,
        "saveRunLevels replacementKey",
      );
      if (!seenKeys.has(replacementKey)) {
        throw new ValidationError("runLevel", [
          {
            code: "custom",
            path: ["replacementKey"],
            message: `Replacement run level "${replacementKey}" is not in the saved run levels.`,
            input: replacementKey,
          },
        ]);
      }
      await this.reassignRunLevelReferences([removedKey], replacementKey, now);
    }

    if (removedKeys.length > 0) {
      await this.db
        .delete(runLevelModels)
        .where(
          and(
            eq(runLevelModels.orgId, this.orgId),
            notInArray(runLevelModels.levelKey, [...seenKeys]),
          ),
        );
      await this.db
        .delete(runLevels)
        .where(and(eq(runLevels.orgId, this.orgId), notInArray(runLevels.key, [...seenKeys])));
    }

    if (input.models !== undefined) {
      await this.db.delete(runLevelModels).where(eq(runLevelModels.orgId, this.orgId));
    }

    for (const level of normalizedLevels) {
      const prev = existingByKey.get(level.key);
      if (prev) {
        await this.db
          .update(runLevels)
          .set({
            label: level.label,
            description: level.description,
            sortOrder: level.order,
            updatedAt: now,
          })
          .where(and(eq(runLevels.orgId, this.orgId), eq(runLevels.key, level.key)));
      } else {
        await this.db.insert(runLevels).values({
          orgId: this.orgId,
          key: level.key,
          label: level.label,
          description: level.description,
          sortOrder: level.order,
          createdAt: now,
          updatedAt: now,
        });
      }

      if (level.selection !== undefined) {
        if (level.selection === null) {
          await this.deleteRunLevelModel(level.key, null);
        } else {
          await this.setRunLevelModel({
            levelKey: level.key,
            hostId: null,
            selection: level.selection,
            now,
          });
        }
      }
    }

    if (input.models !== undefined) {
      for (const binding of input.models) {
        if (!seenKeys.has(binding.levelKey.trim().toLowerCase())) {
          throw new NotFoundError("run_level", binding.levelKey);
        }
        await this.setRunLevelModel({
          levelKey: binding.levelKey,
          hostId: binding.hostId ?? null,
          selection: binding.selection,
          now,
        });
      }
    }

    return await this.listRunLevels({ now });
  }

  // ---------------------------------------------------------------------------
  // Per-Organisation AI Router Settings (#BIT-185, #BIT-187)
  // ---------------------------------------------------------------------------

  async getAiRouterSettingsRecord(): Promise<OrgAiRouterSettingsRecord | undefined> {
    const rows = await this.db
      .select()
      .from(orgAiRouterSettings)
      .where(eq(orgAiRouterSettings.orgId, this.orgId))
      .limit(1);
    return rows[0];
  }

  async getAiRouterSettings(): Promise<OrgAiRouterSettings | undefined> {
    const row = await this.getAiRouterSettingsRecord();
    return row ? toOrgAiRouterSettings(row) : undefined;
  }

  async saveAiRouterSettings(input: SaveOrgAiRouterSettingsInput): Promise<OrgAiRouterSettings> {
    const now = input.now ?? Date.now();
    const baseUrl = input.baseUrl.trim();
    const model = input.model.trim();
    if (!baseUrl) {
      throw new ValidationError("aiRouterSettings", [
        { code: "custom", path: ["baseUrl"], message: "baseUrl is required" },
      ]);
    }
    if (!model) {
      throw new ValidationError("aiRouterSettings", [
        { code: "custom", path: ["model"], message: "model is required" },
      ]);
    }
    const apiStyle = parseOrThrow(
      AiRouterApiStyleSchema,
      input.apiStyle ?? "cloudflare-run",
      "saveAiRouterSettings apiStyle",
    );

    const existing = await this.getAiRouterSettingsRecord();
    let encryptedApiToken = existing?.encryptedApiToken ?? null;
    let tokenIv = existing?.tokenIv ?? null;
    let tokenLast4 = existing?.tokenLast4 ?? null;

    if (input.clearToken === true || input.encryptedApiToken === null) {
      encryptedApiToken = null;
      tokenIv = null;
      tokenLast4 = null;
    } else if (input.encryptedApiToken !== undefined) {
      if (!input.tokenIv) {
        throw new ValidationError("aiRouterSettings", [
          { code: "custom", path: ["tokenIv"], message: "tokenIv is required when setting encryptedApiToken" },
        ]);
      }
      encryptedApiToken = input.encryptedApiToken;
      tokenIv = input.tokenIv;
      tokenLast4 = nonEmptyTrimmed(input.tokenLast4)?.slice(-4) ?? null;
    }

    const enabled = input.enabled ?? existing?.enabled ?? false;
    const updatedBy =
      input.updatedBy === undefined
        ? (existing?.updatedBy ?? null)
        : nonEmptyTrimmed(input.updatedBy);

    // Ensure organisation row exists if FK checks are enabled
    const orgRow = await T3D1Store.ignoreMissingTable(
      this.db
        .select({ id: organisations.id })
        .from(organisations)
        .where(eq(organisations.id, this.orgId))
        .get(),
      undefined,
    );
    if (orgRow === undefined) {
      await T3D1Store.ignoreMissingTable(
        this.db
          .insert(organisations)
          .values({
            id: this.orgId,
            name: this.orgId === DEFAULT_ORGANISATION_ID ? "Default Organisation" : this.orgId,
            slug: this.orgId === DEFAULT_ORGANISATION_ID ? "default" : `org-${this.orgId.slice(0, 12)}`,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          })
          .onConflictDoNothing(),
        undefined,
      );
    }

    const record: OrgAiRouterSettingsRecord = {
      orgId: this.orgId,
      baseUrl,
      model,
      apiStyle,
      encryptedApiToken,
      tokenIv,
      tokenLast4,
      enabled,
      updatedBy,
      updatedAt: now,
    };

    await this.db
      .insert(orgAiRouterSettings)
      .values(record)
      .onConflictDoUpdate({
        target: orgAiRouterSettings.orgId,
        set: {
          baseUrl: record.baseUrl,
          model: record.model,
          apiStyle: record.apiStyle,
          encryptedApiToken: record.encryptedApiToken,
          tokenIv: record.tokenIv,
          tokenLast4: record.tokenLast4,
          enabled: record.enabled,
          updatedBy: record.updatedBy,
          updatedAt: record.updatedAt,
        },
      });

    return toOrgAiRouterSettings(record);
  }

  async deleteAiRouterSettings(): Promise<boolean> {
    const deleted = await this.db
      .delete(orgAiRouterSettings)
      .where(eq(orgAiRouterSettings.orgId, this.orgId))
      .returning({ orgId: orgAiRouterSettings.orgId });
    return deleted.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Task Run Profiles (#BIT-185)
  // ---------------------------------------------------------------------------

  async getTaskRunProfile(taskId: string): Promise<StoredTaskRunProfile | undefined> {
    if (!(await this.canAccessTask(taskId))) return undefined;
    const rows = await this.db
      .select()
      .from(taskRunProfiles)
      .where(eq(taskRunProfiles.taskId, taskId))
      .limit(1);
    const row = rows[0];
    return row ? toStoredTaskRunProfile(row) : undefined;
  }

  async listTaskRunProfiles(projectId?: string): Promise<StoredTaskRunProfile[]> {
    if (projectId !== undefined) {
      if (!(await this.canAccessProject(projectId))) return [];
      const projectTaskIds = this.db
        .select({ id: tasks.id })
        .from(tasks)
        .where(eq(tasks.projectId, projectId));
      const rows = await this.db
        .select()
        .from(taskRunProfiles)
        .where(inArray(taskRunProfiles.taskId, projectTaskIds));
      return rows.map(toStoredTaskRunProfile);
    }
    if (!this.explicitOrgScope) {
      const rows = await this.db.select().from(taskRunProfiles);
      return rows.map(toStoredTaskRunProfile);
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
      .from(taskRunProfiles)
      .where(inArray(taskRunProfiles.taskId, orgTaskIds));
    return rows.map(toStoredTaskRunProfile);
  }

  /**
   * Creates or updates a task's run profile (#BIT-185).
   * Enforces `canOverwriteRunProfile` so a `manual` profile is never overwritten by `agent` or `router`,
   * and an `agent` profile is never overwritten by `router`. When an incoming write is rejected by
   * source precedence, returns the existing stored profile unchanged.
   */
  async saveTaskRunProfile(input: SaveTaskRunProfileInput): Promise<StoredTaskRunProfile> {
    if (!(await this.canAccessTask(input.taskId))) {
      throw new NotFoundError("task", input.taskId);
    }
    const existing = await this.getTaskRunProfile(input.taskId);
    const source: RunProfileSource = input.source ?? "agent";
    if (existing && !canOverwriteRunProfile(existing, source)) {
      return existing;
    }

    const now = input.now ?? Date.now();
    const nextLevel = input.level === undefined ? existing?.level : (input.level ?? undefined);
    const nextEffort = input.effort === undefined ? existing?.effort : (input.effort ?? undefined);
    const nextSelection =
      input.selection === undefined ? existing?.selection : (input.selection ?? undefined);
    const nextTouches =
      input.touches === undefined ? existing?.touches : (input.touches ?? undefined);
    const nextParallelSafe =
      input.parallelSafe === undefined ? existing?.parallelSafe : (input.parallelSafe ?? undefined);
    const nextReason = input.reason === undefined ? existing?.reason : (input.reason ?? undefined);
    const nextConfidence =
      input.confidence === undefined ? existing?.confidence : (input.confidence ?? undefined);
    const nextUpdatedBy =
      input.updatedBy === undefined
        ? (existing?.updatedBy ?? null)
        : nonEmptyTrimmed(input.updatedBy);

    const parsedProfile = parseOrThrow(
      TaskRunProfileSchema,
      {
        ...(nextLevel !== undefined ? { level: nextLevel } : {}),
        ...(nextEffort !== undefined ? { effort: nextEffort } : {}),
        ...(nextSelection !== undefined ? { selection: nextSelection } : {}),
        ...(nextTouches !== undefined ? { touches: nextTouches } : {}),
        ...(nextParallelSafe !== undefined ? { parallelSafe: nextParallelSafe } : {}),
        source,
        ...(nextReason !== undefined ? { reason: nextReason } : {}),
        ...(nextConfidence !== undefined ? { confidence: nextConfidence } : {}),
      },
      "saveTaskRunProfile",
    );

    let recordOptions: T3ModelSelectionOption[] | null = null;
    if (parsedProfile.selection?.options && parsedProfile.selection.options.length > 0) {
      recordOptions = [...parsedProfile.selection.options];
    } else if (parsedProfile.effort !== undefined) {
      recordOptions = [{ id: "effort", value: parsedProfile.effort }];
    }

    const record: TaskRunProfileRecord = {
      taskId: input.taskId,
      levelKey: parsedProfile.level ?? null,
      providerInstanceId: parsedProfile.selection?.providerInstanceId ?? null,
      model: parsedProfile.selection?.model ?? null,
      options: recordOptions,
      touches: parsedProfile.touches ? [...parsedProfile.touches] : null,
      parallelSafe: parsedProfile.parallelSafe ?? null,
      source: parsedProfile.source,
      reason: parsedProfile.reason ?? null,
      confidence: parsedProfile.confidence ?? null,
      updatedBy: nextUpdatedBy,
      updatedAt: now,
    };

    await this.db
      .insert(taskRunProfiles)
      .values(record)
      .onConflictDoUpdate({
        target: taskRunProfiles.taskId,
        set: {
          levelKey: record.levelKey,
          providerInstanceId: record.providerInstanceId,
          model: record.model,
          options: record.options,
          touches: record.touches,
          parallelSafe: record.parallelSafe,
          source: record.source,
          reason: record.reason,
          confidence: record.confidence,
          updatedBy: record.updatedBy,
          updatedAt: record.updatedAt,
        },
      });

    return toStoredTaskRunProfile(record);
  }

  async deleteTaskRunProfile(taskId: string): Promise<boolean> {
    if (!(await this.canAccessTask(taskId))) return false;
    const deleted = await this.db
      .delete(taskRunProfiles)
      .where(eq(taskRunProfiles.taskId, taskId))
      .returning({ taskId: taskRunProfiles.taskId });
    return deleted.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Project Run Settings (#BIT-185)
  // ---------------------------------------------------------------------------

  async getProjectRunSettings(projectId: string): Promise<ProjectRunSettings | undefined> {
    if (!(await this.canAccessProject(projectId))) return undefined;
    const rows = await this.db
      .select()
      .from(projectRunSettings)
      .where(eq(projectRunSettings.projectId, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return ProjectRunSettingsSchema.parse({
        projectId,
        serialPaths: [],
        maxParallelChildren: DEFAULT_MAX_PARALLEL_CHILDREN,
      });
    }
    return toProjectRunSettings(row);
  }

  async upsertProjectRunSettings(
    projectId: string,
    input: UpsertProjectRunSettingsInput & { now?: number },
  ): Promise<ProjectRunSettings> {
    if (!(await this.canAccessProject(projectId))) {
      throw new NotFoundError("project", projectId);
    }
    const now = input.now ?? Date.now();
    const parsed = parseOrThrow(
      UpsertProjectRunSettingsInputSchema,
      {
        ...(input.defaultRunLevel !== undefined ? { defaultRunLevel: input.defaultRunLevel } : {}),
        ...(input.serialPaths !== undefined ? { serialPaths: input.serialPaths } : {}),
        ...(input.maxParallelChildren !== undefined
          ? { maxParallelChildren: input.maxParallelChildren }
          : {}),
      },
      "upsertProjectRunSettings",
    );

    const existingRows = await this.db
      .select()
      .from(projectRunSettings)
      .where(eq(projectRunSettings.projectId, projectId))
      .limit(1);
    const existing = existingRows[0];

    let nextDefaultLevel: string | null;
    if (parsed.defaultRunLevel === undefined) {
      nextDefaultLevel = existing?.defaultRunLevel ?? null;
    } else {
      nextDefaultLevel = parsed.defaultRunLevel;
    }

    if (nextDefaultLevel !== null) {
      const levels = await this.ensureDefaultRunLevelsSeeded(now);
      if (!levels.some((l) => l.key === nextDefaultLevel)) {
        throw new ValidationError("projectRunSettings", [
          {
            code: "custom",
            path: ["defaultRunLevel"],
            message: `Run level "${nextDefaultLevel}" does not exist in this organisation.`,
            input: nextDefaultLevel,
          },
        ]);
      }
    }

    const nextSerialPaths =
      parsed.serialPaths !== undefined
        ? [...parsed.serialPaths]
        : (existing?.serialPaths ?? null);
    const nextMaxParallel =
      parsed.maxParallelChildren ?? existing?.maxParallelChildren ?? DEFAULT_MAX_PARALLEL_CHILDREN;

    const record: ProjectRunSettingsRecord = {
      projectId,
      defaultRunLevel: nextDefaultLevel,
      serialPaths: nextSerialPaths,
      maxParallelChildren: nextMaxParallel,
      updatedAt: now,
    };

    await this.db
      .insert(projectRunSettings)
      .values(record)
      .onConflictDoUpdate({
        target: projectRunSettings.projectId,
        set: {
          defaultRunLevel: record.defaultRunLevel,
          serialPaths: record.serialPaths,
          maxParallelChildren: record.maxParallelChildren,
          updatedAt: record.updatedAt,
        },
      });

    return toProjectRunSettings(record);
  }

  async deleteProjectRunSettings(projectId: string): Promise<boolean> {
    if (!(await this.canAccessProject(projectId))) return false;
    const deleted = await this.db
      .delete(projectRunSettings)
      .where(eq(projectRunSettings.projectId, projectId))
      .returning({ projectId: projectRunSettings.projectId });
    return deleted.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Agent Run Children (#BIT-185, #BIT-189, #BIT-190)
  // ---------------------------------------------------------------------------

  async addAgentRunChild(input: AddAgentRunChildInput): Promise<AgentRunChild> {
    if (!(await this.canAccessTask(input.parentTaskId))) {
      throw new NotFoundError("task", input.parentTaskId);
    }
    if (!(await this.canAccessTask(input.childTaskId))) {
      throw new NotFoundError("task", input.childTaskId);
    }
    const startedAt = input.startedAt ?? Date.now();
    const state = parseOrThrow(
      AgentRunChildStateSchema,
      input.state ?? "running",
      "addAgentRunChild state",
    );
    const finishedAt =
      input.finishedAt !== undefined
        ? input.finishedAt
        : state === "running"
          ? null
          : startedAt;

    const record: AgentRunChildRecord = {
      parentTaskId: input.parentTaskId,
      childTaskId: input.childTaskId,
      state,
      branch: nonEmptyTrimmed(input.branch),
      headSha: nonEmptyTrimmed(input.headSha),
      mergedAt: null,
      mergedSha: null,
      startedAt,
      finishedAt,
    };

    await this.db
      .insert(agentRunChildren)
      .values(record)
      .onConflictDoUpdate({
        target: [agentRunChildren.parentTaskId, agentRunChildren.childTaskId],
        set: {
          state: record.state,
          branch: record.branch,
          headSha: record.headSha,
          mergedAt: record.mergedAt,
          mergedSha: record.mergedSha,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt,
        },
      });

    return toAgentRunChild(record);
  }

  async getAgentRunChild(
    parentTaskId: string,
    childTaskId: string,
  ): Promise<AgentRunChild | undefined> {
    if (!(await this.canAccessTask(parentTaskId))) return undefined;
    const rows = await this.db
      .select()
      .from(agentRunChildren)
      .where(
        and(
          eq(agentRunChildren.parentTaskId, parentTaskId),
          eq(agentRunChildren.childTaskId, childTaskId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row ? toAgentRunChild(row) : undefined;
  }

  async listAgentRunChildren(parentTaskId: string): Promise<AgentRunChild[]> {
    if (!(await this.canAccessTask(parentTaskId))) return [];
    const rows = await this.db
      .select()
      .from(agentRunChildren)
      .where(eq(agentRunChildren.parentTaskId, parentTaskId))
      .orderBy(asc(agentRunChildren.startedAt), asc(agentRunChildren.childTaskId));
    return rows.map(toAgentRunChild);
  }

  async listAgentRunParentsForChild(childTaskId: string): Promise<AgentRunChild[]> {
    if (!(await this.canAccessTask(childTaskId))) return [];
    const rows = await this.db
      .select()
      .from(agentRunChildren)
      .where(eq(agentRunChildren.childTaskId, childTaskId))
      .orderBy(asc(agentRunChildren.startedAt), asc(agentRunChildren.parentTaskId));
    return rows.map(toAgentRunChild);
  }

  async updateAgentRunChild(
    parentTaskId: string,
    childTaskId: string,
    patch: UpdateAgentRunChildInput,
  ): Promise<AgentRunChild | undefined> {
    const existing = await this.getAgentRunChild(parentTaskId, childTaskId);
    if (!existing) return undefined;

    const now = patch.now ?? Date.now();
    const nextState =
      patch.state !== undefined
        ? parseOrThrow(AgentRunChildStateSchema, patch.state, "updateAgentRunChild state")
        : existing.state;
    const nextBranch =
      patch.branch === undefined ? (existing.branch ?? null) : nonEmptyTrimmed(patch.branch);
    const nextHeadSha =
      patch.headSha === undefined ? (existing.headSha ?? null) : nonEmptyTrimmed(patch.headSha);
    const nextMergedAt =
      patch.mergedAt === undefined
        ? (existing.mergedAt ? Date.parse(existing.mergedAt) : null)
        : patch.mergedAt;
    const nextMergedSha =
      patch.mergedSha === undefined
        ? (existing.mergedSha ?? null)
        : nonEmptyTrimmed(patch.mergedSha);
    const nextFinishedAt =
      patch.finishedAt !== undefined
        ? patch.finishedAt
        : nextState === "running"
          ? null
          : (existing.finishedAt ? Date.parse(existing.finishedAt) : now);

    const rows = await this.db
      .update(agentRunChildren)
      .set({
        state: nextState,
        branch: nextBranch,
        headSha: nextHeadSha,
        mergedAt: nextMergedAt,
        mergedSha: nextMergedSha,
        finishedAt: nextFinishedAt,
      })
      .where(
        and(
          eq(agentRunChildren.parentTaskId, parentTaskId),
          eq(agentRunChildren.childTaskId, childTaskId),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toAgentRunChild(row) : undefined;
  }

  /**
   * Transitions a child from `running` to a non-running state (`done`, `failed`, `needs_human`,
   * `stopped`) in a single conditional update (#BIT-185, #BIT-189). Only one concurrent caller
   * can claim a running child's transition.
   */
  async claimAgentRunChild(
    parentTaskId: string,
    childTaskId: string,
    patch: {
      state: Exclude<AgentRunChildState, "running">;
      branch?: string | null | undefined;
      headSha?: string | null | undefined;
      finishedAt?: number | null | undefined;
      now?: number | undefined;
    },
  ): Promise<AgentRunChild | undefined> {
    if (!(await this.canAccessTask(parentTaskId))) return undefined;
    const nextState = parseOrThrow(
      AgentRunChildStateSchema,
      patch.state,
      "claimAgentRunChild state",
    );
    const now = patch.now ?? Date.now();
    const finishedAt = patch.finishedAt === undefined ? now : patch.finishedAt;
    const rows = await this.db
      .update(agentRunChildren)
      .set({
        state: nextState,
        ...(patch.branch !== undefined ? { branch: nonEmptyTrimmed(patch.branch) } : {}),
        ...(patch.headSha !== undefined ? { headSha: nonEmptyTrimmed(patch.headSha) } : {}),
        finishedAt,
      })
      .where(
        and(
          eq(agentRunChildren.parentTaskId, parentTaskId),
          eq(agentRunChildren.childTaskId, childTaskId),
          eq(agentRunChildren.state, "running"),
        ),
      )
      .returning();
    const row = rows[0];
    return row ? toAgentRunChild(row) : undefined;
  }

  async recordAgentRunChildMerge(
    parentTaskId: string,
    childTaskId: string,
    patch: { mergedSha: string; mergedAt?: number },
  ): Promise<AgentRunChild | undefined> {
    const mergedAt = patch.mergedAt ?? Date.now();
    return await this.updateAgentRunChild(parentTaskId, childTaskId, {
      mergedSha: patch.mergedSha,
      mergedAt,
      now: mergedAt,
    });
  }

  async removeAgentRunChild(parentTaskId: string, childTaskId: string): Promise<boolean> {
    if (!(await this.canAccessTask(parentTaskId))) return false;
    const deleted = await this.db
      .delete(agentRunChildren)
      .where(
        and(
          eq(agentRunChildren.parentTaskId, parentTaskId),
          eq(agentRunChildren.childTaskId, childTaskId),
        ),
      )
      .returning({ childTaskId: agentRunChildren.childTaskId });
    return deleted.length > 0;
  }

  async clearAgentRunChildren(parentTaskId: string): Promise<number> {
    if (!(await this.canAccessTask(parentTaskId))) return 0;
    const deleted = await this.db
      .delete(agentRunChildren)
      .where(eq(agentRunChildren.parentTaskId, parentTaskId))
      .returning({ childTaskId: agentRunChildren.childTaskId });
    return deleted.length;
  }
}

export interface UpsertRunLevelInput {
  key: string;
  label: string;
  description: string;
  order?: number | undefined;
  selection?: T3ModelSelection | null | undefined;
  now?: number | undefined;
}

export interface SetRunLevelModelInput {
  levelKey: string;
  hostId?: string | null | undefined;
  selection: T3ModelSelection;
  now?: number | undefined;
}

export interface SaveRunLevelsInput {
  levels: readonly {
    key: string;
    label: string;
    description: string;
    order?: number | undefined;
    selection?: T3ModelSelection | null | undefined;
  }[];
  models?: readonly {
    levelKey: string;
    hostId?: string | null | undefined;
    selection: T3ModelSelection;
  }[] | undefined;
  replacementKeys?: Readonly<Record<string, string>> | undefined;
  defaultReplacementKey?: string | null | undefined;
  now?: number | undefined;
}

export interface SaveOrgAiRouterSettingsInput {
  baseUrl: string;
  model: string;
  apiStyle?: AiRouterApiStyle | undefined;
  encryptedApiToken?: string | null | undefined;
  tokenIv?: string | null | undefined;
  tokenLast4?: string | null | undefined;
  clearToken?: boolean | undefined;
  enabled?: boolean | undefined;
  updatedBy?: string | null | undefined;
  now?: number | undefined;
}

export interface StoredTaskRunProfile extends TaskRunProfile {
  readonly taskId: string;
  readonly updatedBy?: string | undefined;
  readonly updatedAt: string;
}

export interface SaveTaskRunProfileInput {
  taskId: string;
  level?: string | null | undefined;
  effort?: string | null | undefined;
  selection?: T3ModelSelection | null | undefined;
  touches?: readonly string[] | null | undefined;
  parallelSafe?: boolean | null | undefined;
  source?: RunProfileSource | undefined;
  reason?: string | null | undefined;
  confidence?: number | null | undefined;
  updatedBy?: string | null | undefined;
  now?: number | undefined;
}

export interface AddAgentRunChildInput {
  parentTaskId: string;
  childTaskId: string;
  state?: AgentRunChildState | undefined;
  branch?: string | null | undefined;
  headSha?: string | null | undefined;
  startedAt?: number | undefined;
  finishedAt?: number | null | undefined;
}

export interface UpdateAgentRunChildInput {
  state?: AgentRunChildState | undefined;
  branch?: string | null | undefined;
  headSha?: string | null | undefined;
  mergedAt?: number | null | undefined;
  mergedSha?: string | null | undefined;
  finishedAt?: number | null | undefined;
  now?: number | undefined;
}

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toRunLevelSelection(row: RunLevelModelRecord): T3ModelSelection | undefined {
  const parsed = T3ModelSelectionSchema.safeParse({
    providerInstanceId: row.providerInstanceId,
    model: row.model,
    ...(row.options && row.options.length > 0 ? { options: row.options } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

function toOrgAiRouterSettings(row: OrgAiRouterSettingsRecord): OrgAiRouterSettings {
  const hasToken = Boolean(row.encryptedApiToken && row.tokenIv);
  return OrgAiRouterSettingsSchema.parse({
    orgId: row.orgId,
    baseUrl: row.baseUrl,
    model: row.model,
    apiStyle: row.apiStyle,
    hasToken,
    ...(hasToken && row.tokenLast4 ? { tokenLast4: row.tokenLast4 } : {}),
    enabled: row.enabled,
    ...(row.updatedBy ? { updatedBy: row.updatedBy } : {}),
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  });
}

function toStoredTaskRunProfile(row: TaskRunProfileRecord): StoredTaskRunProfile {
  const selection =
    row.providerInstanceId && row.model
      ? T3ModelSelectionSchema.safeParse({
          providerInstanceId: row.providerInstanceId,
          model: row.model,
          ...(row.options && row.options.length > 0 ? { options: row.options } : {}),
        })
      : undefined;

  const effortOption =
    !selection?.success && row.options && row.options.length > 0
      ? row.options.find(
          (opt) =>
            (opt.id === "effort" || opt.id === "reasoningEffort" || opt.id === "thinkingEffort") &&
            typeof opt.value === "string" &&
            opt.value.trim().length > 0,
        )
      : undefined;

  const touches =
    row.touches && row.touches.length > 0
      ? RunProfileTouchesSchema.safeParse(row.touches)
      : undefined;

  const profile = TaskRunProfileSchema.parse({
    ...(row.levelKey !== null ? { level: row.levelKey } : {}),
    ...(effortOption && typeof effortOption.value === "string"
      ? { effort: effortOption.value.trim() }
      : {}),
    ...(selection?.success ? { selection: selection.data } : {}),
    ...(touches?.success && touches.data.length > 0 ? { touches: touches.data } : {}),
    ...(row.parallelSafe !== null ? { parallelSafe: row.parallelSafe } : {}),
    source: row.source,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.confidence !== null ? { confidence: row.confidence } : {}),
  });

  return {
    ...profile,
    taskId: row.taskId,
    ...(row.updatedBy !== null ? { updatedBy: row.updatedBy } : {}),
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  };
}

function toProjectRunSettings(row: ProjectRunSettingsRecord): ProjectRunSettings {
  const serialPaths =
    row.serialPaths && row.serialPaths.length > 0
      ? RunProfileTouchesSchema.safeParse(row.serialPaths)
      : undefined;
  return ProjectRunSettingsSchema.parse({
    projectId: row.projectId,
    ...(row.defaultRunLevel !== null ? { defaultRunLevel: row.defaultRunLevel } : {}),
    serialPaths: serialPaths?.success ? serialPaths.data : [],
    maxParallelChildren: row.maxParallelChildren,
    updatedAt: toTimestamp(new Date(row.updatedAt)),
  });
}

function toAgentRunChild(row: AgentRunChildRecord): AgentRunChild {
  return AgentRunChildSchema.parse({
    parentTaskId: row.parentTaskId,
    childTaskId: row.childTaskId,
    state: row.state,
    ...(row.branch !== null ? { branch: row.branch } : {}),
    ...(row.headSha !== null ? { headSha: row.headSha } : {}),
    ...(row.mergedAt !== null ? { mergedAt: toTimestamp(new Date(row.mergedAt)) } : {}),
    ...(row.mergedSha !== null ? { mergedSha: row.mergedSha } : {}),
    startedAt: toTimestamp(new Date(row.startedAt)),
    ...(row.finishedAt !== null ? { finishedAt: toTimestamp(new Date(row.finishedAt)) } : {}),
  });
}

