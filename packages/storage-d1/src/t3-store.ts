import { eq, lt } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  AgentRunSchema,
  T3ModelSelectionOptionsSchema,
  T3ProjectMappingSchema,
  toTimestamp,
  type AgentRun,
  type AgentRunState,
  type T3ModelSelection,
  type T3ModelSelectionOption,
  type T3ProjectMapping,
  type T3WorkspaceStrategy,
  type TaskActor,
} from "@bitig/core";
import * as schema from "./schema";
import {
  agentRuns,
  t3Connections,
  t3OauthStates,
  t3ProjectMappings,
  type AgentRunRecord,
  type T3ConnectionRecord,
  type T3OauthStateRecord,
  type T3ProjectMappingRecord,
} from "./schema";

const DEFAULT_CONNECTION_ID = "default";

export interface SaveT3ConnectionInput {
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

  constructor(d1: D1Database) {
    this.db = drizzle(d1, { schema });
  }

  async getConnection(): Promise<T3ConnectionRecord | undefined> {
    const rows = await this.db
      .select()
      .from(t3Connections)
      .where(eq(t3Connections.id, DEFAULT_CONNECTION_ID))
      .limit(1);
    return rows[0];
  }

  async saveConnection(input: SaveT3ConnectionInput): Promise<T3ConnectionRecord> {
    const now = input.now ?? Date.now();
    const record: T3ConnectionRecord = {
      id: DEFAULT_CONNECTION_ID,
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
    await this.db.delete(t3Connections).where(eq(t3Connections.id, DEFAULT_CONNECTION_ID));
  }

  async saveOauthState(input: SaveT3OauthStateInput): Promise<void> {
    await this.db.delete(t3OauthStates).where(lt(t3OauthStates.expiresAt, input.createdAt));
    await this.db.insert(t3OauthStates).values(input);
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
    const rows = await this.db.select().from(t3ProjectMappings);
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
    const rows = await this.db.select().from(agentRuns);
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
}
