import { count, eq, inArray, isNotNull, max, ne } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  IdSchema,
  NotFoundError,
  ProjectBundleSchema,
  TaskFilterSchema,
  WebhookFilterSchema,
  WebhookTokenSchema,
  applyProjectPatch,
  applyTaskPatch,
  applyWebhookPatch,
  assertTaskDependencies,
  buildComment,
  buildProject,
  buildTask,
  buildWebhook,
  cloneComment,
  cloneProject,
  cloneTask,
  cloneWebhook,
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
  throwIfAborted,
  toTimestamp,
  withTaskCommentCount,
  type BackupBundle,
  type Comment,
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
  comments,
  projects,
  tasks,
  webhooks,
  type CommentRecord,
  type InsertCommentRecord,
  type InsertWebhookRecord,
  type ProjectRecord,
  type TaskRecord,
  type WebhookRecord,
} from "./schema";

export interface D1StorageOptions {
  readonly db: D1Database | DrizzleD1Database<typeof schema>;
  readonly deps?: RuntimeDeps;
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
  return comment;
}

function commentToRecord(comment: Comment): InsertCommentRecord {
  return {
    id: comment.id,
    taskId: comment.taskId,
    body: comment.body,
    authorType: comment.authorType,
    author: comment.author ?? null,
    createdAt: Date.parse(comment.createdAt),
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
    webhook.mapping = { ...row.mapping };
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
  return {
    id: webhook.id,
    projectId: webhook.projectId,
    name: webhook.name,
    provider: webhook.provider,
    token: webhook.token,
    enabled: webhook.enabled,
    mapping: webhook.mapping ? { ...webhook.mapping } : null,
    defaultPriority: webhook.defaultPriority ?? null,
    defaultLabels: webhook.defaultLabels ? [...webhook.defaultLabels] : null,
    triggerCount: webhook.triggerCount,
    lastTriggeredAt: webhook.lastTriggeredAt !== undefined ? Date.parse(webhook.lastTriggeredAt) : null,
    createdAt: Date.parse(webhook.createdAt),
    updatedAt: Date.parse(webhook.updatedAt),
  };
}

function isD1Database(db: unknown): db is D1Database {
  return typeof db === "object" && db !== null && "prepare" in db && typeof db.prepare === "function";
}

export class D1Storage implements StorageProvider {
  readonly #db: DrizzleD1Database<typeof schema>;
  readonly #deps: RuntimeDeps;

  constructor(
    dbOrOptions: D1Database | DrizzleD1Database<typeof schema> | D1StorageOptions,
    maybeDeps?: RuntimeDeps,
  ) {
    if ("db" in dbOrOptions) {
      this.#db = isD1Database(dbOrOptions.db) ? drizzle(dbOrOptions.db, { schema }) : dbOrOptions.db;
      this.#deps = dbOrOptions.deps ?? defaultRuntimeDeps;
    } else {
      this.#db = isD1Database(dbOrOptions) ? drizzle(dbOrOptions, { schema }) : dbOrOptions;
      this.#deps = maybeDeps ?? defaultRuntimeDeps;
    }
  }

  async getProjects(opts?: OperationOptions): Promise<Project[]> {
    throwIfAborted(opts?.signal);
    const rows = await this.#db.select().from(projects).all();
    throwIfAborted(opts?.signal);
    const result = rows.map(recordToProject);
    result.sort(compareProjects);
    return result.map(copyProject);
  }

  async getProject(id: string, opts?: OperationOptions): Promise<Project | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getProject");
    const row = await this.#db.select().from(projects).where(eq(projects.id, validId)).get();
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
    const existingRow = await this.#db.select().from(projects).where(eq(projects.id, validId)).get();
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
      .where(eq(projects.id, validId));
    throwIfAborted(opts?.signal);
    return copyProject(next);
  }

  async deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteProject");
    const existingRow = await this.#db.select().from(projects).where(eq(projects.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("project", validId);

    // Explicitly delete cascade to guarantee consistency across all SQLite configurations
    const projectTaskIds = this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, validId));
    const removed = new Set((await projectTaskIds.all()).map((row) => row.id));
    await this.#db.delete(comments).where(inArray(comments.taskId, projectTaskIds));
    await this.#db.delete(tasks).where(eq(tasks.projectId, validId));
    if (removed.size > 0) await this.#dropDependencies(removed);
    await this.#db.delete(webhooks).where(eq(webhooks.projectId, validId));
    await this.#db.delete(projects).where(eq(projects.id, validId));
    throwIfAborted(opts?.signal);
  }

  async getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(TaskFilterSchema, filter, "getTasks");

    let rows: TaskRecord[];
    let commentCountRows: { taskId: string; total: number }[];
    if (parsedFilter?.projectId !== undefined) {
      rows = await this.#db.select().from(tasks).where(eq(tasks.projectId, parsedFilter.projectId)).all();
      throwIfAborted(opts?.signal);
      commentCountRows =
        rows.length === 0
          ? []
          : await this.#db
              .select({ taskId: comments.taskId, total: count() })
              .from(comments)
              .where(
                inArray(
                  comments.taskId,
                  this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.projectId, parsedFilter.projectId)),
                ),
              )
              .groupBy(comments.taskId)
              .all();
    } else {
      rows = await this.#db.select().from(tasks).all();
      throwIfAborted(opts?.signal);
      commentCountRows =
        rows.length === 0
          ? []
          : await this.#db
              .select({ taskId: comments.taskId, total: count() })
              .from(comments)
              .groupBy(comments.taskId)
              .all();
    }
    throwIfAborted(opts?.signal);
    const countsByTaskId = new Map<string, number>();
    for (const entry of commentCountRows) {
      countsByTaskId.set(entry.taskId, entry.total);
    }
    const result = rows.map((row) => withTaskCommentCount(recordToTask(row), countsByTaskId.get(row.id) ?? 0));
    result.sort(compareTasks);
    return result;
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getTask");
    const row = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    const total = await this.#commentCount(validId);
    throwIfAborted(opts?.signal);
    return withTaskCommentCount(recordToTask(row), total);
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const projectId = parseOrThrow(IdSchema, input.projectId, "saveTask");
    const task = buildTask(input, this.#deps, await this.#nextTaskNumber(projectId), opts?.actor);

    const projectRow = await this.#db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    throwIfAborted(opts?.signal);
    if (!projectRow) throw new NotFoundError("project", task.projectId);
    if (hasNewDependencies(undefined, task)) {
      assertTaskDependencies(task, await this.#dependencyGraph(), "saveTask");
      throwIfAborted(opts?.signal);
    }

    await this.#db.insert(tasks).values({
      id: task.id,
      projectId: task.projectId,
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
    throwIfAborted(opts?.signal);
    return copyTask(task);
  }

  async updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateTask");
    const existingRow = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    const existing = recordToTask(existingRow);
    let next = applyTaskPatch(existing, patch, this.#deps.clock(), opts?.actor, opts?.overrideBlockedBy);

    if (next.projectId !== existing.projectId) {
      const targetProject = await this.#db.select().from(projects).where(eq(projects.id, next.projectId)).get();
      throwIfAborted(opts?.signal);
      if (!targetProject) throw new NotFoundError("project", next.projectId);
      next = renumberTask(next, await this.#nextTaskNumber(next.projectId));
      throwIfAborted(opts?.signal);
    }
    if (hasNewDependencies(existing, next)) {
      assertTaskDependencies(next, await this.#dependencyGraph(), "updateTask");
      throwIfAborted(opts?.signal);
    }

    await this.#db
      .update(tasks)
      .set({
        projectId: next.projectId,
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
      .where(eq(tasks.id, validId));
    throwIfAborted(opts?.signal);
    const total = await this.#commentCount(validId);
    throwIfAborted(opts?.signal);
    return withTaskCommentCount(next, total);
  }

  async deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteTask");
    const existingRow = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    await this.#db.delete(comments).where(eq(comments.taskId, validId));
    await this.#db.delete(tasks).where(eq(tasks.id, validId));
    await this.#dropDependencies(new Set([validId]));
    throwIfAborted(opts?.signal);
  }

  async completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "completeTask");
    const existingRow = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    const existing = recordToTask(existingRow);
    const next = completeTaskEntity(existing, this.#deps.clock(), opts?.actor, opts?.overrideBlockedBy);

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
    throwIfAborted(opts?.signal);
    return withTaskCommentCount(next, total);
  }

  async getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getComments");
    const rows = await this.#db.select().from(comments).where(eq(comments.taskId, validTaskId)).all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToComment).sort(compareComments).map(cloneComment);
  }

  async getComment(id: string, opts?: OperationOptions): Promise<Comment | null> {
    throwIfAborted(opts?.signal);
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) return null;
    const row = await this.#db.select().from(comments).where(eq(comments.id, parsed.data)).get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return cloneComment(recordToComment(row));
  }

  async addComment(input: CreateCommentInput, opts?: OperationOptions): Promise<Comment> {
    throwIfAborted(opts?.signal);
    const comment = buildComment(input, this.#deps);
    const taskRow = await this.#db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, comment.taskId)).get();
    throwIfAborted(opts?.signal);
    if (!taskRow) throw new NotFoundError("task", comment.taskId);

    await this.#db.insert(comments).values(commentToRecord(comment));
    throwIfAborted(opts?.signal);
    return cloneComment(comment);
  }

  async deleteComment(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteComment");
    const deleted = await this.#db.delete(comments).where(eq(comments.id, validId)).returning({ id: comments.id });
    throwIfAborted(opts?.signal);
    if (deleted.length === 0) throw new NotFoundError("comment", validId);
  }

  async getWebhooks(filter?: WebhookFilter, opts?: OperationOptions): Promise<Webhook[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(WebhookFilterSchema, filter, "getWebhooks");

    let rows: WebhookRecord[];
    if (parsedFilter?.projectId !== undefined) {
      rows = await this.#db.select().from(webhooks).where(eq(webhooks.projectId, parsedFilter.projectId)).all();
    } else {
      rows = await this.#db.select().from(webhooks).all();
    }
    throwIfAborted(opts?.signal);
    return rows.map(recordToWebhook).sort(compareWebhooks).map(cloneWebhook);
  }

  async getWebhook(id: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getWebhook");
    const row = await this.#db.select().from(webhooks).where(eq(webhooks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return cloneWebhook(recordToWebhook(row));
  }

  async getWebhookByToken(token: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validToken = parseOrThrow(WebhookTokenSchema, token, "getWebhookByToken");
    const row = await this.#db.select().from(webhooks).where(eq(webhooks.token, validToken)).get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return cloneWebhook(recordToWebhook(row));
  }

  async createWebhook(input: CreateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const webhook = buildWebhook(input, this.#deps);
    const projectRow = await this.#db.select().from(projects).where(eq(projects.id, webhook.projectId)).get();
    throwIfAborted(opts?.signal);
    if (!projectRow) throw new NotFoundError("project", webhook.projectId);

    await this.#db.insert(webhooks).values(webhookToRecord(webhook));
    throwIfAborted(opts?.signal);
    return cloneWebhook(webhook);
  }

  async updateWebhook(id: string, patch: UpdateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateWebhook");
    const existingRow = await this.#db.select().from(webhooks).where(eq(webhooks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("webhook", validId);

    const existing = recordToWebhook(existingRow);
    const next = applyWebhookPatch(existing, patch, this.#deps);
    if (next.projectId !== existing.projectId) {
      const targetProject = await this.#db.select().from(projects).where(eq(projects.id, next.projectId)).get();
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
    const deleted = await this.#db.delete(webhooks).where(eq(webhooks.id, validId)).returning({ id: webhooks.id });
    throwIfAborted(opts?.signal);
    if (deleted.length === 0) throw new NotFoundError("webhook", validId);
  }

  async recordWebhookTrigger(id: string, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "recordWebhookTrigger");
    const existingRow = await this.#db.select().from(webhooks).where(eq(webhooks.id, validId)).get();
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
    throwIfAborted(opts?.signal);
    const bundle: ProjectBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.#deps.clock()),
      project,
      tasks: projectTasks,
      comments: commentRows.map(recordToComment).sort(compareComments),
      ...(projectWebhooks.length > 0 ? { webhooks: projectWebhooks } : {}),
    };
    return parseOrThrow(ProjectBundleSchema, bundle, "exportProject result");
  }

  async importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(ProjectBundleSchema, bundle, "importProject");

    const existingProject = await this.#db.select().from(projects).where(eq(projects.id, validated.project.id)).get();
    throwIfAborted(opts?.signal);

    const projectValues = {
      id: validated.project.id,
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

  /** Keys of every project except `exceptId`. */
  async #projectKeys(exceptId?: string): Promise<string[]> {
    const rows = await this.#db
      .select({ key: projects.key })
      .from(projects)
      .where(exceptId === undefined ? undefined : ne(projects.id, exceptId))
      .all();
    return rows.flatMap((row) => (row.key === null ? [] : [row.key]));
  }

  /** Every task's ID and dependencies, for `assertTaskDependencies`. */
  async #dependencyGraph(): Promise<DependencyNode[]> {
    const rows = await this.#db.select({ id: tasks.id, dependsOn: tasks.dependsOn }).from(tasks).all();
    return rows.map((row) => (row.dependsOn === null ? { id: row.id } : { id: row.id, dependsOn: row.dependsOn }));
  }

  /** Removes `removedIds` from every remaining task's `dependsOn`, leaving `updated_at` as it is. */
  async #dropDependencies(removedIds: ReadonlySet<string>): Promise<void> {
    const rows = await this.#db
      .select({ id: tasks.id, dependsOn: tasks.dependsOn })
      .from(tasks)
      .where(isNotNull(tasks.dependsOn))
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
}
