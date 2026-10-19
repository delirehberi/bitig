import {
  applyProjectPatch,
  applyTaskPatch,
  buildProject,
  buildTask,
  cloneProject,
  cloneTask,
  compareProjects,
  compareTasks,
  completeTaskEntity,
} from "../domain/entities";
import { NotFoundError, parseOrThrow } from "../domain/errors";
import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  IdSchema,
  ProjectBundleSchema,
  TaskFilterSchema,
} from "../domain/schemas";
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
      const project = buildProject(input, this.#deps);
      this.#projects.set(project.id, project);
      return copyProject(project);
    });
  }

  updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project> {
    return run(opts?.signal, () => {
      const existing = this.#requireProject(parseId(id, "updateProject"));
      const next = applyProjectPatch(existing, patch, this.#deps.clock());
      this.#projects.set(next.id, next);
      return copyProject(next);
    });
  }

  deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    return run(opts?.signal, () => {
      const project = this.#requireProject(parseId(id, "deleteProject"));
      for (const task of [...this.#tasks.values()]) {
        if (task.projectId === project.id) this.#tasks.delete(task.id);
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
      const task = buildTask(input, this.#deps);
      this.#requireProject(task.projectId);
      this.#tasks.set(task.id, task);
      return copyTask(task);
    });
  }

  updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    return run(opts?.signal, () => {
      const existing = this.#requireTask(parseId(id, "updateTask"));
      const next = applyTaskPatch(existing, patch, this.#deps.clock());
      if (next.projectId !== existing.projectId) this.#requireProject(next.projectId);
      this.#tasks.set(next.id, next);
      return copyTask(next);
    });
  }

  deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    return run(opts?.signal, () => {
      const task = this.#requireTask(parseId(id, "deleteTask"));
      this.#tasks.delete(task.id);
    });
  }

  completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    return run(opts?.signal, () => {
      const existing = this.#requireTask(parseId(id, "completeTask"));
      const next = completeTaskEntity(existing, this.#deps.clock());
      this.#tasks.set(next.id, next);
      return copyTask(next);
    });
  }

  exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    return run(opts?.signal, () => {
      const project = this.#requireProject(parseId(id, "exportProject"));
      const tasks = [...this.#tasks.values()]
        .filter((t) => t.projectId === project.id)
        .sort(compareTasks)
        .map(copyTask);
      const bundle: ProjectBundle = {
        version: BUNDLE_VERSION,
        exportedAt: toTimestamp(this.#deps.clock()),
        project: copyProject(project),
        tasks,
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
}

