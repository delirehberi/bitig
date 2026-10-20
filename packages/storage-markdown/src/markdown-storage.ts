/**
 * MarkdownStorage — StorageProvider implementation storing projects as directories
 * and tasks as Markdown files with YAML frontmatter.
 */
import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  IdSchema,
  NotFoundError,
  ProjectBundleSchema,
  StorageError,
  TaskFilterSchema,
  WebhookFilterSchema,
  WebhookTokenSchema,
  applyProjectPatch,
  applyTaskPatch,
  applyWebhookPatch,
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
  nextTaskNumber,
  parseOrThrow,
  recordWebhookTriggerEntity,
  renumberTask,
  throwIfAborted,
  toTimestamp,
  type BackupBundle,
  type Comment,
  type CreateCommentInput,
  type CreateProjectInput,
  type CreateTaskInput,
  type CreateWebhookInput,
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
import {
  decodeComment,
  decodeProject,
  decodeTask,
  decodeWebhook,
  encodeComment,
  encodeProject,
  encodeTask,
  encodeWebhook,
} from "./format/codec";
import type { FileSystemPort } from "./fs/port";
import {
  ROOT_PATH,
  commentFilePath,
  commentIdFromFileName,
  commentsDirPath,
  isEntityId,
  projectDirPath,
  projectFilePath,
  taskFilePath,
  taskIdFromCommentsDirName,
  taskIdFromFileName,
  webhookFilePath,
  webhookIdFromFileName,
  webhooksDirPath,
} from "./layout";
import { AsyncMutex } from "./lock/mutex";
import type { LockPort } from "./lock/port";

export interface MarkdownStorageOptions {
  readonly fs: FileSystemPort;
  readonly lock?: LockPort;
  readonly deps?: RuntimeDeps;
}

function copyProject(project: Project): Project {
  return cloneProject(project);
}

function copyTask(task: Task): Task {
  return cloneTask(task);
}

function projectKeys(projects: readonly Project[]): string[] {
  return projects.flatMap((p) => (p.key === undefined ? [] : [p.key]));
}

export class MarkdownStorage implements StorageProvider {
  readonly #fs: FileSystemPort;
  readonly #lock: LockPort;
  readonly #deps: RuntimeDeps;

  constructor(opts: MarkdownStorageOptions) {
    this.#fs = opts.fs;
    this.#lock = opts.lock ?? new AsyncMutex();
    this.#deps = opts.deps ?? defaultRuntimeDeps;
  }

  async getProjects(opts?: OperationOptions): Promise<Project[]> {
    throwIfAborted(opts?.signal);
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const projects = await this.#readProjects(opts?.signal);
      projects.sort(compareProjects);
      return projects.map(copyProject);
    }, { signal: opts?.signal });
  }

  async getProject(id: string, opts?: OperationOptions): Promise<Project | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getProject");
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const filePath = projectFilePath(validId);
      const text = await this.#fs.readText(filePath, { signal: opts?.signal });
      if (text === null) return null;
      return copyProject(decodeProject(validId, text, filePath));
    }, { signal: opts?.signal });
  }

  async createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const projects = await this.#readProjects(opts?.signal);
      const project = buildProject(input, this.#deps, projectKeys(projects));
      const dir = projectDirPath(project.id);
      await this.#fs.makeDir(dir, { signal: opts?.signal });
      const filePath = projectFilePath(project.id);
      await this.#fs.writeTextAtomic(filePath, encodeProject(project), { signal: opts?.signal });
      return copyProject(project);
    }, { signal: opts?.signal });
  }

  async updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateProject");
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const filePath = projectFilePath(validId);
      const text = await this.#fs.readText(filePath, { signal: opts?.signal });
      if (text === null) throw new NotFoundError("project", validId);

      const existing = decodeProject(validId, text, filePath);
      const others = (await this.#readProjects(opts?.signal)).filter((p) => p.id !== validId);
      const next = applyProjectPatch(existing, patch, this.#deps.clock(), projectKeys(others));
      await this.#fs.writeTextAtomic(filePath, encodeProject(next), { signal: opts?.signal });
      return copyProject(next);
    }, { signal: opts?.signal });
  }

  async deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteProject");
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const filePath = projectFilePath(validId);
      const exists = await this.#fs.fileExists(filePath, { signal: opts?.signal });
      if (!exists) throw new NotFoundError("project", validId);

      await this.#fs.removeDir(projectDirPath(validId), { signal: opts?.signal });
    }, { signal: opts?.signal });
  }

  async getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(TaskFilterSchema, filter, "getTasks");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const tasks: Task[] = [];

      if (parsedFilter?.projectId !== undefined) {
        tasks.push(...(await this.#readProjectTasks(parsedFilter.projectId, opts?.signal)));
      } else {
        const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal: opts?.signal });
        if (rootEntries === null) return [];

        const seenTaskIds = new Map<string, string>(); // taskId -> projectPath

        for (const rootEntry of rootEntries) {
          throwIfAborted(opts?.signal);
          if (rootEntry.kind === "directory" && isEntityId(rootEntry.name)) {
            const pId = rootEntry.name;
            const entries = await this.#fs.listDir(projectDirPath(pId), { signal: opts?.signal });
            if (entries !== null) {
              for (const entry of entries) {
                throwIfAborted(opts?.signal);
                if (entry.kind === "file") {
                  const taskId = taskIdFromFileName(entry.name);
                  if (taskId !== null) {
                    const filePath = taskFilePath(pId, taskId);
                    const prevPath = seenTaskIds.get(taskId);
                    if (prevPath !== undefined) {
                      throw new StorageError("corrupt", `Duplicate task ID ${taskId} found in multiple locations`, {
                        location: `${prevPath} and ${filePath}`,
                      });
                    }
                    seenTaskIds.set(taskId, filePath);
                    const text = await this.#fs.readText(filePath, { signal: opts?.signal });
                    if (text !== null) {
                      tasks.push(decodeTask(pId, taskId, text, filePath));
                    }
                  }
                }
              }
            }
          }
        }
      }

      tasks.sort(compareTasks);
      return tasks.map(copyTask);
    }, { signal: opts?.signal });
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getTask");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateTask(validId, opts?.signal);
      if (found === null) return null;
      const text = await this.#fs.readText(found.filePath, { signal: opts?.signal });
      if (text === null) return null;
      return copyTask(decodeTask(found.projectId, validId, text, found.filePath));
    }, { signal: opts?.signal });
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const projectId = parseOrThrow(IdSchema, input.projectId, "saveTask");
      const siblings = await this.#readProjectTasks(projectId, opts?.signal);
      const task = buildTask(input, this.#deps, nextTaskNumber(siblings));
      const pFilePath = projectFilePath(task.projectId);
      const pExists = await this.#fs.fileExists(pFilePath, { signal: opts?.signal });
      if (!pExists) throw new NotFoundError("project", task.projectId);

      const filePath = taskFilePath(task.projectId, task.id);
      await this.#fs.writeTextAtomic(filePath, encodeTask(task), { signal: opts?.signal });
      return copyTask(task);
    }, { signal: opts?.signal });
  }

  async updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateTask");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateTask(validId, opts?.signal);
      if (found === null) throw new NotFoundError("task", validId);

      const text = await this.#fs.readText(found.filePath, { signal: opts?.signal });
      if (text === null) throw new NotFoundError("task", validId);

      const existing = decodeTask(found.projectId, validId, text, found.filePath);
      let next = applyTaskPatch(existing, patch, this.#deps.clock());

      if (next.projectId !== existing.projectId) {
        const targetProjFile = projectFilePath(next.projectId);
        const targetProjExists = await this.#fs.fileExists(targetProjFile, { signal: opts?.signal });
        if (!targetProjExists) throw new NotFoundError("project", next.projectId);
        const targetTasks = await this.#readProjectTasks(next.projectId, opts?.signal);
        next = renumberTask(next, nextTaskNumber(targetTasks));

        const nextFilePath = taskFilePath(next.projectId, next.id);
        await this.#fs.writeTextAtomic(nextFilePath, encodeTask(next), { signal: opts?.signal });
        // Copy the comments before removing anything, so a failure never loses one.
        const comments = await this.#readTaskComments(existing.projectId, validId, opts?.signal);
        await this.#writeComments(next.projectId, comments, opts?.signal);
        await this.#fs.removeFile(found.filePath, { signal: opts?.signal });
        await this.#fs.removeDir(commentsDirPath(existing.projectId, validId), { signal: opts?.signal });
      } else {
        await this.#fs.writeTextAtomic(found.filePath, encodeTask(next), { signal: opts?.signal });
      }

      return copyTask(next);
    }, { signal: opts?.signal });
  }

  async deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteTask");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateTask(validId, opts?.signal);
      if (found === null) throw new NotFoundError("task", validId);

      await this.#fs.removeFile(found.filePath, { signal: opts?.signal });
      await this.#fs.removeDir(commentsDirPath(found.projectId, validId), { signal: opts?.signal });
    }, { signal: opts?.signal });
  }

  async completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "completeTask");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateTask(validId, opts?.signal);
      if (found === null) throw new NotFoundError("task", validId);

      const text = await this.#fs.readText(found.filePath, { signal: opts?.signal });
      if (text === null) throw new NotFoundError("task", validId);

      const existing = decodeTask(found.projectId, validId, text, found.filePath);
      const next = completeTaskEntity(existing, this.#deps.clock());
      await this.#fs.writeTextAtomic(found.filePath, encodeTask(next), { signal: opts?.signal });
      return copyTask(next);
    }, { signal: opts?.signal });
  }

  async getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]> {
    throwIfAborted(opts?.signal);
    const validTaskId = parseOrThrow(IdSchema, taskId, "getComments");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateTask(validTaskId, opts?.signal);
      if (found === null) return [];
      const comments = await this.#readTaskComments(found.projectId, validTaskId, opts?.signal);
      return comments.sort(compareComments).map(cloneComment);
    }, { signal: opts?.signal });
  }

  async addComment(input: CreateCommentInput, opts?: OperationOptions): Promise<Comment> {
    throwIfAborted(opts?.signal);
    const comment = buildComment(input, this.#deps);

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateTask(comment.taskId, opts?.signal);
      if (found === null) throw new NotFoundError("task", comment.taskId);
      await this.#writeComments(found.projectId, [comment], opts?.signal);
      return cloneComment(comment);
    }, { signal: opts?.signal });
  }

  async deleteComment(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteComment");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const filePath = await this.#locateComment(validId, opts?.signal);
      if (filePath === null) throw new NotFoundError("comment", validId);
      await this.#fs.removeFile(filePath, { signal: opts?.signal });
    }, { signal: opts?.signal });
  }

  async getWebhooks(filter?: WebhookFilter, opts?: OperationOptions): Promise<Webhook[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter === undefined ? undefined : parseOrThrow(WebhookFilterSchema, filter, "getWebhooks");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const webhooks: Webhook[] = [];

      if (parsedFilter?.projectId !== undefined) {
        webhooks.push(...(await this.#readProjectWebhooks(parsedFilter.projectId, opts?.signal)));
      } else {
        const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal: opts?.signal });
        if (rootEntries === null) return [];
        for (const rootEntry of rootEntries) {
          throwIfAborted(opts?.signal);
          if (rootEntry.kind === "directory" && isEntityId(rootEntry.name)) {
            webhooks.push(...(await this.#readProjectWebhooks(rootEntry.name, opts?.signal)));
          }
        }
      }

      webhooks.sort(compareWebhooks);
      return webhooks.map(cloneWebhook);
    }, { signal: opts?.signal });
  }

  async getWebhook(id: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getWebhook");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateWebhook(validId, opts?.signal);
      if (found === null) return null;
      const text = await this.#fs.readText(found.filePath, { signal: opts?.signal });
      if (text === null) return null;
      return cloneWebhook(decodeWebhook(found.projectId, validId, text, found.filePath));
    }, { signal: opts?.signal });
  }

  async getWebhookByToken(token: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validToken = parseOrThrow(WebhookTokenSchema, token, "getWebhookByToken");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal: opts?.signal });
      if (rootEntries === null) return null;

      for (const rootEntry of rootEntries) {
        throwIfAborted(opts?.signal);
        if (rootEntry.kind === "directory" && isEntityId(rootEntry.name)) {
          const hooks = await this.#readProjectWebhooks(rootEntry.name, opts?.signal);
          const matched = hooks.find((w) => w.token === validToken);
          if (matched !== undefined) return cloneWebhook(matched);
        }
      }
      return null;
    }, { signal: opts?.signal });
  }

  async createWebhook(input: CreateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const webhook = buildWebhook(input, this.#deps);
      const pExists = await this.#fs.fileExists(projectFilePath(webhook.projectId), { signal: opts?.signal });
      if (!pExists) throw new NotFoundError("project", webhook.projectId);

      await this.#writeWebhooks(webhook.projectId, [webhook], opts?.signal);
      return cloneWebhook(webhook);
    }, { signal: opts?.signal });
  }

  async updateWebhook(id: string, patch: UpdateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateWebhook");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateWebhook(validId, opts?.signal);
      if (found === null) throw new NotFoundError("webhook", validId);

      const text = await this.#fs.readText(found.filePath, { signal: opts?.signal });
      if (text === null) throw new NotFoundError("webhook", validId);

      const existing = decodeWebhook(found.projectId, validId, text, found.filePath);
      const next = applyWebhookPatch(existing, patch, this.#deps);

      if (next.projectId !== existing.projectId) {
        const targetProjExists = await this.#fs.fileExists(projectFilePath(next.projectId), { signal: opts?.signal });
        if (!targetProjExists) throw new NotFoundError("project", next.projectId);
        await this.#writeWebhooks(next.projectId, [next], opts?.signal);
        await this.#fs.removeFile(found.filePath, { signal: opts?.signal });
      } else {
        await this.#fs.writeTextAtomic(found.filePath, encodeWebhook(next), { signal: opts?.signal });
      }
      return cloneWebhook(next);
    }, { signal: opts?.signal });
  }

  async deleteWebhook(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteWebhook");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateWebhook(validId, opts?.signal);
      if (found === null) throw new NotFoundError("webhook", validId);
      await this.#fs.removeFile(found.filePath, { signal: opts?.signal });
    }, { signal: opts?.signal });
  }

  async recordWebhookTrigger(id: string, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "recordWebhookTrigger");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const found = await this.#locateWebhook(validId, opts?.signal);
      if (found === null) throw new NotFoundError("webhook", validId);

      const text = await this.#fs.readText(found.filePath, { signal: opts?.signal });
      if (text === null) throw new NotFoundError("webhook", validId);

      const existing = decodeWebhook(found.projectId, validId, text, found.filePath);
      const next = recordWebhookTriggerEntity(existing, this.#deps.clock());
      await this.#fs.writeTextAtomic(found.filePath, encodeWebhook(next), { signal: opts?.signal });
      return cloneWebhook(next);
    }, { signal: opts?.signal });
  }

  async exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "exportProject");

    const project = await this.getProject(validId, opts);
    if (project === null) throw new NotFoundError("project", validId);

    const tasks = await this.getTasks({ projectId: validId }, opts);
    const webhooks = await this.getWebhooks({ projectId: validId }, opts);
    const comments = await this.#lock.withLock(
      async () => this.#readProjectComments(validId, tasks, opts?.signal),
      { signal: opts?.signal },
    );

    const bundle: ProjectBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.#deps.clock()),
      project,
      tasks,
      comments,
      ...(webhooks.length > 0 ? { webhooks } : {}),
    };
    return parseOrThrow(ProjectBundleSchema, bundle, "exportProject result");
  }

  async importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(ProjectBundleSchema, bundle, "importProject");

    return this.#lock.withLock(async () => {
      throwIfAborted(opts?.signal);
      const dirPath = projectDirPath(validated.project.id);
      const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal: opts?.signal });
      const dirExists = rootEntries?.some((e) => e.kind === "directory" && e.name === validated.project.id);
      if (!dirExists) {
        await this.#fs.makeDir(dirPath, { signal: opts?.signal });
      }

      const metaPath = projectFilePath(validated.project.id);
      await this.#fs.writeTextAtomic(metaPath, encodeProject(validated.project), { signal: opts?.signal });

      for (const task of validated.tasks) {
        throwIfAborted(opts?.signal);
        const tPath = taskFilePath(validated.project.id, task.id);
        await this.#fs.writeTextAtomic(tPath, encodeTask(task), { signal: opts?.signal });
      }
      await this.#writeComments(validated.project.id, validated.comments ?? [], opts?.signal);
      await this.#writeWebhooks(validated.project.id, validated.webhooks ?? [], opts?.signal);

      return copyProject(validated.project);
    }, { signal: opts?.signal });
  }

  async exportAll(opts?: OperationOptions): Promise<BackupBundle> {
    throwIfAborted(opts?.signal);
    const projects = await this.getProjects(opts);
    const bundles: ProjectBundle[] = [];
    for (const p of projects) {
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

  /** Every project, unsorted; call under the lock. */
  async #readProjects(signal?: OperationOptions["signal"]): Promise<Project[]> {
    const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal });
    if (rootEntries === null) return [];

    const projects: Project[] = [];
    for (const entry of rootEntries) {
      throwIfAborted(signal);
      if (entry.kind === "directory" && isEntityId(entry.name)) {
        const filePath = projectFilePath(entry.name);
        const text = await this.#fs.readText(filePath, { signal });
        if (text !== null) {
          projects.push(decodeProject(entry.name, text, filePath));
        }
      }
    }
    return projects;
  }

  /** One project's tasks, unsorted; call under the lock. */
  async #readProjectTasks(projectId: string, signal?: OperationOptions["signal"]): Promise<Task[]> {
    const entries = await this.#fs.listDir(projectDirPath(projectId), { signal });
    if (entries === null) return [];

    const tasks: Task[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.kind === "file") {
        const taskId = taskIdFromFileName(entry.name);
        if (taskId !== null) {
          const filePath = taskFilePath(projectId, taskId);
          const text = await this.#fs.readText(filePath, { signal });
          if (text !== null) {
            tasks.push(decodeTask(projectId, taskId, text, filePath));
          }
        }
      }
    }
    return tasks;
  }

  /** One task's comments, unsorted; call under the lock. */
  async #readTaskComments(projectId: string, taskId: string, signal?: OperationOptions["signal"]): Promise<Comment[]> {
    const entries = await this.#fs.listDir(commentsDirPath(projectId, taskId), { signal });
    if (entries === null) return [];

    const comments: Comment[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.kind !== "file") continue;
      const commentId = commentIdFromFileName(entry.name);
      if (commentId === null) continue;
      const filePath = commentFilePath(projectId, taskId, commentId);
      const text = await this.#fs.readText(filePath, { signal });
      if (text !== null) comments.push(decodeComment(taskId, commentId, text, filePath));
    }
    return comments;
  }

  /** Comments on `tasks` of one project, oldest first; call under the lock. */
  async #readProjectComments(
    projectId: string,
    tasks: readonly Task[],
    signal?: OperationOptions["signal"],
  ): Promise<Comment[]> {
    const comments: Comment[] = [];
    for (const task of tasks) {
      throwIfAborted(signal);
      comments.push(...(await this.#readTaskComments(projectId, task.id, signal)));
    }
    return comments.sort(compareComments);
  }

  /** Writes comments into their tasks' comment directories in `projectId`; call under the lock. */
  async #writeComments(projectId: string, comments: readonly Comment[], signal?: OperationOptions["signal"]): Promise<void> {
    const readyDirs = new Set<string>();
    for (const comment of comments) {
      throwIfAborted(signal);
      const dir = commentsDirPath(projectId, comment.taskId);
      if (!readyDirs.has(dir)) {
        if ((await this.#fs.listDir(dir, { signal })) === null) await this.#fs.makeDir(dir, { signal });
        readyDirs.add(dir);
      }
      await this.#fs.writeTextAtomic(commentFilePath(projectId, comment.taskId, comment.id), encodeComment(comment), {
        signal,
      });
    }
  }

  /** One project's webhooks, unsorted; call under the lock. */
  async #readProjectWebhooks(projectId: string, signal?: OperationOptions["signal"]): Promise<Webhook[]> {
    const entries = await this.#fs.listDir(webhooksDirPath(projectId), { signal });
    if (entries === null) return [];

    const webhooks: Webhook[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      if (entry.kind !== "file") continue;
      const webhookId = webhookIdFromFileName(entry.name);
      if (webhookId === null) continue;
      const filePath = webhookFilePath(projectId, webhookId);
      const text = await this.#fs.readText(filePath, { signal });
      if (text !== null) webhooks.push(decodeWebhook(projectId, webhookId, text, filePath));
    }
    return webhooks;
  }

  /** Writes webhooks into `projectId`'s webhooks directory; call under the lock. */
  async #writeWebhooks(projectId: string, webhooks: readonly Webhook[], signal?: OperationOptions["signal"]): Promise<void> {
    if (webhooks.length === 0) return;
    const dir = webhooksDirPath(projectId);
    if ((await this.#fs.listDir(dir, { signal })) === null) {
      await this.#fs.makeDir(dir, { signal });
    }
    for (const webhook of webhooks) {
      throwIfAborted(signal);
      await this.#fs.writeTextAtomic(webhookFilePath(projectId, webhook.id), encodeWebhook(webhook), { signal });
    }
  }

  async #locateWebhook(webhookId: string, signal?: OperationOptions["signal"]): Promise<{ projectId: string; filePath: string } | null> {
    const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal });
    if (rootEntries === null) return null;

    for (const entry of rootEntries) {
      throwIfAborted(signal);
      if (entry.kind === "directory" && isEntityId(entry.name)) {
        const filePath = webhookFilePath(entry.name, webhookId);
        if (await this.#fs.fileExists(filePath, { signal })) {
          return { projectId: entry.name, filePath };
        }
      }
    }
    return null;
  }

  /** Path of the comment's file, or `null` if no task has it; call under the lock. */
  async #locateComment(commentId: string, signal?: OperationOptions["signal"]): Promise<string | null> {
    const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal });
    if (rootEntries === null) return null;

    for (const rootEntry of rootEntries) {
      if (rootEntry.kind !== "directory" || !isEntityId(rootEntry.name)) continue;
      const entries = await this.#fs.listDir(projectDirPath(rootEntry.name), { signal });
      for (const entry of entries ?? []) {
        throwIfAborted(signal);
        if (entry.kind !== "directory") continue;
        const taskId = taskIdFromCommentsDirName(entry.name);
        if (taskId === null) continue;
        const filePath = commentFilePath(rootEntry.name, taskId, commentId);
        if (await this.#fs.fileExists(filePath, { signal })) return filePath;
      }
    }
    return null;
  }

  async #locateTask(taskId: string, signal?: OperationOptions["signal"]): Promise<{ projectId: string; filePath: string } | null> {
    const rootEntries = await this.#fs.listDir(ROOT_PATH, { signal });
    if (rootEntries === null) return null;

    let match: { projectId: string; filePath: string } | null = null;

    for (const entry of rootEntries) {
      throwIfAborted(signal);
      if (entry.kind === "directory" && isEntityId(entry.name)) {
        const pId = entry.name;
        const filePath = taskFilePath(pId, taskId);
        const exists = await this.#fs.fileExists(filePath, { signal });
        if (exists) {
          if (match !== null) {
            throw new StorageError("corrupt", `Duplicate task ID ${taskId} found in multiple projects`, {
              location: `${match.filePath} and ${filePath}`,
            });
          }
          match = { projectId: pId, filePath };
        }
      }
    }

    return match;
  }
}
