import type {
  BackupBundle,
  CreateProjectInput,
  CreateTaskInput,
  Project,
  ProjectBundle,
  Task,
  TaskFilter,
  UpdateProjectInput,
  UpdateTaskInput,
} from "../domain/types";
import type { AbortSignalLike } from "./abort";

export interface OperationOptions {
  /** Any standard `AbortSignal`. Aborting rejects the promise with `signal.reason`. */
  readonly signal?: AbortSignalLike;
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
  /** Deletes the project and every task that belongs to it. */
  deleteProject(id: string, opts?: OperationOptions): Promise<void>;

  /** Tasks, optionally limited to one project, in `compareTasks` order. An
   * unknown `projectId` yields an empty list. */
  getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]>;
  getTask(id: string, opts?: OperationOptions): Promise<Task | null>;
  /** Creates a task. Rejects with `NotFoundError` if the project does not exist. */
  saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task>;
  /** Patches a task. Moving it to another project requires that project to exist. */
  updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task>;
  deleteTask(id: string, opts?: OperationOptions): Promise<void>;
  /** Sets `status` to `done`. Idempotent: an already-done task is returned unchanged. */
  completeTask(id: string, opts?: OperationOptions): Promise<Task>;

  /** Exports a project and all its tasks as a validated bundle. */
  exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle>;
  /** Imports a project and its tasks, restoring exact fields and timestamps idempotently. */
  importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project>;
  /** Exports all projects and tasks as a backup bundle. */
  exportAll(opts?: OperationOptions): Promise<BackupBundle>;
  /** Restores all projects and tasks from a backup bundle. */
  importBackup(backup: BackupBundle, opts?: OperationOptions): Promise<void>;
}
