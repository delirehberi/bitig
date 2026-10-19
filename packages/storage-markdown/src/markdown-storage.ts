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
  applyProjectPatch,
  applyTaskPatch,
  buildProject,
  buildTask,
  cloneProject,
  cloneTask,
  compareProjects,
  compareTasks,
  completeTaskEntity,
  defaultRuntimeDeps,
  nextTaskNumber,
  parseOrThrow,
  renumberTask,
  throwIfAborted,
  toTimestamp,
  type BackupBundle,
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
import { decodeProject, decodeTask, encodeProject, encodeTask } from "./format/codec";
import type { FileSystemPort } from "./fs/port";
import {
  ROOT_PATH,
  isEntityId,
  projectDirPath,
  projectFilePath,
  taskFilePath,
  taskIdFromFileName,
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
        await this.#fs.removeFile(found.filePath, { signal: opts?.signal });
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

  async exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "exportProject");

    const project = await this.getProject(validId, opts);
    if (project === null) throw new NotFoundError("project", validId);

    const tasks = await this.getTasks({ projectId: validId }, opts);

    const bundle: ProjectBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.#deps.clock()),
      project,
      tasks,
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
