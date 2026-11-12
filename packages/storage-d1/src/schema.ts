import { sqliteTable, text, integer, real, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IS_PUBLIC,
  DEFAULT_MAX_PARALLEL_CHILDREN,
  DEFAULT_ORGANISATION_ID,
  DEFAULT_PLATFORM_ROLE,
  DEFAULT_PROJECT_KIND,
  DEFAULT_TASK_STATUS,
  DEFAULT_USER_STATUS,
  DEFAULT_WEBHOOK_ENABLED,
  DEFAULT_WEBHOOK_PROVIDER,
  HOST_PROJECTS_ROOT_USER,
  type AgentRunChildState,
  type AgentRunState,
  type AiRouterApiStyle,
  type AttachmentMimeType,
  type ChecklistItem,
  type CheckpointStatus,
  type StateSnapshot,
  type CommentAuthorType,
  type OrganisationRole,
  type PlatformRole,
  type ProjectKind,
  type ProjectResource,
  type RunProfileSource,
  type T3HostKind,
  type T3ModelSelectionOption,
  type T3WorkspaceStrategy,
  type TaskActor,
  type TaskActivityEntry,
  type TaskPriority,
  type TaskStatus,
  type UserStatus,
  type WebhookMapping,
  type WebhookProvider,
} from "@bitig/core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    username: text("username").notNull(),
    displayName: text("display_name").notNull(),
    avatarUrl: text("avatar_url"),
    nip05: text("nip05"),
    platformRole: text("platform_role")
      .$type<PlatformRole>()
      .notNull()
      .default(DEFAULT_PLATFORM_ROLE),
    status: text("status").$type<UserStatus>().notNull().default(DEFAULT_USER_STATUS),
    emailVerifiedAt: integer("email_verified_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastLoginAt: integer("last_login_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    uniqueIndex("users_username_unique").on(table.username),
  ],
);

export const organisations = sqliteTable(
  "organisations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [uniqueIndex("organisations_slug_unique").on(table.slug)],
);

export const memberships = sqliteTable(
  "memberships",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<OrganisationRole>().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("memberships_org_user_unique").on(table.orgId, table.userId),
    index("memberships_user_id_idx").on(table.userId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

export type AuthCodePurpose = "sign_in" | "register" | "email_change" | "account_delete";

export interface AuthCodePayload {
  username?: string | undefined;
  displayName?: string | undefined;
  inviteToken?: string | undefined;
  userId?: string | undefined;
}

export const authCodes = sqliteTable(
  "auth_codes",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    purpose: text("purpose").$type<AuthCodePurpose>().notNull().default("sign_in"),
    codeHash: text("code_hash").notNull(),
    payload: text("payload", { mode: "json" }).$type<AuthCodePayload>(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    consumedAt: integer("consumed_at"),
  },
  (table) => [index("auth_codes_email_purpose_idx").on(table.email, table.purpose)],
);

export const invitations = sqliteTable(
  "invitations",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").$type<OrganisationRole>().notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedBy: text("invited_by")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    acceptedAt: integer("accepted_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("invitations_token_hash_unique").on(table.tokenHash),
    index("invitations_org_id_idx").on(table.orgId),
    index("invitations_email_idx").on(table.email),
  ],
);

export const accessTokens = sqliteTable(
  "access_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    prefix: text("prefix").notNull(),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("access_tokens_token_hash_unique").on(table.tokenHash),
    index("access_tokens_user_id_idx").on(table.userId),
    index("access_tokens_org_id_idx").on(table.orgId),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .default(DEFAULT_ORGANISATION_ID)
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(DEFAULT_DESCRIPTION),
    kind: text("kind").$type<ProjectKind>().notNull().default(DEFAULT_PROJECT_KIND),
    resources: text("resources", { mode: "json" }).$type<ProjectResource[]>(),
    key: text("key"),
    archived: integer("archived", { mode: "boolean" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("projects_org_id_idx").on(table.orgId),
    uniqueIndex("projects_org_key_unique").on(table.orgId, table.key),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(DEFAULT_DESCRIPTION),
    status: text("status").$type<TaskStatus>().notNull().default(DEFAULT_TASK_STATUS),
    isPublic: integer("is_public", { mode: "boolean" })
      .notNull()
      .default(DEFAULT_IS_PUBLIC),
    dueDate: text("due_date"),
    priority: text("priority").$type<TaskPriority>(),
    labels: text("labels", { mode: "json" }).$type<string[]>(),
    order: real("order"),
    checklist: text("checklist", { mode: "json" }).$type<ChecklistItem[]>(),
    needsHuman: text("needs_human"),
    pendingApproval: integer("pending_approval", { mode: "boolean" }),
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>(),
    number: integer("number"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdBy: text("created_by"),
    startedBy: text("started_by"),
    completedBy: text("completed_by"),
    updatedBy: text("updated_by"),
    activity: text("activity", { mode: "json" }).$type<TaskActivityEntry[]>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_status_idx").on(table.status),
    index("tasks_order_idx").on(table.order),
    uniqueIndex("tasks_project_number_idx").on(table.projectId, table.number),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorType: text("author_type").$type<CommentAuthorType>().notNull(),
    author: text("author"),
    authorId: text("author_id"),
    authorAvatarUrl: text("author_avatar_url"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("comments_task_id_idx").on(table.taskId)],
);

export const checkpoints = sqliteTable(
  "checkpoints",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    stepIndex: integer("step_index").notNull(),
    status: text("status").$type<CheckpointStatus>().notNull(),
    stateSnapshot: text("state_snapshot", { mode: "json" }).$type<StateSnapshot>().notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by"),
  },
  // One checkpoint per task step: saving a step again updates it in place.
  (table) => [uniqueIndex("checkpoints_task_step_idx").on(table.taskId, table.stepIndex)],
);

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").$type<WebhookProvider>().notNull().default(DEFAULT_WEBHOOK_PROVIDER),
    token: text("token").notNull(),
    enabled: integer("enabled", { mode: "boolean" })
      .notNull()
      .default(DEFAULT_WEBHOOK_ENABLED),
    mapping: text("mapping", { mode: "json" }).$type<WebhookMapping>(),
    defaultPriority: text("default_priority").$type<TaskPriority>(),
    defaultLabels: text("default_labels", { mode: "json" }).$type<string[]>(),
    triggerCount: integer("trigger_count").notNull().default(0),
    lastTriggeredAt: integer("last_triggered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("webhooks_project_id_idx").on(table.projectId),
    uniqueIndex("webhooks_token_idx").on(table.token),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mimeType: text("mime_type").$type<AttachmentMimeType>().notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by"),
  },
  (table) => [index("attachments_task_id_idx").on(table.taskId)],
);

export const t3Connections = sqliteTable(
  "t3_connections",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("01a10000-0000-7000-8000-000000000001"),
    label: text("label"),
    kind: text("kind").$type<T3HostKind>().notNull().default("user"),
    projectsRoot: text("projects_root").notNull().default(HOST_PROJECTS_ROOT_USER),
    mcpUrl: text("mcp_url").notNull(),
    issuer: text("issuer").notNull(),
    clientId: text("client_id").notNull(),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    tokenIv: text("token_iv").notNull(),
    scope: text("scope").notNull(),
    expiresAt: integer("expires_at").notNull(),
    connectedAt: integer("connected_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("t3_connections_org_mcp_url_unique").on(table.orgId, table.mcpUrl),
    index("t3_connections_org_id_idx").on(table.orgId),
  ],
);

export const t3OauthStates = sqliteTable("t3_oauth_states", {
  state: text("state").primaryKey(),
  orgId: text("org_id").notNull().default("01a10000-0000-7000-8000-000000000001"),
  hostId: text("host_id"),
  label: text("label"),
  kind: text("kind").$type<T3HostKind>().notNull().default("user"),
  projectsRoot: text("projects_root").notNull().default(HOST_PROJECTS_ROOT_USER),
  mcpUrl: text("mcp_url").notNull(),
  issuer: text("issuer").notNull(),
  tokenEndpoint: text("token_endpoint").notNull(),
  clientId: text("client_id").notNull(),
  codeVerifier: text("code_verifier").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const t3ProjectMappings = sqliteTable(
  "t3_project_mappings",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostId: text("host_id"),
    t3ProjectId: text("t3_project_id").notNull(),
    t3ProjectTitle: text("t3_project_title").notNull(),
    workspaceRoot: text("workspace_root"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("t3_project_mappings_host_id_idx").on(table.hostId)],
);

export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    hostId: text("host_id"),
    t3ProjectId: text("t3_project_id").notNull(),
    threadId: text("thread_id").notNull(),
    link: text("link"),
    state: text("state").$type<AgentRunState>().notNull(),
    model: text("model"),
    providerInstanceId: text("provider_instance_id"),
    /** JSON array of `{ id, value }` model options chosen on the last switch (#BIT-119) or resolved at launch (#BIT-186). */
    modelOptions: text("model_options"),
    /** Where the run's model selection came from (#BIT-186). */
    modelSource: text("model_source"),
    /** The run level key that resolved the model selection (#BIT-186). */
    levelKey: text("level_key"),
    /** Reason a higher-precedence run level rule was skipped at launch (#BIT-186). */
    modelSkipReason: text("model_skip_reason"),
    workspaceStrategy: text("workspace_strategy").$type<T3WorkspaceStrategy>(),
    branch: text("branch"),
    headSha: text("head_sha"),
    diffStat: text("diff_stat"),
    pullRequestUrls: text("pull_request_urls"),
    /** On a child task's run: the umbrella task whose session started it (#BIT-141). */
    parentTaskId: text("parent_task_id").references(() => tasks.id, { onDelete: "set null" }),
    /** On an umbrella task's run: the child task it waits on while `waiting_subagent` (#BIT-141). */
    waitingForTaskId: text("waiting_for_task_id").references(() => tasks.id, { onDelete: "set null" }),
    startedBy: text("started_by").$type<TaskActor>(),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("agent_runs_task_id_idx").on(table.taskId),
    index("agent_runs_thread_id_idx").on(table.threadId),
    index("agent_runs_host_thread_idx").on(table.hostId, table.threadId),
    index("agent_runs_waiting_for_task_id_idx").on(table.waitingForTaskId),
  ],
);

/** T3 threads Bitig started for a project without a task (#BIT-127). */
export const projectT3Threads = sqliteTable(
  "project_t3_threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostId: text("host_id"),
    t3ProjectId: text("t3_project_id").notNull(),
    threadId: text("thread_id").notNull(),
    title: text("title").notNull(),
    link: text("link"),
    state: text("state").$type<AgentRunState>().notNull(),
    model: text("model"),
    providerInstanceId: text("provider_instance_id"),
    /** JSON array of `{ id, value }` model options, as in `agent_runs.model_options`. */
    modelOptions: text("model_options"),
    workspaceStrategy: text("workspace_strategy").$type<T3WorkspaceStrategy>().notNull(),
    startedBy: text("started_by").$type<TaskActor>(),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_t3_threads_host_thread_idx").on(table.hostId, table.threadId),
    index("project_t3_threads_thread_id_idx").on(table.threadId),
    index("project_t3_threads_project_id_idx").on(table.projectId),
  ],
);

export const mcpTokens = sqliteTable(
  "mcp_tokens",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id").notNull().default("01a10000-0000-7000-8000-000000000001"),
    label: text("label").notNull(),
    transport: text("transport", { enum: ["bearer", "query"] }).notNull(),
    digest: text("digest").notNull().unique(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("mcp_tokens_org_id_idx").on(table.orgId),
    check("mcp_tokens_transport_check", sql`${table.transport} IN ('bearer', 'query')`),
  ],
);

export type T3RunRequestKind = "launch" | "reply" | "message";
export type T3RunRequestState = "queued" | "dispatching" | "delivered" | "failed" | "cancelled";

export const t3RunRequests = sqliteTable(
  "t3_run_requests",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    orgId: text("org_id").notNull(),
    hostId: text("host_id"),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").$type<T3RunRequestKind>().notNull(),
    payload: text("payload").notNull(),
    state: text("state").$type<T3RunRequestState>().notNull().default("queued"),
    claimToken: text("claim_token"),
    leaseUntil: integer("lease_until"),
    attempted: integer("attempted").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("t3_run_requests_pending_idx").on(table.orgId, table.taskId, table.state, table.sequence),
  ],
);

export type UserRecord = typeof users.$inferSelect;
export type InsertUserRecord = typeof users.$inferInsert;
export type OrganisationRecord = typeof organisations.$inferSelect;
export type InsertOrganisationRecord = typeof organisations.$inferInsert;
export type MembershipRecord = typeof memberships.$inferSelect;
export type InsertMembershipRecord = typeof memberships.$inferInsert;
export type SessionRecord = typeof sessions.$inferSelect;
export type InsertSessionRecord = typeof sessions.$inferInsert;
export type AuthCodeRecord = typeof authCodes.$inferSelect;
export type InsertAuthCodeRecord = typeof authCodes.$inferInsert;
export type InvitationRecord = typeof invitations.$inferSelect;
export type InsertInvitationRecord = typeof invitations.$inferInsert;
export type AccessTokenRecord = typeof accessTokens.$inferSelect;
export type InsertAccessTokenRecord = typeof accessTokens.$inferInsert;

export type ProjectRecord = typeof projects.$inferSelect;
export type InsertProjectRecord = typeof projects.$inferInsert;
export type TaskRecord = typeof tasks.$inferSelect;
export type InsertTaskRecord = typeof tasks.$inferInsert;

export type CommentRecord = typeof comments.$inferSelect;
export type InsertCommentRecord = typeof comments.$inferInsert;
export type CheckpointRecord = typeof checkpoints.$inferSelect;
export type InsertCheckpointRecord = typeof checkpoints.$inferInsert;
export type WebhookRecord = typeof webhooks.$inferSelect;
export type InsertWebhookRecord = typeof webhooks.$inferInsert;
export type ProjectT3ThreadRecord = typeof projectT3Threads.$inferSelect;
export type AttachmentRecord = typeof attachments.$inferSelect;
export type InsertAttachmentRecord = typeof attachments.$inferInsert;
export type T3ConnectionRecord = typeof t3Connections.$inferSelect;
export type InsertT3ConnectionRecord = typeof t3Connections.$inferInsert;
export type T3OauthStateRecord = typeof t3OauthStates.$inferSelect;
export type InsertT3OauthStateRecord = typeof t3OauthStates.$inferInsert;
export type T3ProjectMappingRecord = typeof t3ProjectMappings.$inferSelect;
export type InsertT3ProjectMappingRecord = typeof t3ProjectMappings.$inferInsert;
export type AgentRunRecord = typeof agentRuns.$inferSelect;
export type InsertAgentRunRecord = typeof agentRuns.$inferInsert;
export type T3RunRequestRecord = typeof t3RunRequests.$inferSelect;
export type InsertT3RunRequestRecord = typeof t3RunRequests.$inferInsert;

export const runLevels = sqliteTable(
  "run_levels",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description").notNull(),
    sortOrder: integer("sort_order").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_levels_org_key_unique").on(table.orgId, table.key),
    index("run_levels_org_sort_idx").on(table.orgId, table.sortOrder),
  ],
);

export const runLevelModels = sqliteTable(
  "run_level_models",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    levelKey: text("level_key").notNull(),
    hostId: text("host_id"),
    providerInstanceId: text("provider_instance_id").notNull(),
    model: text("model").notNull(),
    options: text("options", { mode: "json" }).$type<T3ModelSelectionOption[]>(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("run_level_models_org_level_host_unique").on(
      table.orgId,
      table.levelKey,
      table.hostId,
    ),
  ],
);

export const orgAiRouterSettings = sqliteTable("org_ai_router_settings", {
  orgId: text("org_id")
    .primaryKey()
    .references(() => organisations.id, { onDelete: "cascade" }),
  baseUrl: text("base_url").notNull(),
  model: text("model").notNull(),
  apiStyle: text("api_style").$type<AiRouterApiStyle>().notNull().default("cloudflare-run"),
  encryptedApiToken: text("encrypted_api_token"),
  tokenIv: text("token_iv"),
  tokenLast4: text("token_last4"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at").notNull(),
});

export const taskRunProfiles = sqliteTable("task_run_profiles", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  levelKey: text("level_key"),
  providerInstanceId: text("provider_instance_id"),
  model: text("model"),
  options: text("options", { mode: "json" }).$type<T3ModelSelectionOption[]>(),
  touches: text("touches", { mode: "json" }).$type<string[]>(),
  parallelSafe: integer("parallel_safe", { mode: "boolean" }),
  source: text("source").$type<RunProfileSource>().notNull(),
  reason: text("reason"),
  confidence: real("confidence"),
  updatedBy: text("updated_by"),
  updatedAt: integer("updated_at").notNull(),
});

export const projectRunSettings = sqliteTable("project_run_settings", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  defaultRunLevel: text("default_run_level"),
  serialPaths: text("serial_paths", { mode: "json" }).$type<string[]>(),
  maxParallelChildren: integer("max_parallel_children")
    .notNull()
    .default(DEFAULT_MAX_PARALLEL_CHILDREN),
  updatedAt: integer("updated_at").notNull(),
});

export const agentRunChildren = sqliteTable(
  "agent_run_children",
  {
    parentTaskId: text("parent_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    childTaskId: text("child_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    state: text("state").$type<AgentRunChildState>().notNull(),
    branch: text("branch"),
    headSha: text("head_sha"),
    mergedAt: integer("merged_at"),
    mergedSha: text("merged_sha"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("agent_run_children_parent_child_unique").on(
      table.parentTaskId,
      table.childTaskId,
    ),
    index("agent_run_children_parent_task_id_idx").on(table.parentTaskId),
    index("agent_run_children_child_task_id_idx").on(table.childTaskId),
  ],
);

export type RunLevelRecord = typeof runLevels.$inferSelect;
export type InsertRunLevelRecord = typeof runLevels.$inferInsert;
export type RunLevelModelRecord = typeof runLevelModels.$inferSelect;
export type InsertRunLevelModelRecord = typeof runLevelModels.$inferInsert;
export type OrgAiRouterSettingsRecord = typeof orgAiRouterSettings.$inferSelect;
export type InsertOrgAiRouterSettingsRecord = typeof orgAiRouterSettings.$inferInsert;
export type TaskRunProfileRecord = typeof taskRunProfiles.$inferSelect;
export type InsertTaskRunProfileRecord = typeof taskRunProfiles.$inferInsert;
export type ProjectRunSettingsRecord = typeof projectRunSettings.$inferSelect;
export type InsertProjectRunSettingsRecord = typeof projectRunSettings.$inferInsert;
export type AgentRunChildRecord = typeof agentRunChildren.$inferSelect;
export type InsertAgentRunChildRecord = typeof agentRunChildren.$inferInsert;

