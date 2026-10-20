import { eq, inArray, max, ne } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  IdSchema,
  NotFoundError,
  ProjectBundleSchema,
  TaskFilterSchema,
  applyProjectPatch,
  applyTaskPatch,
  buildComment,
  buildProject,
  buildTask,
  cloneComment,
  cloneProject,
  cloneTask,
  compareComments,
  compareProjects,
  compareTasks,
  completeTaskEntity,
  defaultRuntimeDeps,
  parseOrThrow,
  renumberTask,
  throwIfAborted,
  toTimestamp,
  type BackupBundle,
  type Comment,
  type CreateCommentInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type OperationOptions,
  type Project,
  type ProjectBundle,
  type RuntimeDeps,
  type StorageProvider,
  type Task,
  type TaskFilter,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@bitig/core";
import * as schema from "./schema";
import {
  comments,
  projects,
  tasks,
  type CommentRecord,
  type InsertCommentRecord,
  type ProjectRecord,
  type TaskRecord,
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
  if (row.number !== null) {
    task.number = row.number;
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
    await this.#db.delete(comments).where(inArray(comments.taskId, projectTaskIds));
    await this.#db.delete(tasks).where(eq(tasks.projectId, validId));
    await this.#db.delete(projects).where(eq(projects.id, validId));
    throwIfAborted(opts?.signal);
  }

  async getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(TaskFilterSchema, filter, "getTasks");

    let rows: TaskRecord[];
    if (parsedFilter?.projectId !== undefined) {
      rows = await this.#db.select().from(tasks).where(eq(tasks.projectId, parsedFilter.projectId)).all();
    } else {
      rows = await this.#db.select().from(tasks).all();
    }
    throwIfAborted(opts?.signal);
    const result = rows.map(recordToTask);
    result.sort(compareTasks);
    return result.map(copyTask);
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getTask");
    const row = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!row) return null;
    return copyTask(recordToTask(row));
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const projectId = parseOrThrow(IdSchema, input.projectId, "saveTask");
    const task = buildTask(input, this.#deps, await this.#nextTaskNumber(projectId));

    const projectRow = await this.#db.select().from(projects).where(eq(projects.id, task.projectId)).get();
    throwIfAborted(opts?.signal);
    if (!projectRow) throw new NotFoundError("project", task.projectId);

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
      number: task.number ?? null,
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
    let next = applyTaskPatch(existing, patch, this.#deps.clock());

    if (next.projectId !== existing.projectId) {
      const targetProject = await this.#db.select().from(projects).where(eq(projects.id, next.projectId)).get();
      throwIfAborted(opts?.signal);
      if (!targetProject) throw new NotFoundError("project", next.projectId);
      next = renumberTask(next, await this.#nextTaskNumber(next.projectId));
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
        number: next.number ?? null,
        updatedAt: Date.parse(next.updatedAt),
      })
      .where(eq(tasks.id, validId));
    throwIfAborted(opts?.signal);
    return copyTask(next);
  }

  async deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteTask");
    const existingRow = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    await this.#db.delete(comments).where(eq(comments.taskId, validId));
    await this.#db.delete(tasks).where(eq(tasks.id, validId));
    throwIfAborted(opts?.signal);
  }

  async completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "completeTask");
    const existingRow = await this.#db.select().from(tasks).where(eq(tasks.id, validId)).get();
    throwIfAborted(opts?.signal);
    if (!existingRow) throw new NotFoundError("task", validId);

    const existing = recordToTask(existingRow);
    const next = completeTaskEntity(existing, this.#deps.clock());

    if (next.status !== existing.status || next.updatedAt !== existing.updatedAt) {
      await this.#db
        .update(tasks)
        .set({
          status: next.status,
          updatedAt: Date.parse(next.updatedAt),
        })
        .where(eq(tasks.id, validId));
    }
    throwIfAborted(opts?.signal);
    return copyTask(next);
  }

  async getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getComments");
    const rows = await this.#db.select().from(comments).where(eq(comments.taskId, validTaskId)).all();
    throwIfAborted(opts?.signal);
    return rows.map(recordToComment).sort(compareComments).map(cloneComment);
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

  async exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "exportProject");
    const project = await this.getProject(validId, opts);
    if (project === null) throw new NotFoundError("project", validId);

    const projectTasks = await this.getTasks({ projectId: validId }, opts);
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
        number: task.number ?? null,
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

  async #nextTaskNumber(projectId: string): Promise<number> {
    const row = await this.#db
      .select({ highest: max(tasks.number) })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .get();
    return (row?.highest ?? 0) + 1;
  }
}
