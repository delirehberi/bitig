import {
  BUNDLE_VERSION,
  BackupBundleSchema,
  IdSchema,
  NotFoundError,
  ProjectBundleSchema,
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
  parseOrThrow,
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
import { decodeProjectEvent, encodeProjectEvent } from "./codecs/project-codec";
import { decodeTaskEvent, encodeTaskEvent } from "./codecs/task-codec";
import {
  formatAddressCoordinate,
  NOSTR_KIND_DELETE,
  NOSTR_KIND_PROJECT,
  NOSTR_KIND_TASK,
  NOSTR_TAG_A,
  NOSTR_TAG_D,
} from "./kinds";
import { RelayManager } from "./pool/relay-manager";
import type { NostrSigner } from "./signer/signer";

export interface NostrStorageOptions {
  signer: NostrSigner;
  relayManager?: RelayManager;
  relays?: readonly string[];
  deps?: RuntimeDeps;
}

function copyProject(project: Project): Project {
  return cloneProject(project);
}

function copyTask(task: Task): Task {
  return cloneTask(task);
}

export class NostrStorage implements StorageProvider {
  private readonly signer: NostrSigner;
  private readonly relayManager: RelayManager;
  private readonly deps: RuntimeDeps;

  // Local cache indexed by domain ID for quick access and deterministic testing
  private readonly projects = new Map<string, Project>();
  private readonly tasks = new Map<string, Task>();
  private synced = false;

  constructor(options: NostrStorageOptions) {
    this.signer = options.signer;
    this.relayManager =
      options.relayManager ??
      new RelayManager(
        options.relays !== undefined ? { relays: options.relays } : undefined,
      );
    this.deps = options.deps ?? defaultRuntimeDeps;
  }

  getRelayManager(): RelayManager {
    return this.relayManager;
  }

  private async syncFromRelays(opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    if (this.synced) return;

    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const [projectEvents, taskEvents] = await Promise.all([
      this.relayManager.queryReplaceable({ kinds: [NOSTR_KIND_PROJECT], authors: [pubkey] }, pubkey),
      this.relayManager.queryReplaceable({ kinds: [NOSTR_KIND_TASK], authors: [pubkey] }, pubkey),
    ]);
    throwIfAborted(opts?.signal);

    for (const event of projectEvents) {
      try {
        const project = decodeProjectEvent(event);
        this.projects.set(project.id, project);
      } catch {
        // Discard malformed project events
      }
    }

    for (const event of taskEvents) {
      try {
        const task = await decodeTaskEvent(event, pubkey, this.signer);
        this.tasks.set(task.id, task);
      } catch {
        // Discard malformed or un-decryptable task events
      }
    }

    this.synced = true;
  }

  async getProjects(opts?: OperationOptions): Promise<Project[]> {
    throwIfAborted(opts?.signal);
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    return Array.from(this.projects.values()).sort(compareProjects).map(copyProject);
  }

  async getProject(id: string, opts?: OperationOptions): Promise<Project | null> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "getProject id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const project = this.projects.get(id);
    return project ? copyProject(project) : null;
  }

  async createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const project = buildProject(input, this.deps);
    const template = encodeProjectEvent(project);

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(template);

    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    this.projects.set(project.id, project);
    return copyProject(project);
  }

  async updateProject(
    id: string,
    patch: UpdateProjectInput,
    opts?: OperationOptions,
  ): Promise<Project> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "updateProject id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.projects.get(id);
    if (!existing) {
      throw new NotFoundError("project", id);
    }

    const updated = applyProjectPatch(existing, patch, this.deps.clock());
    const template = encodeProjectEvent(updated);

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(template);

    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    this.projects.set(id, updated);
    return copyProject(updated);
  }

  async deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "deleteProject id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.projects.get(id);
    if (!existing) {
      throw new NotFoundError("project", id);
    }

    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    // Cascading deletion: collect all task coordinates belonging to this project
    const childTasks = Array.from(this.tasks.values()).filter((t) => t.projectId === id);

    const tags: string[][] = [
      [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_PROJECT, pubkey, id)],
    ];
    for (const t of childTasks) {
      tags.push([NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_TASK, pubkey, t.id)]);
    }
    tags.push(["k", String(NOSTR_KIND_PROJECT)]);
    if (childTasks.length > 0) {
      tags.push(["k", String(NOSTR_KIND_TASK)]);
    }

    const deleteTemplate = {
      kind: NOSTR_KIND_DELETE,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: `Deleted project ${id} and ${String(childTasks.length)} child tasks`,
    };

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(deleteTemplate);

    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    // Remove from local cache
    this.projects.delete(id);
    for (const t of childTasks) {
      this.tasks.delete(t.id);
    }
  }

  async getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter ? parseOrThrow(TaskFilterSchema, filter, "getTasks filter") : undefined;
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    let list = Array.from(this.tasks.values());
    if (parsedFilter?.projectId !== undefined) {
      list = list.filter((t) => t.projectId === parsedFilter.projectId);
    }

    return list.sort(compareTasks).map(copyTask);
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "getTask id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const task = this.tasks.get(id);
    return task ? copyTask(task) : null;
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const task = buildTask(input, this.deps);
    if (!this.projects.has(task.projectId)) {
      throw new NotFoundError("project", task.projectId);
    }

    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const template = await encodeTaskEvent(task, pubkey, this.signer);
    throwIfAborted(opts?.signal);

    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);

    await this.relayManager.publishEvent(signed);

    this.tasks.set(task.id, task);
    return copyTask(task);
  }

  async updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "updateTask id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.tasks.get(id);
    if (!existing) {
      throw new NotFoundError("task", id);
    }

    if (patch.projectId !== undefined && !this.projects.has(patch.projectId)) {
      throw new NotFoundError("project", patch.projectId);
    }

    const updated = applyTaskPatch(existing, patch, this.deps.clock());
    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const template = await encodeTaskEvent(updated, pubkey, this.signer);
    throwIfAborted(opts?.signal);

    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);

    await this.relayManager.publishEvent(signed);

    this.tasks.set(id, updated);
    return copyTask(updated);
  }

  async deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "deleteTask id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.tasks.get(id);
    if (!existing) {
      throw new NotFoundError("task", id);
    }

    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const deleteTemplate = {
      kind: NOSTR_KIND_DELETE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_TASK, pubkey, id)],
        [NOSTR_TAG_D, id],
        ["k", String(NOSTR_KIND_TASK)],
      ],
      content: `Deleted task ${id}`,
    };

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(deleteTemplate);

    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    this.tasks.delete(id);
  }

  async completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "completeTask id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.tasks.get(id);
    if (!existing) {
      throw new NotFoundError("task", id);
    }

    // Idempotent: if already done, return unchanged without publishing
    if (existing.status === "done") {
      return copyTask(existing);
    }

    const completed = completeTaskEntity(existing, this.deps.clock());
    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const template = await encodeTaskEvent(completed, pubkey, this.signer);
    throwIfAborted(opts?.signal);

    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);

    await this.relayManager.publishEvent(signed);

    this.tasks.set(id, completed);
    return copyTask(completed);
  }

  async exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "exportProject id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const project = this.projects.get(id);
    if (!project) {
      throw new NotFoundError("project", id);
    }

    const tasks = await this.getTasks({ projectId: id }, opts);
    const bundle: ProjectBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.deps.clock()),
      project: copyProject(project),
      tasks,
    };
    return parseOrThrow(ProjectBundleSchema, bundle, "exportProject result");
  }

  async importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(ProjectBundleSchema, bundle, "importProject");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const projectTemplate = encodeProjectEvent(validated.project);
    throwIfAborted(opts?.signal);
    const signedProject = await this.signer.signEvent(projectTemplate);
    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signedProject);

    this.projects.set(validated.project.id, copyProject(validated.project));

    const pubkey = await this.signer.getPublicKey();
    for (const task of validated.tasks) {
      throwIfAborted(opts?.signal);
      const taskTemplate = await encodeTaskEvent(task, pubkey, this.signer);
      throwIfAborted(opts?.signal);
      const signedTask = await this.signer.signEvent(taskTemplate);
      throwIfAborted(opts?.signal);
      await this.relayManager.publishEvent(signedTask);
      this.tasks.set(task.id, copyTask(task));
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
      exportedAt: toTimestamp(this.deps.clock()),
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
}

