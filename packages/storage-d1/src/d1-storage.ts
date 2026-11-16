import { and, count, eq, inArray, isNotNull, isNull, max, ne, or, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  CheckpointSchema,
  DEFAULT_ORGANISATION_ID,
  IdSchema,
  NotFoundError,
  ProjectBundleSchema,
  SaveCheckpointInputSchema,
  TaskFilterSchema,
  ValidationError,
  WebhookFilterSchema,
  WebhookTokenSchema,
  applyProjectPatch,
  applyTaskPatch,
  applyWebhookPatch,
  assertTaskAttachmentQuota,
  assertTaskContainment,
  assertTaskDeletable,
  assertTaskDependencies,
  assertTaskProjectMoveAllowed,
  buildAttachment,
  buildCheckpoint,
  buildComment,
  buildProject,
  buildTask,
  buildWebhook,
  cloneAttachment,
  cloneComment,
  cloneProject,
  cloneTask,
  cloneWebhook,
  compareAttachments,
  compareCheckpoints,
  compareComments,
  compareProjects,
  compareTasks,
  compareWebhooks,
  completeTaskEntity,
  defaultRuntimeDeps,
  hasNewDependencies,
  parseOrThrow,
  recordWebhookTriggerEntity,
  renumberTask,
  stripAttachmentData,
  throwIfAborted,
  touchTaskEntity,
  toTimestamp,
  withTaskAttachmentCount,
  withTaskCommentCount,
  type Attachment,
  type AttachmentContent,
  type BackupBundle,
  type Checkpoint,
  type Comment,
  type ContainmentNode,
  type CreateAttachmentInput,
  type SaveCheckpointInput,
  type CreateCommentInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type CreateWebhookInput,
  type DependencyNode,
  type OperationOptions,
  type Project,
  type ProjectBundle,
  type RuntimeDeps,
  type StorageProvider,
  type Task,
  type TaskFilter,
  type UpdateProjectInput,
  type UpdateTaskInput,
  type UpdateWebhookInput,
  type Webhook,
  type WebhookFilter,
} from "@bitig/core";
import * as schema from "./schema";
import {
  agentRunChildren,
  agentRuns,
  attachments,
  checkpoints,
  comments,
  feedbackEntries,
  feedbackForms,
  projectRunSettings,
  projects,
  projectT3Threads,
  t3ProjectMappings,
  t3RunRequests,
  taskRunProfiles,
  tasks,
  webhooks,
  type AttachmentRecord,
  type CheckpointRecord,
  type CommentRecord,
  type InsertAttachmentRecord,
  type InsertCheckpointRecord,
  type InsertCommentRecord,
  type InsertWebhookRecord,
  type ProjectRecord,
  type TaskRecord,
  type WebhookRecord,
} from "./schema";

export interface AttachmentBlobObject {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface AttachmentBlobStore {
  put(
    key: string,
    value: Uint8Array | ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<AttachmentBlobObject | null>;
  delete(keys: string | string[]): Promise<unknown>;
}

class InMemoryAttachmentBlobStore implements AttachmentBlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  put(key: string, value: Uint8Array | ArrayBuffer): Promise<unknown> {
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
    this.#blobs.set(key, bytes);
    return Promise.resolve();
  }

  get(key: string): Promise<AttachmentBlobObject | null> {
    const bytes = this.#blobs.get(key);
    if (!bytes) return Promise.resolve(null);
    return Promise.resolve({
      arrayBuffer: () => {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        return Promise.resolve(copy.buffer);
      },
    });
  }

  delete(keys: string | string[]): Promise<unknown> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      this.#blobs.delete(key);
    }
    return Promise.resolve();
  }
}

export interface D1StorageOptions {
  readonly db: D1Database | DrizzleD1Database<typeof schema>;
  readonly bucket?: AttachmentBlobStore;
  readonly deps?: RuntimeDeps;
  readonly orgId?: string;
}

function attachmentBlobKey(taskId: string, attachmentId: string): string {
  return `tasks/${taskId}/attachments/${attachmentId}`;
}

function recordToAttachment(row: AttachmentRecord): Attachment {
  const attachment: Attachment = {
    id: row.id,
    taskId: row.taskId,
    name: row.name,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: new Date(row.createdAt).toISOString(),
  };
  if (row.createdBy !== null) {
    attachment.createdBy = row.createdBy;
  }
  return attachment;
}

function attachmentToRecord(attachment: Attachment): InsertAttachmentRecord {
  return {
    id: attachment.id,
    taskId: attachment.taskId,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    createdAt: Date.parse(attachment.createdAt),
    createdBy: attachment.createdBy ?? null,
  };
}

function copyProject(project: Project): Project {
  return cloneProject(project);
}

function copyTask(task: Task): Task {
  return cloneTask(task);
}

function recordToProject(row: ProjectRecord): Project {
  const project: Project = {
    id: row.id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (row.resources !== null) {
    project.resources = row.resources.map((resource) => ({ ...resource }));
  }
  if (row.key !== null) {
    project.key = row.key;
  }
  if (row.archived === true) {
    project.archived = true;
  }
  return project;
}

function recordToTask(row: TaskRecord): Task {
  const task: Task = {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    status: row.status,
    isPublic: row.isPublic,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (row.parentId !== null) {
    task.parentId = row.parentId;
  }
  if (row.dueDate !== null) {
    task.dueDate = row.dueDate;
  }
  if (row.priority !== null) {
    task.priority = row.priority;
  }
  if (row.labels !== null) {
    task.labels = [...row.labels];
  }
  if (row.order !== null) {
    task.order = row.order;
  }
  if (row.checklist !== null) {
    task.checklist = row.checklist.map((item) => ({ ...item }));
  }
  if (row.needsHuman !== null) {
    task.needsHuman = row.needsHuman;
  }
  if (row.pendingApproval === true) {
    task.pendingApproval = true;
  }
  if (row.dependsOn !== null && row.dependsOn.length > 0) {
    task.dependsOn = [...row.dependsOn];
  }
  if (row.number !== null) {
    task.number = row.number;
  }
  if (row.startedAt !== null) {
    task.startedAt = new Date(row.startedAt).toISOString();
  }
  if (row.completedAt !== null) {
    task.completedAt = new Date(row.completedAt).toISOString();
  }
  if (row.createdBy !== null) {
    task.createdBy = row.createdBy;
  }
  if (row.startedBy !== null) {
    task.startedBy = row.startedBy;
  }
  if (row.completedBy !== null) {
    task.completedBy = row.completedBy;
  }
  if (row.updatedBy !== null) {
    task.updatedBy = row.updatedBy;
  }
  if (row.activity !== null) {
    task.activity = row.activity.map((entry) => ({ ...entry }));
  }
  return task;
}

function recordToComment(row: CommentRecord): Comment {
  const comment: Comment = {
    id: row.id,
    taskId: row.taskId,
    body: row.body,
    authorType: row.authorType,
    createdAt: new Date(row.createdAt).toISOString(),
  };
  if (row.author !== null) {
    comment.author = row.author;
  }
  if (row.authorId !== null) {
    comment.authorId = row.authorId;
  }
  if (row.authorAvatarUrl !== null) {
    comment.authorAvatarUrl = row.authorAvatarUrl;
  }
  return comment;
}

function commentToRecord(comment: Comment): InsertCommentRecord {
  return {
    id: comment.id,
    taskId: comment.taskId,
    body: comment.body,
    authorType: comment.authorType,
    author: comment.author ?? null,
    authorId: comment.authorId ?? null,
    authorAvatarUrl: comment.authorAvatarUrl ?? null,
    createdAt: Date.parse(comment.createdAt),
  };
}

function recordToCheckpoint(row: CheckpointRecord): Checkpoint {
  return CheckpointSchema.parse({
    id: row.id,
    taskId: row.taskId,
    stepIndex: row.stepIndex,
    status: row.status,
    stateSnapshot: row.stateSnapshot,
    createdAt: new Date(row.createdAt).toISOString(),
    ...(row.createdBy === null ? {} : { createdBy: row.createdBy }),
  });
}

function checkpointToRecord(checkpoint: Checkpoint): InsertCheckpointRecord {
  return {
    id: checkpoint.id,
    taskId: checkpoint.taskId,
    stepIndex: checkpoint.stepIndex,
    status: checkpoint.status,
    stateSnapshot: checkpoint.stateSnapshot,
    createdAt: Date.parse(checkpoint.createdAt),
    createdBy: checkpoint.createdBy ?? null,
  };
}

function recordToWebhook(row: WebhookRecord): Webhook {
  const webhook: Webhook = {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    provider: row.provider,
    token: row.token,
    enabled: row.enabled,
    triggerCount: row.triggerCount,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
  if (row.mapping !== null) {
    const { skipPendingFeedback, ...mappingFields } = row.mapping;
    if (Object.keys(mappingFields).length > 0) {
      webhook.mapping = { ...mappingFields };
    }
    if (skipPendingFeedback === true) {
      webhook.skipPendingFeedback = true;
    }
  }
  if (row.defaultPriority !== null) {
    webhook.defaultPriority = row.defaultPriority;
  }
  if (row.defaultLabels !== null) {
    webhook.defaultLabels = [...row.defaultLabels];
  }
  if (row.lastTriggeredAt !== null) {
    webhook.lastTriggeredAt = new Date(row.lastTriggeredAt).toISOString();
  }
  return webhook;
}

function webhookToRecord(webhook: Webhook): InsertWebhookRecord {
  const mappingRecord: schema.WebhookMappingRecord = {
    ...(webhook.mapping ? { ...webhook.mapping } : {}),
    ...(webhook.skipPendingFeedback === true ? { skipPendingFeedback: true } : {}),
  };
  return {
    id: webhook.id,
    projectId: webhook.projectId,
    name: webhook.name,
    provider: webhook.provider,
    token: webhook.token,
    enabled: webhook.enabled,
    mapping: Object.keys(mappingRecord).length > 0 ? mappingRecord : null,
    defaultPriority: webhook.defaultPriority ?? null,
    defaultLabels: webhook.defaultLabels ? [...webhook.defaultLabels] : null,
    triggerCount: webhook.triggerCount,
    lastTriggeredAt: webhook.lastTriggeredAt !== undefined ? Date.parse(webhook.lastTriggeredAt) : null,
    createdAt: Date.parse(webhook.createdAt),
    updatedAt: Date.parse(webhook.updatedAt),
  };
}

const TASK_NUMBER_CONFLICT_MAX_RETRIES = 5;

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

function isTaskNumberConflict(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const msg = current.message;
    if (
      msg.includes("UNIQUE constraint failed: tasks.project_id, tasks.number") ||
      msg.includes("tasks_project_number_idx")
    ) {
      return true;
    }
  }
  return false;
}

export async function findWebhookOrgId(
  dbInput: D1Database | DrizzleD1Database<typeof schema>,
  token: string,
): Promise<string | null> {
  const parsed = WebhookTokenSchema.safeParse(token);
  if (!parsed.success) return null;
  const db = isD1Database(dbInput) ? drizzle(dbInput, { schema }) : dbInput;
  const webhookRow = await db.select({ projectId: webhooks.projectId }).from(webhooks).where(eq(webhooks.token, parsed.data)).get();
  if (!webhookRow) return null;
  const projectRow = await db.select({ orgId: projects.orgId }).from(projects).where(eq(projects.id, webhookRow.projectId)).get();
  return projectRow?.orgId ?? null;
}

export class D1Storage implements StorageProvider {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #bucket: AttachmentBlobStore;
  readonly #deps: RuntimeDeps;
  readonly #orgId: string;

  constructor(
    dbOrOptions: D1Database | DrizzleD1Database<typeof schema> | D1StorageOptions,
    maybeDeps?: RuntimeDeps,
  ) {
    if ("db" in dbOrOptions) {
      this.#db = isD1Database(dbOrOptions.db) ? drizzle(dbOrOptions.db, { schema }) : dbOrOptions.db;
      this.#bucket = dbOrOptions.bucket ?? new InMemoryAttachmentBlobStore();
      this.#deps = dbOrOptions.deps ?? defaultRuntimeDeps;
      this.#orgId = dbOrOptions.orgId ?? DEFAULT_ORGANISATION_ID;
    } else {
      this.#db = isD1Database(dbOrOptions) ? drizzle(dbOrOptions, { schema }) : dbOrOptions;
      this.#bucket = new InMemoryAttachmentBlobStore();
      this.#deps = maybeDeps ?? defaultRuntimeDeps;
      this.#orgId = DEFAULT_ORGANISATION_ID;
    }
  }

  get orgId(): string {
    return this.#orgId;
  }

  #orgProjectIds() {
    return this.#db.select({ id: projects.id }).from(projects).where(eq(projects.orgId, this.#orgId));
  }

  #orgTaskIds() {
    return this.#db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.projectId, this.#orgProjectIds()));
  }

  async getProjects(opts?: OperationOptions): Promise<Project[]> {
    throwIfAborted(opts?.signal);
    const rows = await this.#db.select().from(projects).where(eq(projects.orgId, this.#orgId)).all();
    throwIfAborted(opts?.signal);
    const result = rows.map(recordToProject);
    result.sort(compareProjects);
    return result.map(copyProject);
  }

  async getProject(id: string, opts?: OperationOptions): Promise<Project | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getProject");
    const row = await this.#db
      .select()
      .from(projects)
      .where(and(eq(projects.id, validId), eq(projects.orgId, this.#orgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return copyProject(recordToProject(row));
  }

  async createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const project = buildProject(input, this.#deps, await this.#projectKeys());
    throwIfAborted(opts?.signal);
    await this.#db.insert(projects).values({
      id: project.id,
      orgId: this.#orgId,
      name: project.name,
      description: project.description,
      kind: project.kind,
      resources: project.resources ?? null,
      key: project.key ?? null,
      archived: project.archived ?? null,
      createdAt: Date.parse(project.createdAt),
      updatedAt: Date.parse(project.updatedAt),
    });
    throwIfAborted(opts?.signal);
    return copyProject(project);
  }

  async updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateProject");
    const existingRow = await this.#db
      .select()
      .from(projects)
      .where(and(eq(projects.id, validId), eq(projects.orgId, this.#orgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("project", validId);

    const existing = recordToProject(existingRow);
    const next = applyProjectPatch(existing, patch, this.#deps.clock(), await this.#projectKeys(validId));
    throwIfAborted(opts?.signal);
    await this.#db
      .update(projects)
      .set({
        name: next.name,
        description: next.description,
        kind: next.kind,
        resources: next.resources ?? null,
        key: next.key ?? null,
        archived: next.archived ?? null,
        updatedAt: Date.parse(next.updatedAt),
      })
      .where(and(eq(projects.id, validId), eq(projects.orgId, this.#orgId)));
    throwIfAborted(opts?.signal);
    return copyProject(next);
  }

  async deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteProject");
    const existingRow = await this.#db
      .select()
      .from(projects)
      .where(and(eq(projects.id, validId), eq(projects.orgId, this.#orgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("project", validId);

    // Explicitly delete cascade to guarantee consistency across all SQLite configurations
    const projectTaskIds = this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, validId));
    const removed = new Set((await projectTaskIds.all()).map((row) => row.id));
    const attachmentRows = await this.#db
      .select({ id: attachments.id, taskId: attachments.taskId })
      .from(attachments)
      .where(inArray(attachments.taskId, projectTaskIds))
      .all();
    await this.#db.delete(attachments).where(inArray(attachments.taskId, projectTaskIds));
    if (attachmentRows.length > 0) {
      await this.#bucket.delete(attachmentRows.map((row) => attachmentBlobKey(row.taskId, row.id)));
    }
    const ignoreMissingT3Table = async (query: Promise<unknown>): Promise<void> => {
      try {
        await query;
      } catch (err) {
        const message =
          err instanceof Error
            ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
            : String(err);
        if (message.includes("no such table")) return;
        throw err;
      }
    };
    await ignoreMissingT3Table(this.#db.delete(t3RunRequests).where(inArray(t3RunRequests.taskId, projectTaskIds)));
    await ignoreMissingT3Table(this.#db.delete(taskRunProfiles).where(inArray(taskRunProfiles.taskId, projectTaskIds)));
    await ignoreMissingT3Table(
      this.#db
        .delete(agentRunChildren)
        .where(
          or(
            inArray(agentRunChildren.parentTaskId, projectTaskIds),
            inArray(agentRunChildren.childTaskId, projectTaskIds),
          ),
        ),
    );
    await ignoreMissingT3Table(this.#db.delete(agentRuns).where(inArray(agentRuns.taskId, projectTaskIds)));
    await ignoreMissingT3Table(this.#db.delete(projectT3Threads).where(eq(projectT3Threads.projectId, validId)));
    await ignoreMissingT3Table(this.#db.delete(t3ProjectMappings).where(eq(t3ProjectMappings.projectId, validId)));
    await ignoreMissingT3Table(this.#db.delete(projectRunSettings).where(eq(projectRunSettings.projectId, validId)));
    await ignoreMissingT3Table(this.#db.delete(feedbackEntries).where(eq(feedbackEntries.projectId, validId)));
    await ignoreMissingT3Table(this.#db.delete(feedbackForms).where(eq(feedbackForms.projectId, validId)));
    await this.#db.delete(comments).where(inArray(comments.taskId, projectTaskIds));
    await this.#db.delete(checkpoints).where(inArray(checkpoints.taskId, projectTaskIds));
    await this.#db.delete(tasks).where(eq(tasks.projectId, validId));
    if (removed.size > 0) await this.#dropDependencies(removed);
    await this.#db.delete(webhooks).where(eq(webhooks.projectId, validId));
    await this.#db.delete(projects).where(and(eq(projects.id, validId), eq(projects.orgId, this.#orgId)));
    throwIfAborted(opts?.signal);
  }

  async getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(TaskFilterSchema, filter, "getTasks");

    let rows: TaskRecord[];
    let commentCountRows: { taskId: string; total: number }[];
    let attachmentCountRows: { taskId: string; total: number }[];
    if (parsedFilter?.projectId !== undefined) {
      const projectTaskSubquery = this.#db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.projectId, parsedFilter.projectId), inArray(tasks.projectId, this.#orgProjectIds())));
      rows = await this.#db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, parsedFilter.projectId), inArray(tasks.projectId, this.#orgProjectIds())))
        .all();
      throwIfAborted(opts?.signal);
      commentCountRows =
        rows.length === 0
          ? []
          : await this.#db
              .select({ taskId: comments.taskId, total: count() })
              .from(comments)
              .where(inArray(comments.taskId, projectTaskSubquery))
              .groupBy(comments.taskId)
              .all();
      attachmentCountRows =
        rows.length === 0
          ? []
          : await this.#db
              .select({ taskId: attachments.taskId, total: count() })
              .from(attachments)
              .where(inArray(attachments.taskId, projectTaskSubquery))
              .groupBy(attachments.taskId)
              .all();
    } else {
      rows = await this.#db.select().from(tasks).where(inArray(tasks.projectId, this.#orgProjectIds())).all();
      throwIfAborted(opts?.signal);
      commentCountRows =
        rows.length === 0
          ? []
          : await this.#db
              .select({ taskId: comments.taskId, total: count() })
              .from(comments)
              .where(inArray(comments.taskId, this.#orgTaskIds()))
              .groupBy(comments.taskId)
              .all();
      attachmentCountRows =
        rows.length === 0
          ? []
          : await this.#db
              .select({ taskId: attachments.taskId, total: count() })
              .from(attachments)
              .where(inArray(attachments.taskId, this.#orgTaskIds()))
              .groupBy(attachments.taskId)
              .all();
    }
    throwIfAborted(opts?.signal);
    const countsByTaskId = new Map<string, number>();
    for (const entry of commentCountRows) {
      countsByTaskId.set(entry.taskId, entry.total);
    }
    const attachmentCountsByTaskId = new Map<string, number>();
    for (const entry of attachmentCountRows) {
      attachmentCountsByTaskId.set(entry.taskId, entry.total);
    }
    const result = rows.map((row) =>
      withTaskAttachmentCount(
        withTaskCommentCount(recordToTask(row), countsByTaskId.get(row.id) ?? 0),
        attachmentCountsByTaskId.get(row.id) ?? 0,
      ),
    );
    result.sort(compareTasks);
    return result;
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getTask");
    const row = await this.#db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    const total = await this.#commentCount(validId);
    const attachmentTotal = await this.#attachmentCount(validId);
    throwIfAborted(opts?.signal);
    return withTaskAttachmentCount(withTaskCommentCount(recordToTask(row), total), attachmentTotal);
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const projectId = parseOrThrow(IdSchema, input.projectId, "saveTask");
    let task = buildTask(input, this.#deps, await this.#nextTaskNumber(projectId), opts?.actor, {
      userId: opts?.userId,
      userAvatarUrl: opts?.userAvatarUrl,
    });

    const projectRow = await this.#db
      .select()
      .from(projects)
      .where(and(eq(projects.id, task.projectId), eq(projects.orgId, this.#orgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!projectRow) throw new NotFoundError("project", task.projectId);
    if (task.parentId !== undefined) {
      assertTaskContainment(task, await this.#containmentGraph(), "saveTask");
      throwIfAborted(opts?.signal);
    }
    if (hasNewDependencies(undefined, task)) {
      assertTaskDependencies(task, await this.#dependencyGraph(), "saveTask");
      throwIfAborted(opts?.signal);
    }

    for (let attempt = 0; ; attempt++) {
      try {
        if (task.parentId === undefined) {
          await this.#db.insert(tasks).values({
            id: task.id,
            projectId: task.projectId,
            parentId: null,
            title: task.title,
            description: task.description,
            status: task.status,
            isPublic: task.isPublic,
            dueDate: task.dueDate ?? null,
            priority: task.priority ?? null,
            labels: task.labels ? [...task.labels] : null,
            order: task.order ?? null,
            checklist: task.checklist ?? null,
            needsHuman: task.needsHuman ?? null,
            pendingApproval: task.pendingApproval ?? null,
            dependsOn: task.dependsOn ? [...task.dependsOn] : null,
            number: task.number ?? null,
            startedAt: task.startedAt !== undefined ? Date.parse(task.startedAt) : null,
            completedAt: task.completedAt !== undefined ? Date.parse(task.completedAt) : null,
            createdBy: task.createdBy ?? null,
            startedBy: task.startedBy ?? null,
            completedBy: task.completedBy ?? null,
            updatedBy: task.updatedBy ?? null,
            activity: task.activity ? task.activity.map((entry) => ({ ...entry })) : null,
            createdAt: Date.parse(task.createdAt),
            updatedAt: Date.parse(task.updatedAt),
          });
        } else {
          const result = await this.#db.run(sql`
            INSERT INTO tasks (
              id, project_id, parent_id, title, description, status, is_public,
              due_date, priority, labels, "order", checklist, needs_human,
              pending_approval, depends_on, number, started_at, completed_at,
              created_by, started_by, completed_by, updated_by, activity,
              created_at, updated_at
            )
            SELECT
              ${task.id},
              ${task.projectId},
              ${task.parentId},
              ${task.title},
              ${task.description},
              ${task.status},
              ${task.isPublic ? 1 : 0},
              ${task.dueDate ?? null},
              ${task.priority ?? null},
              ${task.labels ? JSON.stringify([...task.labels]) : null},
              ${task.order ?? null},
              ${task.checklist ? JSON.stringify(task.checklist) : null},
              ${task.needsHuman ?? null},
              ${task.pendingApproval ? 1 : null},
              ${task.dependsOn ? JSON.stringify([...task.dependsOn]) : null},
              ${task.number ?? null},
              ${task.startedAt !== undefined ? Date.parse(task.startedAt) : null},
              ${task.completedAt !== undefined ? Date.parse(task.completedAt) : null},
              ${task.createdBy ?? null},
              ${task.startedBy ?? null},
              ${task.completedBy ?? null},
              ${task.updatedBy ?? null},
              ${task.activity ? JSON.stringify(task.activity.map((entry) => ({ ...entry }))) : null},
              ${Date.parse(task.createdAt)},
              ${Date.parse(task.updatedAt)}
            WHERE EXISTS (
              SELECT 1 FROM projects pr
              WHERE pr.id = ${task.projectId} AND pr.org_id = ${this.#orgId}
            )
            AND EXISTS (
              SELECT 1 FROM tasks p
              WHERE p.id = ${task.parentId} AND p.project_id = ${task.projectId}
            )
          `);
          if (result.meta.changes === 0) {
            const currentProject = await this.#db
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.id, task.projectId), eq(projects.orgId, this.#orgId)))
              .get();
            if (!currentProject) throw new NotFoundError("project", task.projectId);
            assertTaskContainment(task, await this.#containmentGraph(), "saveTask");
            throw new ValidationError("saveTask", [
              {
                code: "custom",
                path: ["parentId"],
                message: `Parent task ${task.parentId} is no longer valid in project ${task.projectId}`,
                input: task.parentId,
              },
            ]);
          }
        }
        break;
      } catch (err) {
        if (attempt >= TASK_NUMBER_CONFLICT_MAX_RETRIES || !isTaskNumberConflict(err)) throw err;
        throwIfAborted(opts?.signal);
        task = renumberTask(task, await this.#nextTaskNumber(projectId));
        throwIfAborted(opts?.signal);
      }
    }
    throwIfAborted(opts?.signal);
    return copyTask(task);
  }

  async updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateTask");
    const existingRow = await this.#db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    const existing = recordToTask(existingRow);
    let next = applyTaskPatch(existing, patch, this.#deps.clock(), opts?.actor, opts?.overrideBlockedBy, {
      userId: opts?.userId,
      userAvatarUrl: opts?.userAvatarUrl,
    });
    const movedProject = next.projectId !== existing.projectId;
    const changedParent = next.parentId !== existing.parentId;

    if (movedProject) {
      const targetProject = await this.#db
        .select()
        .from(projects)
        .where(and(eq(projects.id, next.projectId), eq(projects.orgId, this.#orgId)))
        .get();
      throwIfAborted(opts?.signal);
      if (!targetProject) throw new NotFoundError("project", next.projectId);
    }

    if (movedProject || changedParent) {
      const graph = await this.#containmentGraph();
      throwIfAborted(opts?.signal);
      if (movedProject) {
        assertTaskProjectMoveAllowed(existing, next.projectId, graph, "updateTask");
      }
      assertTaskContainment(next, graph, "updateTask");
    }

    if (movedProject) {
      next = renumberTask(next, await this.#nextTaskNumber(next.projectId));
      throwIfAborted(opts?.signal);
    }
    if (hasNewDependencies(existing, next)) {
      assertTaskDependencies(next, await this.#dependencyGraph(), "updateTask");
      throwIfAborted(opts?.signal);
    }

    const whereConditions = [eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())];
    if (movedProject) {
      whereConditions.push(
        eq(tasks.projectId, existing.projectId),
        isNull(tasks.parentId),
        sql`NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = ${validId})`,
        sql`EXISTS (SELECT 1 FROM projects pr WHERE pr.id = ${next.projectId} AND pr.org_id = ${this.#orgId})`,
      );
    }
    if (next.parentId !== undefined && (changedParent || movedProject)) {
      whereConditions.push(
        sql`EXISTS (SELECT 1 FROM tasks p WHERE p.id = ${next.parentId} AND p.project_id = ${next.projectId})`,
        sql`NOT EXISTS (
          WITH RECURSIVE anc(id, depth) AS (
            SELECT ${next.parentId}, 0
            UNION ALL
            SELECT t.parent_id, anc.depth + 1
            FROM tasks t
            JOIN anc ON t.id = anc.id
            WHERE t.parent_id IS NOT NULL AND anc.depth < 1000
          )
          SELECT 1 FROM anc WHERE id = ${validId}
        )`,
      );
    }

    for (let attempt = 0; ; attempt++) {
      try {
        const updated = await this.#db
          .update(tasks)
          .set({
            projectId: next.projectId,
            parentId: next.parentId ?? null,
            title: next.title,
            description: next.description,
            status: next.status,
            isPublic: next.isPublic,
            dueDate: next.dueDate ?? null,
            priority: next.priority ?? null,
            labels: next.labels ? [...next.labels] : null,
            order: next.order ?? null,
            checklist: next.checklist ?? null,
            needsHuman: next.needsHuman ?? null,
            pendingApproval: next.pendingApproval ?? null,
            dependsOn: next.dependsOn ? [...next.dependsOn] : null,
            number: next.number ?? null,
            startedAt: next.startedAt !== undefined ? Date.parse(next.startedAt) : null,
            completedAt: next.completedAt !== undefined ? Date.parse(next.completedAt) : null,
            createdBy: next.createdBy ?? null,
            startedBy: next.startedBy ?? null,
            completedBy: next.completedBy ?? null,
            updatedBy: next.updatedBy ?? null,
            activity: next.activity ? next.activity.map((entry) => ({ ...entry })) : null,
            updatedAt: Date.parse(next.updatedAt),
          })
          .where(and(...whereConditions))
          .returning({ id: tasks.id });
        if (updated.length === 0) {
          const latestRow = await this.#db
            .select()
            .from(tasks)
            .where(and(eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())))
            .get();
          if (!latestRow) throw new NotFoundError("task", validId);
          if (movedProject) {
            const targetProject = await this.#db
              .select({ id: projects.id })
              .from(projects)
              .where(and(eq(projects.id, next.projectId), eq(projects.orgId, this.#orgId)))
              .get();
            if (!targetProject) throw new NotFoundError("project", next.projectId);
          }
          const latest = recordToTask(latestRow);
          const graph = await this.#containmentGraph();
          if (movedProject) {
            assertTaskProjectMoveAllowed(latest, next.projectId, graph, "updateTask");
          }
          assertTaskContainment(next, graph, "updateTask");
          throw new ValidationError("updateTask", [
            {
              code: "custom",
              path: ["parentId"],
              message: "Concurrent task hierarchy modification rejected",
              input: next.parentId ?? next.projectId,
            },
          ]);
        }
        break;
      } catch (err) {
        if (!movedProject || attempt >= TASK_NUMBER_CONFLICT_MAX_RETRIES || !isTaskNumberConflict(err)) throw err;
        throwIfAborted(opts?.signal);
        next = renumberTask(next, await this.#nextTaskNumber(next.projectId));
        throwIfAborted(opts?.signal);
      }
    }
    throwIfAborted(opts?.signal);
    const total = await this.#commentCount(validId);
    const attachmentTotal = await this.#attachmentCount(validId);
    throwIfAborted(opts?.signal);
    return withTaskAttachmentCount(withTaskCommentCount(next, total), attachmentTotal);
  }

  async deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteTask");
    const existingRow = await this.#db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    assertTaskDeletable(validId, await this.#containmentGraph(), "deleteTask");
    throwIfAborted(opts?.signal);

    const attachmentRows = await this.#db
      .select({ id: attachments.id })
      .from(attachments)
      .where(eq(attachments.taskId, validId))
      .all();
    throwIfAborted(opts?.signal);

    // Delete the task atomically only if no child task was attached concurrently;
    // related rows and R2 blobs are only removed once the task delete succeeds.
    const deleted = await this.#db
      .delete(tasks)
      .where(
        and(
          eq(tasks.id, validId),
          inArray(tasks.projectId, this.#orgProjectIds()),
          sql`NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = ${validId})`,
        ),
      )
      .returning({ id: tasks.id });

    if (deleted.length === 0) {
      const stillExists = await this.#db
        .select({ id: tasks.id })
        .from(tasks)
        .where(and(eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())))
        .get();
      if (!stillExists) throw new NotFoundError("task", validId);
      assertTaskDeletable(validId, await this.#containmentGraph(), "deleteTask");
      throw new ValidationError("deleteTask", [
        {
          code: "custom",
          path: ["id"],
          message: `Cannot delete task ${validId} while it still has child tasks; detach or reparent children first`,
          input: validId,
        },
      ]);
    }

    if (attachmentRows.length > 0) {
      await this.#bucket.delete(attachmentRows.map((row) => attachmentBlobKey(validId, row.id)));
    }
    const ignoreMissingT3Table = async (query: Promise<unknown>): Promise<void> => {
      try {
        await query;
      } catch (err) {
        const message =
          err instanceof Error
            ? `${err.message} ${err.cause instanceof Error ? err.cause.message : ""}`
            : String(err);
        if (message.includes("no such table")) return;
        throw err;
      }
    };
    await ignoreMissingT3Table(this.#db.delete(attachments).where(eq(attachments.taskId, validId)));
    await ignoreMissingT3Table(this.#db.delete(taskRunProfiles).where(eq(taskRunProfiles.taskId, validId)));
    await ignoreMissingT3Table(
      this.#db
        .delete(agentRunChildren)
        .where(or(eq(agentRunChildren.parentTaskId, validId), eq(agentRunChildren.childTaskId, validId))),
    );
    await ignoreMissingT3Table(
      this.#db.update(feedbackEntries).set({ taskId: null }).where(eq(feedbackEntries.taskId, validId)),
    );
    await this.#db.delete(comments).where(eq(comments.taskId, validId));
    await this.#db.delete(checkpoints).where(eq(checkpoints.taskId, validId));
    await this.#dropDependencies(new Set([validId]));
    throwIfAborted(opts?.signal);
  }

  async completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "completeTask");
    const existingRow = await this.#db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, validId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    const existing = recordToTask(existingRow);
    const next = completeTaskEntity(existing, this.#deps.clock(), opts?.actor, opts?.overrideBlockedBy, {
      userId: opts?.userId,
      userAvatarUrl: opts?.userAvatarUrl,
    });

    if (next.status !== existing.status || next.updatedAt !== existing.updatedAt) {
      await this.#db
        .update(tasks)
        .set({
          status: next.status,
          completedAt: next.completedAt !== undefined ? Date.parse(next.completedAt) : null,
          completedBy: next.completedBy ?? null,
          updatedBy: next.updatedBy ?? null,
          activity: next.activity ? next.activity.map((entry) => ({ ...entry })) : null,
          updatedAt: Date.parse(next.updatedAt),
        })
        .where(eq(tasks.id, validId));
    }
    throwIfAborted(opts?.signal);
    const total = await this.#commentCount(validId);
    const attachmentTotal = await this.#attachmentCount(validId);
    throwIfAborted(opts?.signal);
    return withTaskAttachmentCount(withTaskCommentCount(next, total), attachmentTotal);
  }

  async getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getComments");
    const rows = await this.#db
      .select()
      .from(comments)
      .where(and(eq(comments.taskId, validTaskId), inArray(comments.taskId, this.#orgTaskIds())))
      .all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToComment).sort(compareComments).map(cloneComment);
  }

  async getCheckpoints(taskId: string, opts?: OperationOptions): Promise<Checkpoint[]> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getCheckpoints");
    const rows = await this.#db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.taskId, validTaskId), inArray(checkpoints.taskId, this.#orgTaskIds())))
      .all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToCheckpoint).sort(compareCheckpoints);
  }

  async saveCheckpoint(input: SaveCheckpointInput, opts?: OperationOptions): Promise<Checkpoint> {
    throwIfAborted(opts?.signal);
    const parsed = parseOrThrow(SaveCheckpointInputSchema, input, "saveCheckpoint");
    const taskRow = await this.#db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, parsed.taskId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!taskRow) throw new NotFoundError("task", parsed.taskId);

    const existingRow = await this.#db
      .select()
      .from(checkpoints)
      .where(and(eq(checkpoints.taskId, parsed.taskId), eq(checkpoints.stepIndex, parsed.stepIndex)))
      .get();
    throwIfAborted(opts?.signal);
    const checkpoint = buildCheckpoint(parsed, this.#deps, existingRow ? recordToCheckpoint(existingRow) : undefined, opts?.actor);
    const values = checkpointToRecord(checkpoint);
    // The (task, step) unique index makes a concurrent save of the same step update instead of duplicate.
    await this.#db.insert(checkpoints).values(values).onConflictDoUpdate({
      target: [checkpoints.taskId, checkpoints.stepIndex],
      set: { status: values.status, stateSnapshot: values.stateSnapshot, createdBy: values.createdBy },
    });
    throwIfAborted(opts?.signal);
    return checkpoint;
  }

  async getComment(id: string, opts?: OperationOptions): Promise<Comment | null> {
    throwIfAborted(opts?.signal);
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) return null;
    const row = await this.#db
      .select()
      .from(comments)
      .where(and(eq(comments.id, parsed.data), inArray(comments.taskId, this.#orgTaskIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return cloneComment(recordToComment(row));
  }

  async addComment(input: CreateCommentInput, opts?: OperationOptions): Promise<Comment> {
    throwIfAborted(opts?.signal);
    const comment = buildComment(
      {
        ...input,
        ...(opts?.userId !== undefined && input.authorId === undefined ? { authorId: opts.userId } : {}),
        ...(opts?.userAvatarUrl !== undefined && input.authorAvatarUrl === undefined ? { authorAvatarUrl: opts.userAvatarUrl } : {}),
      },
      this.#deps,
    );
    const taskRow = await this.#db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, comment.taskId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!taskRow) throw new NotFoundError("task", comment.taskId);
    const touched = touchTaskEntity(recordToTask(taskRow), this.#deps.clock(), opts?.actor, {
      userId: opts?.userId,
      userAvatarUrl: opts?.userAvatarUrl,
    });

    await this.#db.insert(comments).values(commentToRecord(comment));
    await this.#db
      .update(tasks)
      .set({
        updatedBy: touched.updatedBy ?? null,
        activity: touched.activity ? touched.activity.map((entry) => ({ ...entry })) : null,
        updatedAt: Date.parse(touched.updatedAt),
      })
      .where(eq(tasks.id, comment.taskId));
    throwIfAborted(opts?.signal);
    return cloneComment(comment);
  }

  async deleteComment(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteComment");
    const deleted = await this.#db
      .delete(comments)
      .where(and(eq(comments.id, validId), inArray(comments.taskId, this.#orgTaskIds())))
      .returning({ id: comments.id });
    throwIfAborted(opts?.signal);
    if (deleted.length === 0) throw new NotFoundError("comment", validId);
  }

  async getAttachments(taskId: string, opts?: OperationOptions): Promise<Attachment[]> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getAttachments");
    const rows = await this.#db
      .select()
      .from(attachments)
      .where(and(eq(attachments.taskId, validTaskId), inArray(attachments.taskId, this.#orgTaskIds())))
      .all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToAttachment).sort(compareAttachments).map(cloneAttachment);
  }

  async getAttachment(id: string, opts?: OperationOptions): Promise<AttachmentContent | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getAttachment");
    const row = await this.#db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, validId), inArray(attachments.taskId, this.#orgTaskIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    const attachment = recordToAttachment(row);
    const blob = await this.#bucket.get(attachmentBlobKey(attachment.taskId, attachment.id));
    throwIfAborted(opts?.signal);
    const data = blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
    throwIfAborted(opts?.signal);
    return {
      ...cloneAttachment(attachment),
      data,
    };
  }

  async addAttachment(input: CreateAttachmentInput, opts?: OperationOptions): Promise<Attachment> {
    throwIfAborted(opts?.signal);
    const content = buildAttachment(input, this.#deps, opts?.actor);
    const taskRow = await this.#db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, content.taskId), inArray(tasks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!taskRow) throw new NotFoundError("task", content.taskId);

    const existingRows = await this.#db
      .select()
      .from(attachments)
      .where(eq(attachments.taskId, content.taskId))
      .all();
    throwIfAborted(opts?.signal);
    const existingAttachments = existingRows.map(recordToAttachment);
    assertTaskAttachmentQuota(existingAttachments, content.size);

    const meta = stripAttachmentData(content);
    const key = attachmentBlobKey(meta.taskId, meta.id);
    await this.#bucket.put(key, content.data, {
      httpMetadata: { contentType: meta.mimeType },
    });
    await this.#db.insert(attachments).values(attachmentToRecord(meta));

    const touched = touchTaskEntity(recordToTask(taskRow), this.#deps.clock(), opts?.actor, {
      userId: opts?.userId,
      userAvatarUrl: opts?.userAvatarUrl,
    });
    await this.#db
      .update(tasks)
      .set({
        updatedBy: touched.updatedBy ?? null,
        activity: touched.activity ? touched.activity.map((entry) => ({ ...entry })) : null,
        updatedAt: Date.parse(touched.updatedAt),
      })
      .where(eq(tasks.id, meta.taskId));
    throwIfAborted(opts?.signal);
    return cloneAttachment(meta);
  }

  async deleteAttachment(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteAttachment");
    const deleted = await this.#db
      .delete(attachments)
      .where(and(eq(attachments.id, validId), inArray(attachments.taskId, this.#orgTaskIds())))
      .returning({ id: attachments.id, taskId: attachments.taskId });
    throwIfAborted(opts?.signal);
    const removed = deleted[0];
    if (!removed) throw new NotFoundError("attachment", validId);
    await this.#bucket.delete(attachmentBlobKey(removed.taskId, removed.id));
    throwIfAborted(opts?.signal);
  }

  async getWebhooks(filter?: WebhookFilter, opts?: OperationOptions): Promise<Webhook[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(WebhookFilterSchema, filter, "getWebhooks");

    let rows: WebhookRecord[];
    if (parsedFilter?.projectId !== undefined) {
      rows = await this.#db
        .select()
        .from(webhooks)
        .where(and(eq(webhooks.projectId, parsedFilter.projectId), inArray(webhooks.projectId, this.#orgProjectIds())))
        .all();
    } else {
      rows = await this.#db
        .select()
        .from(webhooks)
        .where(inArray(webhooks.projectId, this.#orgProjectIds()))
        .all();
    }
    throwIfAborted(opts?.signal);
    return rows.map(recordToWebhook).sort(compareWebhooks).map(cloneWebhook);
  }

  async getWebhook(id: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getWebhook");
    const row = await this.#db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, validId), inArray(webhooks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return cloneWebhook(recordToWebhook(row));
  }

  async getWebhookByToken(token: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validToken = parseOrThrow(WebhookTokenSchema, token, "getWebhookByToken");
    const row = await this.#db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.token, validToken), inArray(webhooks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return cloneWebhook(recordToWebhook(row));
  }

  async findWebhookOrgId(token: string, opts?: OperationOptions): Promise<string | null> {
    throwIfAborted(opts?.signal);
    const validToken = parseOrThrow(WebhookTokenSchema, token, "findWebhookOrgId");
    const row = await this.#db
      .select({ orgId: projects.orgId })
      .from(webhooks)
      .innerJoin(projects, eq(webhooks.projectId, projects.id))
      .where(eq(webhooks.token, validToken))
      .get();
    throwIfAborted(opts?.signal);
    return row?.orgId ?? null;
  }

  async createWebhook(input: CreateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const webhook = buildWebhook(input, this.#deps);
    const projectRow = await this.#db
      .select()
      .from(projects)
      .where(and(eq(projects.id, webhook.projectId), eq(projects.orgId, this.#orgId)))
      .get();
    throwIfAborted(opts?.signal);
    if (!projectRow) throw new NotFoundError("project", webhook.projectId);

    await this.#db.insert(webhooks).values(webhookToRecord(webhook));
    throwIfAborted(opts?.signal);
    return cloneWebhook(webhook);
  }

  async updateWebhook(id: string, patch: UpdateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateWebhook");
    const existingRow = await this.#db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, validId), inArray(webhooks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("webhook", validId);

    const existing = recordToWebhook(existingRow);
    const next = applyWebhookPatch(existing, patch, this.#deps);
    if (next.projectId !== existing.projectId) {
      const targetProject = await this.#db
        .select()
        .from(projects)
        .where(and(eq(projects.id, next.projectId), eq(projects.orgId, this.#orgId)))
        .get();
      throwIfAborted(opts?.signal);
      if (!targetProject) throw new NotFoundError("project", next.projectId);
    }

    await this.#db.update(webhooks).set(webhookToRecord(next)).where(eq(webhooks.id, validId));
    throwIfAborted(opts?.signal);
    return cloneWebhook(next);
  }

  async deleteWebhook(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteWebhook");
    const deleted = await this.#db
      .delete(webhooks)
      .where(and(eq(webhooks.id, validId), inArray(webhooks.projectId, this.#orgProjectIds())))
      .returning({ id: webhooks.id });
    throwIfAborted(opts?.signal);
    if (deleted.length === 0) throw new NotFoundError("webhook", validId);
  }

  async recordWebhookTrigger(id: string, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "recordWebhookTrigger");
    const existingRow = await this.#db
      .select()
      .from(webhooks)
      .where(and(eq(webhooks.id, validId), inArray(webhooks.projectId, this.#orgProjectIds())))
      .get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("webhook", validId);

    const existing = recordToWebhook(existingRow);
    const next = recordWebhookTriggerEntity(existing, this.#deps.clock());
    await this.#db.update(webhooks).set(webhookToRecord(next)).where(eq(webhooks.id, validId));
    throwIfAborted(opts?.signal);
    return cloneWebhook(next);
  }

  async exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "exportProject");
    const project = await this.getProject(validId, opts);
    if (project === null) throw new NotFoundError("project", validId);

    const projectTasks = await this.getTasks({ projectId: validId }, opts);
    const projectWebhooks = await this.getWebhooks({ projectId: validId }, opts);
    const commentRows = await this.#db
      .select()
      .from(comments)
      .where(inArray(comments.taskId, this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, validId))))
      .all();
    const checkpointRows = await this.#db
      .select()
      .from(checkpoints)
      .where(inArray(checkpoints.taskId, this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, validId))))
      .all();
    throwIfAborted(opts?.signal);
    const projectCheckpoints = checkpointRows.map(recordToCheckpoint).sort(compareCheckpoints);
    const bundle: ProjectBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.#deps.clock()),
      project,
      tasks: projectTasks,
      comments: commentRows.map(recordToComment).sort(compareComments),
      ...(projectCheckpoints.length > 0 ? { checkpoints: projectCheckpoints } : {}),
      ...(projectWebhooks.length > 0 ? { webhooks: projectWebhooks } : {}),
    };
    return parseOrThrow(ProjectBundleSchema, bundle, "exportProject result");
  }

  async importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(ProjectBundleSchema, bundle, "importProject");

    const existingProject = await this.#db.select().from(projects).where(eq(projects.id, validated.project.id)).get();
    throwIfAborted(opts?.signal);
    if (existingProject && existingProject.orgId !== this.#orgId) {
      throw new ValidationError("importProject", [
        { code: "custom", path: ["project", "id"], message: "Project belongs to another organisation", input: validated.project.id },
      ]);
    }

    const projectValues = {
      id: validated.project.id,
      orgId: this.#orgId,
      name: validated.project.name,
      description: validated.project.description,
      kind: validated.project.kind,
      resources: validated.project.resources ?? null,
      key: validated.project.key ?? null,
      archived: validated.project.archived ?? null,
      createdAt: Date.parse(validated.project.createdAt),
      updatedAt: Date.parse(validated.project.updatedAt),
    };

    if (existingProject) {
      await this.#db.update(projects).set(projectValues).where(eq(projects.id, validated.project.id));
    } else {
      await this.#db.insert(projects).values(projectValues);
    }
    throwIfAborted(opts?.signal);

    for (const task of validated.tasks) {
      throwIfAborted(opts?.signal);
      const existingTask = await this.#db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      throwIfAborted(opts?.signal);
      const taskValues = {
        id: task.id,
        projectId: task.projectId,
        parentId: task.parentId ?? null,
        title: task.title,
        description: task.description,
        status: task.status,
        isPublic: task.isPublic,
        dueDate: task.dueDate ?? null,
        priority: task.priority ?? null,
        labels: task.labels ? [...task.labels] : null,
        order: task.order ?? null,
        checklist: task.checklist ?? null,
        needsHuman: task.needsHuman ?? null,
        pendingApproval: task.pendingApproval ?? null,
        dependsOn: task.dependsOn ? [...task.dependsOn] : null,
        number: task.number ?? null,
        startedAt: task.startedAt !== undefined ? Date.parse(task.startedAt) : null,
        completedAt: task.completedAt !== undefined ? Date.parse(task.completedAt) : null,
        createdBy: task.createdBy ?? null,
        startedBy: task.startedBy ?? null,
        completedBy: task.completedBy ?? null,
        updatedBy: task.updatedBy ?? null,
        activity: task.activity ? task.activity.map((entry) => ({ ...entry })) : null,
        createdAt: Date.parse(task.createdAt),
        updatedAt: Date.parse(task.updatedAt),
      };

      if (existingTask) {
        await this.#db.update(tasks).set(taskValues).where(eq(tasks.id, task.id));
      } else {
        await this.#db.insert(tasks).values(taskValues);
      }
    }

    for (const comment of validated.comments ?? []) {
      throwIfAborted(opts?.signal);
      const values = commentToRecord(comment);
      await this.#db.insert(comments).values(values).onConflictDoUpdate({ target: comments.id, set: values });
    }

    for (const checkpoint of validated.checkpoints ?? []) {
      throwIfAborted(opts?.signal);
      const values = checkpointToRecord(checkpoint);
      await this.#db.insert(checkpoints).values(values).onConflictDoUpdate({ target: checkpoints.id, set: values });
    }

    for (const webhook of validated.webhooks ?? []) {
      throwIfAborted(opts?.signal);
      const values = webhookToRecord(webhook);
      await this.#db.insert(webhooks).values(values).onConflictDoUpdate({ target: webhooks.id, set: values });
    }

    return copyProject(validated.project);
  }

  async exportAll(opts?: OperationOptions): Promise<BackupBundle> {
    throwIfAborted(opts?.signal);
    const allProjects = await this.getProjects(opts);
    const bundles: ProjectBundle[] = [];
    for (const p of allProjects) {
      throwIfAborted(opts?.signal);
      bundles.push(await this.exportProject(p.id, opts));
    }
    const backup: BackupBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.#deps.clock()),
      bundles,
    };
    return parseOrThrow(BackupBundleSchema, backup, "exportAll result");
  }

  async importBackup(backup: BackupBundle, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(BackupBundleSchema, backup, "importBackup");
    for (const bundle of validated.bundles) {
      throwIfAborted(opts?.signal);
      await this.importProject(bundle, opts);
    }
  }

  /** Keys of every project in this organisation except `exceptId`. */
  async #projectKeys(exceptId?: string): Promise<string[]> {
    const condition =
      exceptId === undefined
        ? eq(projects.orgId, this.#orgId)
        : and(eq(projects.orgId, this.#orgId), ne(projects.id, exceptId));
    const rows = await this.#db
      .select({ key: projects.key })
      .from(projects)
      .where(condition)
      .all();
    return rows.flatMap((row) => (row.key === null ? [] : [row.key]));
  }

  /** Every task's ID, projectId, and parentId in this organisation, for containment validation. */
  async #containmentGraph(): Promise<ContainmentNode[]> {
    const rows = await this.#db
      .select({ id: tasks.id, projectId: tasks.projectId, parentId: tasks.parentId })
      .from(tasks)
      .where(inArray(tasks.projectId, this.#orgProjectIds()))
      .all();
    return rows.map((row) =>
      row.parentId === null
        ? { id: row.id, projectId: row.projectId }
        : { id: row.id, projectId: row.projectId, parentId: row.parentId },
    );
  }

  /** Every task's ID and dependencies in this organisation, for `assertTaskDependencies`. */
  async #dependencyGraph(): Promise<DependencyNode[]> {
    const rows = await this.#db
      .select({ id: tasks.id, dependsOn: tasks.dependsOn })
      .from(tasks)
      .where(inArray(tasks.projectId, this.#orgProjectIds()))
      .all();
    return rows.map((row) => (row.dependsOn === null ? { id: row.id } : { id: row.id, dependsOn: row.dependsOn }));
  }

  /** Removes `removedIds` from every remaining task's `dependsOn` in this organisation, leaving `updated_at` as it is. */
  async #dropDependencies(removedIds: ReadonlySet<string>): Promise<void> {
    const rows = await this.#db
      .select({ id: tasks.id, dependsOn: tasks.dependsOn })
      .from(tasks)
      .where(and(isNotNull(tasks.dependsOn), inArray(tasks.projectId, this.#orgProjectIds())))
      .all();
    for (const row of rows) {
      const dependsOn = row.dependsOn ?? [];
      if (!dependsOn.some((id) => removedIds.has(id))) continue;
      const kept = dependsOn.filter((id) => !removedIds.has(id));
      await this.#db
        .update(tasks)
        .set({ dependsOn: kept.length > 0 ? kept : null })
        .where(eq(tasks.id, row.id));
    }
  }

  async #nextTaskNumber(projectId: string): Promise<number> {
    const row = await this.#db
      .select({ highest: max(tasks.number) })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .get();
    return (row?.highest ?? 0) + 1;
  }

  async #commentCount(taskId: string): Promise<number> {
    const row = await this.#db
      .select({ total: count() })
      .from(comments)
      .where(eq(comments.taskId, taskId))
      .get();
    return row?.total ?? 0;
  }

  async #attachmentCount(taskId: string): Promise<number> {
    const row = await this.#db
      .select({ total: count() })
      .from(attachments)
      .where(eq(attachments.taskId, taskId))
      .get();
    return row?.total ?? 0;
  }
}
