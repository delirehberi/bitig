import {
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
  recordWebhookTriggerEntity,
  renumberTask,
} from "../domain/entities";
import { nextTaskNumber } from "../domain/ticket-codes";
import { NotFoundError, parseOrThrow } from "../domain/errors";
import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  IdSchema,
  ProjectBundleSchema,
  TaskFilterSchema,
  WebhookFilterSchema,
  WebhookTokenSchema,
} from "../domain/schemas";
import type {
  BackupBundle,
  Comment,
  CreateCommentInput,
  CreateProjectInput,
  CreateTaskInput,
  CreateWebhookInput,
  Project,
  ProjectBundle,
  Task,
  TaskFilter,
  UpdateProjectInput,
  UpdateTaskInput,
  UpdateWebhookInput,
  Webhook,
  WebhookFilter,
} from "../domain/types";
import { defaultRuntimeDeps, toTimestamp, type RuntimeDeps } from "../runtime/ids";
import { throwIfAborted, type AbortSignalLike } from "../storage/abort";
import type { OperationOptions, StorageProvider } from "../storage/provider";

const copyProject = cloneProject;

const copyTask = cloneTask;

/**
 * Runs a synchronous operation as a promise. Abort checks and every thrown
 * domain error surface as rejections, matching asynchronous adapters.
 */
function run<T>(signal: AbortSignalLike | undefined, operation: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    throwIfAborted(signal);
    resolve(operation());
  });
}

function parseId(id: string, context: string): string {
  return parseOrThrow(IdSchema, id, context);
}

/**
 * Reference `StorageProvider` backed by in-process maps. State is per
 * instance and lost when the instance is discarded. Used as the contract
 * suite's baseline and as a test double for UI and MCP code.
 */
export class InMemoryStorage implements StorageProvider {
  readonly #projects = new Map<string, Project>();
  readonly #tasks = new Map<string, Task>();
  readonly #comments = new Map<string, Comment>();
  readonly #webhooks = new Map<string, Webhook>();
  readonly #deps: RuntimeDeps;

  constructor(deps: RuntimeDeps = defaultRuntimeDeps) {
    this.#deps = deps;
  }

  getProjects(opts?: OperationOptions): Promise<Project[]> {
    return run(opts?.signal, () => [...this.#projects.values()].sort(compareProjects).map(copyProject));
  }

  getProject(id: string, opts?: OperationOptions): Promise<Project | null> {
    return run(opts?.signal, () => {
      const project = this.#projects.get(parseId(id, "getProject"));
      return project === undefined ? null : copyProject(project);
    });
  }

  createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project> {
    return run(opts?.signal, () => {
      const project = buildProject(input, this.#deps, this.#keys());
      this.#projects.set(project.id, project);
      return copyProject(project);
    });
  }

  updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project> {
    return run(opts?.signal, () => {
      const existing = this.#requireProject(parseId(id, "updateProject"));
      const next = applyProjectPatch(existing, patch, this.#deps.clock(), this.#keys(existing.id));
      this.#projects.set(next.id, next);
      return copyProject(next);
    });
  }

  deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    return run(opts?.signal, () => {
      const project = this.#requireProject(parseId(id, "deleteProject"));
      for (const task of [...this.#tasks.values()]) {
        if (task.projectId === project.id) this.#deleteTaskAndComments(task.id);
      }
      for (const webhook of [...this.#webhooks.values()]) {
        if (webhook.projectId === project.id) this.#webhooks.delete(webhook.id);
      }
      this.#projects.delete(project.id);
    });
  }

  getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    return run(opts?.signal, () => {
      const { projectId } = parseOrThrow(TaskFilterSchema, filter ?? {}, "getTasks");
      return [...this.#tasks.values()]
        .filter((task) => projectId === undefined || task.projectId === projectId)
        .sort(compareTasks)
        .map(copyTask);
    });
  }

  getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    return run(opts?.signal, () => {
      const task = this.#tasks.get(parseId(id, "getTask"));
      return task === undefined ? null : copyTask(task);
    });
  }

  saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    return run(opts?.signal, () => {
      const projectId = parseOrThrow(IdSchema, input.projectId, "saveTask");
      const task = buildTask(input, this.#deps, nextTaskNumber(this.#tasksOf(projectId)), opts?.actor);
      this.#requireProject(task.projectId);
      this.#tasks.set(task.id, task);
      return copyTask(task);
    });
  }

  updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    return run(opts?.signal, () => {
      const existing = this.#requireTask(parseId(id, "updateTask"));
      let next = applyTaskPatch(existing, patch, this.#deps.clock(), opts?.actor);
      if (next.projectId !== existing.projectId) {
        this.#requireProject(next.projectId);
        next = renumberTask(next, nextTaskNumber(this.#tasksOf(next.projectId)));
      }
      this.#tasks.set(next.id, next);
      return copyTask(next);
    });
  }

  deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    return run(opts?.signal, () => {
      const task = this.#requireTask(parseId(id, "deleteTask"));
      this.#deleteTaskAndComments(task.id);
    });
  }

  completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    return run(opts?.signal, () => {
      const existing = this.#requireTask(parseId(id, "completeTask"));
      const next = completeTaskEntity(existing, this.#deps.clock(), opts?.actor);
      this.#tasks.set(next.id, next);
      return copyTask(next);
    });
  }

  getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]> {
    return run(opts?.signal, () => {
      const validTaskId = parseId(taskId, "getComments");
      return this.#commentsOf([validTaskId]).map(cloneComment);
    });
  }

  addComment(input: CreateCommentInput, opts?: OperationOptions): Promise<Comment> {
    return run(opts?.signal, () => {
      const comment = buildComment(input, this.#deps);
      this.#requireTask(comment.taskId);
      this.#comments.set(comment.id, comment);
      return cloneComment(comment);
    });
  }

  deleteComment(id: string, opts?: OperationOptions): Promise<void> {
    return run(opts?.signal, () => {
      const validId = parseId(id, "deleteComment");
      if (!this.#comments.delete(validId)) throw new NotFoundError("comment", validId);
    });
  }

  getWebhooks(filter?: WebhookFilter, opts?: OperationOptions): Promise<Webhook[]> {
    return run(opts?.signal, () => {
      const { projectId } = parseOrThrow(WebhookFilterSchema, filter ?? {}, "getWebhooks");
      return [...this.#webhooks.values()]
        .filter((webhook) => projectId === undefined || webhook.projectId === projectId)
        .sort(compareWebhooks)
        .map(cloneWebhook);
    });
  }

  getWebhook(id: string, opts?: OperationOptions): Promise<Webhook | null> {
    return run(opts?.signal, () => {
      const webhook = this.#webhooks.get(parseId(id, "getWebhook"));
      return webhook === undefined ? null : cloneWebhook(webhook);
    });
  }

  getWebhookByToken(token: string, opts?: OperationOptions): Promise<Webhook | null> {
    return run(opts?.signal, () => {
      const validToken = parseOrThrow(WebhookTokenSchema, token, "getWebhookByToken");
      for (const webhook of this.#webhooks.values()) {
        if (webhook.token === validToken) return cloneWebhook(webhook);
      }
      return null;
    });
  }

  createWebhook(input: CreateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    return run(opts?.signal, () => {
      const webhook = buildWebhook(input, this.#deps);
      this.#requireProject(webhook.projectId);
      this.#webhooks.set(webhook.id, webhook);
      return cloneWebhook(webhook);
    });
  }

  updateWebhook(id: string, patch: UpdateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    return run(opts?.signal, () => {
      const existing = this.#requireWebhook(parseId(id, "updateWebhook"));
      const next = applyWebhookPatch(existing, patch, this.#deps);
      if (next.projectId !== existing.projectId) {
        this.#requireProject(next.projectId);
      }
      this.#webhooks.set(next.id, next);
      return cloneWebhook(next);
    });
  }

  deleteWebhook(id: string, opts?: OperationOptions): Promise<void> {
    return run(opts?.signal, () => {
      const webhook = this.#requireWebhook(parseId(id, "deleteWebhook"));
      this.#webhooks.delete(webhook.id);
    });
  }

  recordWebhookTrigger(id: string, opts?: OperationOptions): Promise<Webhook> {
    return run(opts?.signal, () => {
      const existing = this.#requireWebhook(parseId(id, "recordWebhookTrigger"));
      const next = recordWebhookTriggerEntity(existing, this.#deps.clock());
      this.#webhooks.set(next.id, next);
      return cloneWebhook(next);
    });
  }

  exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    return run(opts?.signal, () => {
      const project = this.#requireProject(parseId(id, "exportProject"));
      const tasks = [...this.#tasks.values()]
        .filter((t) => t.projectId === project.id)
        .sort(compareTasks)
        .map(copyTask);
      const webhooks = [...this.#webhooks.values()]
        .filter((w) => w.projectId === project.id)
        .sort(compareWebhooks)
        .map(cloneWebhook);
      const bundle: ProjectBundle = {
        version: BUNDLE_VERSION,
        exportedAt: toTimestamp(this.#deps.clock()),
        project: copyProject(project),
        tasks,
        comments: this.#commentsOf(tasks.map((t) => t.id)).map(cloneComment),
        ...(webhooks.length > 0 ? { webhooks } : {}),
      };
      return parseOrThrow(ProjectBundleSchema, bundle, "exportProject result");
    });
  }

  importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project> {
    return run(opts?.signal, () => {
      const validated = parseOrThrow(ProjectBundleSchema, bundle, "importProject");
      this.#projects.set(validated.project.id, copyProject(validated.project));
      for (const task of validated.tasks) {
        this.#tasks.set(task.id, copyTask(task));
      }
      for (const comment of validated.comments ?? []) {
        this.#comments.set(comment.id, cloneComment(comment));
      }
      for (const webhook of validated.webhooks ?? []) {
        this.#webhooks.set(webhook.id, cloneWebhook(webhook));
      }
      return copyProject(validated.project);
    });
  }

  async exportAll(opts?: OperationOptions): Promise<BackupBundle> {
    throwIfAborted(opts?.signal);
    const projects = await this.getProjects(opts);
    const bundles: ProjectBundle[] = [];
    for (const p of projects) {
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
      await this.importProject(bundle, opts);
    }
  }

  /** Keys of every project except `exceptId`. */
  #keys(exceptId?: string): string[] {
    return [...this.#projects.values()].flatMap((p) => (p.key === undefined || p.id === exceptId ? [] : [p.key]));
  }

  #tasksOf(projectId: string): Task[] {
    return [...this.#tasks.values()].filter((t) => t.projectId === projectId);
  }

  /** Comments on any of `taskIds`, oldest first. */
  #commentsOf(taskIds: readonly string[]): Comment[] {
    const ids = new Set(taskIds);
    return [...this.#comments.values()].filter((c) => ids.has(c.taskId)).sort(compareComments);
  }

  #deleteTaskAndComments(taskId: string): void {
    this.#tasks.delete(taskId);
    for (const comment of [...this.#comments.values()]) {
      if (comment.taskId === taskId) this.#comments.delete(comment.id);
    }
  }

  #requireProject(id: string): Project {
    const project = this.#projects.get(id);
    if (project === undefined) throw new NotFoundError("project", id);
    return project;
  }

  #requireTask(id: string): Task {
    const task = this.#tasks.get(id);
    if (task === undefined) throw new NotFoundError("task", id);
    return task;
  }

  #requireWebhook(id: string): Webhook {
    const webhook = this.#webhooks.get(id);
    if (webhook === undefined) throw new NotFoundError("webhook", id);
    return webhook;
  }
}

