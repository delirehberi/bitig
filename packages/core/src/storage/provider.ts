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
import type { AbortSignalLike } from "./abort";

export interface OperationOptions {
  /** Any standard `AbortSignal`. Aborting rejects the promise with `signal.reason`. */
  readonly signal?: AbortSignalLike;
  /** Optional LLM / actor name that is performing the mutation (e.g. `"claude"`, `"antigravity"`). */
  readonly actor?: string | undefined;
}

/**
 * Storage port implemented by every adapter (in-memory, Markdown, D1, Nostr,
 * HTTP API). All adapters must pass `runStorageContractSuite` from
 * `@bitig/core/testing`.
 *
 * Error contract:
 * - Invalid input rejects with `ValidationError`.
 * - Reads of a missing entity (`getProject`, `getTask`) resolve to `null`.
 * - Mutations of a missing entity reject with `NotFoundError`.
 * - An aborted signal rejects with the signal's reason and has no side effects.
 *
 * Returned entities are copies; mutating them never affects stored state.
 */
export interface StorageProvider {
  /** All projects, oldest first (`compareProjects`). */
  getProjects(opts?: OperationOptions): Promise<Project[]>;
  getProject(id: string, opts?: OperationOptions): Promise<Project | null>;
  createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project>;
  updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project>;
  /** Deletes the project and every task, comment and webhook that belongs to it. */
  deleteProject(id: string, opts?: OperationOptions): Promise<void>;

  /** Tasks, optionally limited to one project, in `compareTasks` order. An
   * unknown `projectId` yields an empty list. */
  getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]>;
  getTask(id: string, opts?: OperationOptions): Promise<Task | null>;
  /** Creates a task. Rejects with `NotFoundError` if the project does not exist. */
  saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task>;
  /** Patches a task. Moving it to another project requires that project to exist. */
  updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task>;
  /** Deletes the task and its comments. */
  deleteTask(id: string, opts?: OperationOptions): Promise<void>;
  /** Sets `status` to `done`. Idempotent: an already-done task is returned unchanged. */
  completeTask(id: string, opts?: OperationOptions): Promise<Task>;

  /** A task's comments, oldest first (`compareComments`). An unknown task yields an empty list.
   * Comments stay with their task when it moves to another project. */
  getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]>;
  /** Adds a comment. Rejects with `NotFoundError` if the task does not exist. Leaves the task,
   * including its `updatedAt`, unchanged. */
  addComment(input: CreateCommentInput, opts?: OperationOptions): Promise<Comment>;
  /** Rejects with `NotFoundError` if no comment has this ID. */
  deleteComment(id: string, opts?: OperationOptions): Promise<void>;

  /** Webhooks, optionally limited to one project, oldest first (`compareWebhooks`). */
  getWebhooks(filter?: WebhookFilter, opts?: OperationOptions): Promise<Webhook[]>;
  getWebhook(id: string, opts?: OperationOptions): Promise<Webhook | null>;
  /** Finds a webhook by its secret token, or `null` if none matches. */
  getWebhookByToken(token: string, opts?: OperationOptions): Promise<Webhook | null>;
  /** Creates a webhook. Rejects with `NotFoundError` if the project does not exist. */
  createWebhook(input: CreateWebhookInput, opts?: OperationOptions): Promise<Webhook>;
  /** Patches a webhook. Moving it to another project requires that project to exist. */
  updateWebhook(id: string, patch: UpdateWebhookInput, opts?: OperationOptions): Promise<Webhook>;
  /** Deletes a webhook by ID. Rejects with `NotFoundError` if missing. */
  deleteWebhook(id: string, opts?: OperationOptions): Promise<void>;
  /** Increments `triggerCount` and updates `lastTriggeredAt` on a webhook. */
  recordWebhookTrigger(id: string, opts?: OperationOptions): Promise<Webhook>;

  /** Exports a project with all its tasks and their comments as a validated bundle. */
  exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle>;
  /** Imports a project, its tasks and their comments, restoring exact fields and timestamps idempotently. */
  importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project>;
  /** Exports all projects and tasks as a backup bundle. */
  exportAll(opts?: OperationOptions): Promise<BackupBundle>;
  /** Restores all projects and tasks from a backup bundle. */
  importBackup(backup: BackupBundle, opts?: OperationOptions): Promise<void>;
}
