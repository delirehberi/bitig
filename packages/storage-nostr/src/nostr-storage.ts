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
  nextTaskNumber,
  parseOrThrow,
  recordWebhookTriggerEntity,
  renumberTask,
  throwIfAborted,
  toTimestamp,
  withTaskCommentCount,
  withoutDependencies,
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
import { decodeCommentEvent, encodeCommentEvent } from "./codecs/comment-codec";
import { decodeProjectEvent, encodeProjectEvent } from "./codecs/project-codec";
import { decodeTaskEvent, encodeTaskEvent } from "./codecs/task-codec";
import { decodeWebhookEvent, encodeWebhookEvent } from "./codecs/webhook-codec";
import {
  formatAddressCoordinate,
  NOSTR_KIND_COMMENT,
  NOSTR_KIND_DELETE,
  NOSTR_KIND_PROJECT,
  NOSTR_KIND_TASK,
  NOSTR_KIND_WEBHOOK,
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
  private readonly comments = new Map<string, Comment>();
  private readonly webhooks = new Map<string, Webhook>();
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

    const [projectEvents, taskEvents, commentEvents, webhookEvents] = await Promise.all([
      this.relayManager.queryReplaceable({ kinds: [NOSTR_KIND_PROJECT], authors: [pubkey] }, pubkey),
      this.relayManager.queryReplaceable({ kinds: [NOSTR_KIND_TASK], authors: [pubkey] }, pubkey),
      this.relayManager.queryReplaceable({ kinds: [NOSTR_KIND_COMMENT], authors: [pubkey] }, pubkey),
      this.relayManager.queryReplaceable({ kinds: [NOSTR_KIND_WEBHOOK], authors: [pubkey] }, pubkey),
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

    for (const event of commentEvents) {
      try {
        const comment = await decodeCommentEvent(event, pubkey, this.signer);
        this.comments.set(comment.id, comment);
      } catch {
        // Discard malformed or un-decryptable comment events
      }
    }

    for (const event of webhookEvents) {
      try {
        const webhook = await decodeWebhookEvent(event, pubkey, this.signer);
        this.webhooks.set(webhook.id, webhook);
      } catch {
        // Discard malformed or un-decryptable webhook events
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

    const project = buildProject(input, this.deps, this.projectKeys());
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

    const updated = applyProjectPatch(existing, patch, this.deps.clock(), this.projectKeys(id));
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
    const childWebhooks = Array.from(this.webhooks.values()).filter((w) => w.projectId === id);

    const tags: string[][] = [
      [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_PROJECT, pubkey, id)],
    ];
    for (const t of childTasks) {
      tags.push([NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_TASK, pubkey, t.id)]);
    }
    const childComments = this.commentsOf(childTasks.map((t) => t.id));
    for (const c of childComments) {
      tags.push([NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_COMMENT, pubkey, c.id)]);
    }
    for (const w of childWebhooks) {
      tags.push([NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_WEBHOOK, pubkey, w.id)]);
    }
    tags.push(["k", String(NOSTR_KIND_PROJECT)]);
    if (childTasks.length > 0) {
      tags.push(["k", String(NOSTR_KIND_TASK)]);
    }
    if (childComments.length > 0) {
      tags.push(["k", String(NOSTR_KIND_COMMENT)]);
    }
    if (childWebhooks.length > 0) {
      tags.push(["k", String(NOSTR_KIND_WEBHOOK)]);
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
    for (const c of childComments) {
      this.comments.delete(c.id);
    }
    for (const w of childWebhooks) {
      this.webhooks.delete(w.id);
    }
    await this.dropDependencies(new Set(childTasks.map((t) => t.id)), opts);
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

    return list.sort(compareTasks).map((t) => this.withCommentCount(t));
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "getTask id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const task = this.tasks.get(id);
    return task ? this.withCommentCount(task) : null;
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const projectId = parseOrThrow(IdSchema, input.projectId, "saveTask");
    const task = buildTask(input, this.deps, nextTaskNumber(this.tasksOf(projectId)), opts?.actor);
    if (!this.projects.has(task.projectId)) {
      throw new NotFoundError("project", task.projectId);
    }
    if (hasNewDependencies(undefined, task)) assertTaskDependencies(task, this.tasks.values(), "saveTask");

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

    let updated = applyTaskPatch(existing, patch, this.deps.clock(), opts?.actor, opts?.overrideBlockedBy);
    if (updated.projectId !== existing.projectId) {
      updated = renumberTask(updated, nextTaskNumber(this.tasksOf(updated.projectId)));
    }
    if (hasNewDependencies(existing, updated)) {
      assertTaskDependencies(updated, this.tasks.values(), "updateTask");
    }
    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const template = await encodeTaskEvent(updated, pubkey, this.signer);
    throwIfAborted(opts?.signal);

    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);

    await this.relayManager.publishEvent(signed);

    this.tasks.set(id, updated);
    return this.withCommentCount(updated);
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

    const childComments = this.commentsOf([id]);
    const tags: string[][] = [
      [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_TASK, pubkey, id)],
      [NOSTR_TAG_D, id],
    ];
    for (const c of childComments) {
      tags.push([NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_COMMENT, pubkey, c.id)]);
    }
    tags.push(["k", String(NOSTR_KIND_TASK)]);
    if (childComments.length > 0) {
      tags.push(["k", String(NOSTR_KIND_COMMENT)]);
    }
    const deleteTemplate = {
      kind: NOSTR_KIND_DELETE,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: `Deleted task ${id}`,
    };

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(deleteTemplate);

    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    this.tasks.delete(id);
    for (const c of childComments) {
      this.comments.delete(c.id);
    }
    await this.dropDependencies(new Set([id]), opts);
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

    const completed = completeTaskEntity(existing, this.deps.clock(), opts?.actor, opts?.overrideBlockedBy);
    // Idempotent: if already done, return unchanged without publishing
    if (completed === existing) {
      return this.withCommentCount(existing);
    }
    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const template = await encodeTaskEvent(completed, pubkey, this.signer);
    throwIfAborted(opts?.signal);

    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);

    await this.relayManager.publishEvent(signed);

    this.tasks.set(id, completed);
    return this.withCommentCount(completed);
  }

  async getComments(taskId: string, opts?: OperationOptions): Promise<Comment[]> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, taskId, "getComments taskId");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    return this.commentsOf([taskId]).map(cloneComment);
  }

  async addComment(input: CreateCommentInput, opts?: OperationOptions): Promise<Comment> {
    throwIfAborted(opts?.signal);
    const comment = buildComment(input, this.deps);
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);
    if (!this.tasks.has(comment.taskId)) {
      throw new NotFoundError("task", comment.taskId);
    }

    await this.publishComment(comment, opts);
    this.comments.set(comment.id, comment);
    return cloneComment(comment);
  }

  async deleteComment(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "deleteComment id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    if (!this.comments.has(id)) {
      throw new NotFoundError("comment", id);
    }

    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const deleteTemplate = {
      kind: NOSTR_KIND_DELETE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_COMMENT, pubkey, id)],
        ["k", String(NOSTR_KIND_COMMENT)],
      ],
      content: `Deleted comment ${id}`,
    };

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(deleteTemplate);

    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    this.comments.delete(id);
  }

  async getWebhooks(filter?: WebhookFilter, opts?: OperationOptions): Promise<Webhook[]> {
    throwIfAborted(opts?.signal);
    const parsedFilter = filter ? parseOrThrow(WebhookFilterSchema, filter, "getWebhooks filter") : undefined;
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    let list = Array.from(this.webhooks.values());
    if (parsedFilter?.projectId !== undefined) {
      list = list.filter((w) => w.projectId === parsedFilter.projectId);
    }
    return list.sort(compareWebhooks).map(cloneWebhook);
  }

  async getWebhook(id: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "getWebhook id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const webhook = this.webhooks.get(id);
    return webhook ? cloneWebhook(webhook) : null;
  }

  async getWebhookByToken(token: string, opts?: OperationOptions): Promise<Webhook | null> {
    throwIfAborted(opts?.signal);
    const validToken = parseOrThrow(WebhookTokenSchema, token, "getWebhookByToken token");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    for (const webhook of this.webhooks.values()) {
      if (webhook.token === validToken) return cloneWebhook(webhook);
    }
    return null;
  }

  async createWebhook(input: CreateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    const webhook = buildWebhook(input, this.deps);
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);
    if (!this.projects.has(webhook.projectId)) {
      throw new NotFoundError("project", webhook.projectId);
    }

    await this.publishWebhook(webhook, opts);
    this.webhooks.set(webhook.id, webhook);
    return cloneWebhook(webhook);
  }

  async updateWebhook(id: string, patch: UpdateWebhookInput, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "updateWebhook id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.webhooks.get(id);
    if (!existing) {
      throw new NotFoundError("webhook", id);
    }
    if (patch.projectId !== undefined && !this.projects.has(patch.projectId)) {
      throw new NotFoundError("project", patch.projectId);
    }

    const updated = applyWebhookPatch(existing, patch, this.deps);
    await this.publishWebhook(updated, opts);
    this.webhooks.set(id, updated);
    return cloneWebhook(updated);
  }

  async deleteWebhook(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "deleteWebhook id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    if (!this.webhooks.has(id)) {
      throw new NotFoundError("webhook", id);
    }

    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);

    const deleteTemplate = {
      kind: NOSTR_KIND_DELETE,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_WEBHOOK, pubkey, id)],
        ["k", String(NOSTR_KIND_WEBHOOK)],
      ],
      content: `Deleted webhook ${id}`,
    };

    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(deleteTemplate);
    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);

    this.webhooks.delete(id);
  }

  async recordWebhookTrigger(id: string, opts?: OperationOptions): Promise<Webhook> {
    throwIfAborted(opts?.signal);
    parseOrThrow(IdSchema, id, "recordWebhookTrigger id");
    await this.syncFromRelays(opts);
    throwIfAborted(opts?.signal);

    const existing = this.webhooks.get(id);
    if (!existing) {
      throw new NotFoundError("webhook", id);
    }

    const updated = recordWebhookTriggerEntity(existing, this.deps.clock());
    await this.publishWebhook(updated, opts);
    this.webhooks.set(id, updated);
    return cloneWebhook(updated);
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
    const webhooks = await this.getWebhooks({ projectId: id }, opts);
    const bundle: ProjectBundle = {
      version: BUNDLE_VERSION,
      exportedAt: toTimestamp(this.deps.clock()),
      project: copyProject(project),
      tasks,
      comments: this.commentsOf(tasks.map((t) => t.id)).map(cloneComment),
      ...(webhooks.length > 0 ? { webhooks } : {}),
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
      const cleanTask = withTaskCommentCount(task, 0);
      const taskTemplate = await encodeTaskEvent(cleanTask, pubkey, this.signer);
      throwIfAborted(opts?.signal);
      const signedTask = await this.signer.signEvent(taskTemplate);
      throwIfAborted(opts?.signal);
      await this.relayManager.publishEvent(signedTask);
      this.tasks.set(task.id, cleanTask);
    }

    for (const comment of validated.comments ?? []) {
      throwIfAborted(opts?.signal);
      await this.publishComment(comment, opts);
      this.comments.set(comment.id, cloneComment(comment));
    }

    for (const webhook of validated.webhooks ?? []) {
      throwIfAborted(opts?.signal);
      await this.publishWebhook(webhook, opts);
      this.webhooks.set(webhook.id, cloneWebhook(webhook));
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

  /** Keys of every cached project except `exceptId`. */
  private projectKeys(exceptId?: string): string[] {
    return Array.from(this.projects.values()).flatMap((p) =>
      p.key === undefined || p.id === exceptId ? [] : [p.key],
    );
  }

  private async publishComment(comment: Comment, opts?: OperationOptions): Promise<void> {
    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);
    const template = await encodeCommentEvent(comment, pubkey, this.signer);
    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);
  }

  private async publishWebhook(webhook: Webhook, opts?: OperationOptions): Promise<void> {
    const pubkey = await this.signer.getPublicKey();
    throwIfAborted(opts?.signal);
    const template = await encodeWebhookEvent(webhook, pubkey, this.signer);
    throwIfAborted(opts?.signal);
    const signed = await this.signer.signEvent(template);
    throwIfAborted(opts?.signal);
    await this.relayManager.publishEvent(signed);
  }

  /** Republishes every cached task that depends on one of `removedIds`, without it. */
  private async dropDependencies(removedIds: ReadonlySet<string>, opts?: OperationOptions): Promise<void> {
    if (removedIds.size === 0) return;
    const pubkey = await this.signer.getPublicKey();
    for (const task of Array.from(this.tasks.values())) {
      const next = withoutDependencies(task, removedIds);
      if (next === undefined) continue;
      throwIfAborted(opts?.signal);
      const template = await encodeTaskEvent(next, pubkey, this.signer);
      throwIfAborted(opts?.signal);
      // `updatedAt` stays, so the event would carry the same `created_at` as the one it replaces and
      // could lose the last-write-wins tie-break; one second later always wins.
      const signed = await this.signer.signEvent({ ...template, created_at: template.created_at + 1 });
      throwIfAborted(opts?.signal);
      await this.relayManager.publishEvent(signed);
      this.tasks.set(next.id, next);
    }
  }

  /** Cached comments on any of `taskIds`, oldest first. */
  private commentsOf(taskIds: readonly string[]): Comment[] {
    const ids = new Set(taskIds);
    return Array.from(this.comments.values())
      .filter((c) => ids.has(c.taskId))
      .sort(compareComments);
  }

  private tasksOf(projectId: string): Task[] {
    return Array.from(this.tasks.values()).filter((t) => t.projectId === projectId);
  }

  private withCommentCount(task: Task): Task {
    let count = 0;
    for (const comment of this.comments.values()) {
      if (comment.taskId === task.id) count++;
    }
    return withTaskCommentCount(task, count);
  }
}
