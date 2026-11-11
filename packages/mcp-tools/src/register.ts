/**
 * Registration of Bitig MCP tools onto an McpServer instance.
 */
import {
  AttachmentNameSchema,
  ChecklistSchema,
  CommentAuthorSchema,
  CommentAuthorTypeSchema,
  CommentBodySchema,
  CreateHostBoundProjectInputSchema,
  CreateTaskInputSchema,
  CreateWebhookInputSchema,
  DueDateSchema,
  HostFolderPathSchema,
  IdSchema,
  NeedsHumanSchema,
  NotFoundError,
  ProjectKeySchema,
  ProjectKindSchema,
  ProjectNameSchema,
  ProjectResourcesSchema,
  SaveCheckpointInputSchema,
  ReportT3GitMetadataInputSchema,
  type ReportT3GitMetadataInput,
  StorageError,
  T3HostIdSchema,
  TaskOrderSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  TaskTitleSchema,
  TASK_ACTOR_MAX,
  UpdateHostBoundProjectInputSchema,
  ValidationError,
  WebhookMappingSchema,
  WebhookNameSchema,
  WebhookProviderSchema,
  backfillTicketCodes,
  buildExecutionContext,
  buildProjectWorkContext,
  buildMentionIndex,
  blockingTasks,
  checkNewTaskStatus,
  checkStatusChange,
  decodeBase64,
  decodeUtf8,
  dependencyLinks,
  encodeBase64,
  findBlockingTasks,
  isTextAttachmentMimeType,
  resolveProjectRef,
  resolveTaskRef,
  resolveTaskRefs,
  selectProjectWork,
  stripAttachmentData,
  T3WorkspaceStrategySchema,
  withTaskCodes,
  type AgentRun,
  type OperationOptions,
  type StorageProvider,
  type T3ProjectMapping,
  type T3WorkspaceStrategy,
  type Task,
  type TaskWithCode,
} from "@bitig/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResult, formatSuccessResult } from "./errors";
import { serializeProjectLink } from "./project-link";

const RESOURCES_DESCRIPTION =
  "Links to outside resources in order, each { type, label, url }. type is repository, issue_tracker, design, documentation or other; url must be http(s). To add, edit or remove a link, send the full edited list.";

const CHECKLIST_DESCRIPTION =
  "Subtasks in order, each { text, done }. To check, rename, reorder, add or remove an item, send the full edited list.";

const NEEDS_HUMAN_DESCRIPTION =
  "Set when the task is blocked on a person: say what you need from them (a decision, an approval, access, an answer). The task then shows as needing a human until it is cleared.";

const TASK_REF = z.string().min(1).describe("Task ID or ticket code, e.g. BIT-12");
const DEPENDS_ON_DESCRIPTION =
  "Tasks this task depends on, as task IDs or ticket codes (e.g. ['BIT-1', 'BIT-2']). It cannot be started or completed until they are done or archived. Set it when breaking work into ordered tasks.";
const PROJECT_REF = z.string().min(1).describe("Project ID or project key, e.g. BIT");
const KEY_DESCRIPTION =
  "Project key for ticket codes (BIT in BIT-12): 2-10 letters or digits starting with a letter, unique across projects.";
const WEBHOOK_MAPPING_DESCRIPTION =
  "Optional JSON dot-path mappings from incoming payload fields to task fields, e.g. { title: 'issue.fields.summary', description: 'issue.fields.description', priority: 'issue.fields.priority.name', labels: 'issue.fields.labels' }.";

const GENERIC_USER_AGENTS =
  /^(?:node(?:-fetch)?|undici|mozilla|curl|fetch|okhttp|axios|python-requests|go-http-client)(?:\/|\s|$)/i;

export interface StartT3ThreadToolInput {
  readonly taskId: string;
  readonly workspaceStrategy?: T3WorkspaceStrategy | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly actor?: string | undefined;
  /** Resolved ID of the umbrella task whose session starts this task as a child session (#BIT-141). */
  readonly parentTaskId?: string | undefined;
}

export interface StartT3ThreadToolResult {
  readonly run: AgentRun;
  readonly task: Task;
  readonly code?: string | undefined;
}

export interface RegisterProjectHostFolderToolInput {
  readonly projectId: string;
  readonly workspaceRoot: string;
  readonly hostId?: string | undefined;
}

export interface RegisterProjectHostFolderToolResult {
  readonly mapping: T3ProjectMapping;
  readonly created: boolean;
}

export interface UnregisterProjectHostFolderToolInput {
  readonly projectId: string;
  readonly force?: boolean | undefined;
}

export interface UnregisterProjectHostFolderToolResult {
  readonly unregistered: boolean;
}

export interface RegisterBitigToolsOptions {
  readonly reportT3GitMetadata?: ((input: ReportT3GitMetadataInput, signal: AbortSignal) => Promise<AgentRun>) | undefined;
  /**
   * Optional fallback actor name (or getter) when the MCP transport is stateless
   * and `server.server.getClientVersion()` is not populated on the per-request server instance.
   */
  readonly fallbackActor?: string | (() => string | undefined) | undefined;
  /**
   * Optional callback to launch a task in a connected T3 Code host.
   */
  readonly startT3Thread?: ((input: StartT3ThreadToolInput) => Promise<StartT3ThreadToolResult>) | undefined;
  /**
   * Optional callback to register an existing folder on a connected T3 Code host and save the
   * host-bound project mapping (#BIT-151).
   */
  readonly registerProjectHostFolder?:
    | ((input: RegisterProjectHostFolderToolInput) => Promise<RegisterProjectHostFolderToolResult>)
    | undefined;
  /**
   * Optional callback to detach a project from its connected T3 Code host without touching host files (#BIT-151).
   */
  readonly unregisterProjectHostFolder?:
    | ((input: UnregisterProjectHostFolderToolInput) => Promise<UnregisterProjectHostFolderToolResult>)
    | undefined;
  /**
   * Optional callback run after `complete_task`, or `update_task` with status `done` or `archived`,
   * e.g. to resume an umbrella task's T3 session waiting on this task (#BIT-141). It must report its
   * own failures rather than throw: the task has already changed by the time it runs.
   */
  readonly onTaskFinished?: ((task: Task) => Promise<void>) | undefined;
  /**
   * Optional lookup returning the umbrella parent task ID recorded on `taskId`'s T3 run (#BIT-141),
   * so a child task that listed its umbrella parent in `dependsOn` is not blocked by that parent
   * while moving to `in_progress` or `done`.
   */
  readonly getUmbrellaParentTaskId?: ((taskId: string) => Promise<string | undefined>) | undefined;
}

/** Statuses after which `onTaskFinished` runs. */
const FINISHED_STATUSES: ReadonlySet<Task["status"]> = new Set<Task["status"]>(["done", "archived"]);

interface McpExtraLike {
  readonly requestInfo?:
    | {
        readonly headers?: Record<string, string | string[] | undefined>;
        readonly url?: URL;
      }
    | undefined;
}

function getHeader(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      const str = Array.isArray(value) ? value[0] : value;
      const trimmed = str?.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

function normalizeActor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, TASK_ACTOR_MAX);
}

export function resolveMcpActor(
  server: McpServer,
  extra?: McpExtraLike,
  fallbackActor?: string | (() => string | undefined),
): string {
  const headers = extra?.requestInfo?.headers;
  const headerActor =
    getHeader(headers, "x-bitig-agent") ??
    getHeader(headers, "x-agent-name") ??
    getHeader(headers, "x-mcp-client-name") ??
    extra?.requestInfo?.url?.searchParams.get("agent") ??
    undefined;
  const normalizedHeader = normalizeActor(headerActor);
  if (normalizedHeader) return normalizedHeader;

  const clientName = normalizeActor(server.server.getClientVersion()?.name);
  if (clientName) return clientName;

  const resolvedFallback = normalizeActor(
    typeof fallbackActor === "function" ? fallbackActor() : fallbackActor,
  );
  if (resolvedFallback) return resolvedFallback;

  const userAgent = getHeader(headers, "user-agent");
  if (userAgent && !GENERIC_USER_AGENTS.test(userAgent)) {
    const token = userAgent.split(/\s+/)[0]?.split("/")[0];
    const normalizedUa = normalizeActor(token);
    if (normalizedUa) return normalizedUa;
  }

  return "mcp";
}

export function registerBitigTools(
  server: McpServer,
  storage: StorageProvider,
  options?: RegisterBitigToolsOptions,
): void {
  /**
   * The task with its ticket code (`code`), which callers can pass wherever a task ID is accepted,
   * and the codes of the unfinished tasks it waits on (`blockedBy`) when there are any.
   */
  async function withCode(task: Task, opts: OperationOptions): Promise<TaskWithCode & { blockedBy?: string[] }> {
    const project = await storage.getProject(task.projectId, opts);
    const coded = withTaskCodes([task], project === null ? [] : [project])[0] ?? task;
    const blockedBy = (await findBlockingTasks(storage, task, opts)).map((t) => t.code ?? t.id);
    return blockedBy.length > 0 ? { ...coded, blockedBy } : coded;
  }

  /**
   * Refuses to start or complete a task a person has not approved yet, or one whose dependencies
   * are unfinished. Agents can neither approve nor override over MCP; an unknown ID falls through
   * so storage reports it as not found.
   */
  async function assertAgentMayMove(
    id: string,
    status: Task["status"],
    context: string,
    opts: OperationOptions,
    dependsOn?: readonly string[] | null,
  ) {
    let effectiveDependsOn = dependsOn;
    const parentTaskId = await options?.getUmbrellaParentTaskId?.(id);
    if (parentTaskId) {
      if (effectiveDependsOn !== undefined) {
        effectiveDependsOn = effectiveDependsOn
          ? effectiveDependsOn.filter((depId) => depId !== parentTaskId)
          : effectiveDependsOn;
      } else {
        const task = await storage.getTask(id, opts);
        if (task?.dependsOn?.includes(parentTaskId)) {
          effectiveDependsOn = task.dependsOn.filter((depId) => depId !== parentTaskId);
        }
      }
    }
    await checkStatusChange(storage, id, status, context, {
      signal: opts.signal,
      requireApproval: true,
      dependsOn: effectiveDependsOn,
    });
  }

  // 1. list_projects
  server.registerTool(
    "list_projects",
    {
      description: "List projects in Bitig storage, optionally filtered by archived status",
      inputSchema: {
        archived: z
          .boolean()
          .optional()
          .describe("false lists only active projects, true lists only archived projects; omit for all"),
      },
      annotations: { readOnlyHint: true },
    },
    async (args, extra) => {
      try {
        const projects = await storage.getProjects({ signal: extra.signal });
        const matching =
          args.archived === undefined
            ? projects
            : projects.filter((project) => (project.archived === true) === args.archived);
        return formatSuccessResult(matching);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 2. create_project
  server.registerTool(
    "create_project",
    {
      description:
        "Create a new project, optionally bound to an existing folder on a selected T3 Code host. Returns project details and the .bitig link content to save in the workspace root.",
      inputSchema: {
        name: ProjectNameSchema,
        description: z.string().optional(),
        kind: ProjectKindSchema.optional(),
        resources: ProjectResourcesSchema.optional().describe(RESOURCES_DESCRIPTION),
        key: ProjectKeySchema.optional().describe(`${KEY_DESCRIPTION} Derived from the name when omitted.`),
        hostId: T3HostIdSchema.optional().describe(
          "Optional ID of the connected T3 Code host to bind the project to when workspaceRoot is provided.",
        ),
        workspaceRoot: HostFolderPathSchema.optional().describe(
          "Existing folder path on the selected T3 host (e.g. /var/www/my-project or ~/www/my-project) to register and link.",
        ),
      },
    },
    async (args, extra) => {
      try {
        const parsed = CreateHostBoundProjectInputSchema.parse(args);
        const { hostId, workspaceRoot, ...projectInput } = parsed;
        if (workspaceRoot !== undefined && !options?.registerProjectHostFolder) {
          throw new Error(
            "T3 host folder registration is not available on this MCP server",
          );
        }
        const project = await storage.createProject(projectInput, { signal: extra.signal });
        let registered: RegisterProjectHostFolderToolResult | undefined;
        if (workspaceRoot !== undefined && options?.registerProjectHostFolder) {
          try {
            registered = await options.registerProjectHostFolder({
              projectId: project.id,
              workspaceRoot,
              hostId,
            });
          } catch (err) {
            await storage.deleteProject(project.id, { signal: extra.signal }).catch(() => undefined);
            throw err;
          }
        }
        const bitigFileContent = serializeProjectLink(project.id);
        return formatSuccessResult({
          ...project,
          ...(registered ? { mapping: registered.mapping, created: registered.created } : {}),
          bitig_file_content: bitigFileContent,
          instructions: "Save bitig_file_content into a '.bitig' file in your project workspace root.",
        });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 3. update_project
  server.registerTool(
    "update_project",
    {
      description:
        "Update project metadata (name, description, kind, resources, key, archived), or attach/reattach/detach a T3 host folder (workspaceRoot, hostId, force)",
      inputSchema: {
        id: IdSchema,
        name: ProjectNameSchema.optional(),
        description: z.string().optional(),
        kind: ProjectKindSchema.optional(),
        resources: ProjectResourcesSchema.nullable()
          .optional()
          .describe(`${RESOURCES_DESCRIPTION} Replaces the whole list; null or [] removes it.`),
        key: ProjectKeySchema.optional().describe(
          `${KEY_DESCRIPTION} Changing it changes every task's code in the project.`,
        ),
        archived: z
          .boolean()
          .nullable()
          .optional()
          .describe("true archives the project; false or null recovers/unarchives it."),
        hostId: T3HostIdSchema.nullable()
          .optional()
          .describe(
            "Selected T3 host ID when attaching or reattaching workspaceRoot, or null to detach the project from its host.",
          ),
        workspaceRoot: HostFolderPathSchema.nullable()
          .optional()
          .describe(
            "Existing folder path on the selected T3 host to attach/reattach, or null to detach the project from its host without touching host files.",
          ),
        force: z
          .boolean()
          .optional()
          .describe(
            "Pass true when detaching (workspaceRoot: null) to forward force=true to t3_project_delete once Bitig verifies no sessions are active.",
          ),
      },
    },
    async (args, extra) => {
      try {
        const { id, ...rawPatch } = args;
        const parsed = UpdateHostBoundProjectInputSchema.parse(rawPatch);
        const { hostId, workspaceRoot, force, ...projectPatch } = parsed;
        if (workspaceRoot === undefined && hostId === undefined) {
          const project = await storage.updateProject(id, projectPatch, { signal: extra.signal });
          return formatSuccessResult(project);
        }
        const hasProjectPatch = Object.values(projectPatch).some((value) => value !== undefined);
        if (workspaceRoot === null || workspaceRoot === undefined) {
          if (!options?.unregisterProjectHostFolder) {
            throw new Error(
              "T3 host folder registration is not available on this MCP server",
            );
          }
          const detached = await options.unregisterProjectHostFolder({ projectId: id, force });
          const project = hasProjectPatch
            ? await storage.updateProject(id, projectPatch, { signal: extra.signal })
            : await storage.getProject(id, { signal: extra.signal });
          if (!project) {
            throw new NotFoundError("project", id);
          }
          return formatSuccessResult({
            ...project,
            mapping: null,
            unregistered: detached.unregistered,
          });
        }
        if (!options?.registerProjectHostFolder) {
          throw new Error(
            "T3 host folder registration is not available on this MCP server",
          );
        }
        const attached = await options.registerProjectHostFolder({
          projectId: id,
          workspaceRoot,
          hostId: hostId ?? undefined,
        });
        const project = hasProjectPatch
          ? await storage.updateProject(id, projectPatch, { signal: extra.signal })
          : await storage.getProject(id, { signal: extra.signal });
        if (!project) {
          throw new NotFoundError("project", id);
        }
        return formatSuccessResult({
          ...project,
          mapping: attached.mapping,
          created: attached.created,
        });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 4. delete_project
  server.registerTool(
    "delete_project",
    {
      description: "Permanently delete a project and all its tasks",
      annotations: { destructiveHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        await storage.deleteProject(args.id, { signal: extra.signal });
        return formatSuccessResult({ success: true, deletedProjectId: args.id });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 5. list_tasks
  server.registerTool(
    "list_tasks",
    {
      description:
        "List tasks with their ticket codes, optionally filtered by project ID or key, to the tasks that need a human, to the tasks awaiting approval, or to blocked tasks. A blocked task lists the codes of its unfinished dependencies in blockedBy and cannot be started or completed until they are done or archived.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        projectId: PROJECT_REF.optional(),
        needsHuman: z
          .boolean()
          .optional()
          .describe("true lists only tasks waiting on a person, false only tasks that are not"),
        pendingApproval: z
          .boolean()
          .optional()
          .describe("true lists only tasks awaiting a person's approval, false only approved tasks"),
        blocked: z
          .boolean()
          .optional()
          .describe("true lists only tasks waiting on unfinished dependencies, false only tasks that are not"),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const projectId =
          args.projectId === undefined ? undefined : await resolveProjectRef(storage, args.projectId, opts);
        // Every task, since a dependency can live in another project.
        const all = withTaskCodes(await storage.getTasks(undefined, opts), await storage.getProjects(opts));
        const byId = new Map(all.map((task) => [task.id, task]));
        const listed = all
          .filter((task) => projectId === undefined || task.projectId === projectId)
          .map((task) => {
            const blockedBy = blockingTasks(task, byId).map((t) => t.code ?? t.id);
            return blockedBy.length > 0 ? { ...task, blockedBy } : task;
          });
        const matching = listed.filter(
          (task) =>
            (args.needsHuman === undefined || (task.needsHuman !== undefined) === args.needsHuman) &&
            (args.pendingApproval === undefined || (task.pendingApproval === true) === args.pendingApproval) &&
            (args.blocked === undefined || ("blockedBy" in task) === args.blocked),
        );
        return formatSuccessResult(matching);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  server.registerTool(
    "next_task",
    {
      description:
        "Pick up project work without listing its history. Returns up to three in-progress tasks (latest touch first), three actionable todo tasks (canonical order), overlapping live gate counts, and bounded description, checklist, recent comments and latest checkpoint for the primary ungated task. Archived projects have no actionable work. Text ending in … and omitted counts indicate truncation; use get_task or resume_from_checkpoint for full context. A checkpoint never overrides approval, dependencies or needsHuman.",
      annotations: { readOnlyHint: true },
      inputSchema: { projectId: PROJECT_REF },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const projectId = await resolveProjectRef(storage, args.projectId, opts);
        const project = await storage.getProject(projectId, opts);
        if (project === null) throw new NotFoundError("project", args.projectId);
        const tasks = await storage.getTasks(undefined, opts);
        const summary = selectProjectWork(project, tasks);
        const primary = tasks.find((task) => task.id === summary.primary?.id);
        if (primary === undefined) return formatSuccessResult({ ...summary, context: null });
        const [checkpoints, comments] = await Promise.all([
          storage.getCheckpoints(primary.id, opts),
          storage.getComments(primary.id, opts),
        ]);
        return formatSuccessResult({ ...summary, context: buildProjectWorkContext(primary, checkpoints, comments) });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 6. get_task
  server.registerTool(
    "get_task",
    {
      description:
        "Get a task by its ID or ticket code (e.g. BIT-12), with its comments and attachments oldest first, the tasks it mentions (#BIT-12 in its description, subtasks or comments) as mentions, the tasks that mention it as mentionedIn, the tasks it depends on as dependsOn, the tasks that depend on it as dependents, and the unfinished ones it waits on as blockedBy",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const id = await resolveTaskRef(storage, args.id, opts);
        const task = await storage.getTask(id, opts);
        if (task === null) throw new NotFoundError("task", args.id);
        const [comments, attachments, tasks, projects] = await Promise.all([
          storage.getComments(id, opts),
          storage.getAttachments(id, opts).catch((err: unknown) => {
            if (err instanceof StorageError && err.reason === "unsupported") return [];
            throw err;
          }),
          storage.getTasks(undefined, opts),
          storage.getProjects(opts),
        ]);
        const links = buildMentionIndex(tasks, projects).linksFor(task, comments);
        const dependencies = dependencyLinks(task, tasks, projects);
        return formatSuccessResult({
          ...(await withCode(task, opts)),
          comments,
          attachments,
          ...links,
          ...dependencies,
        });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 7. add_task
  server.registerTool(
    "add_task",
    {
      description:
        "Add a new task to a project in Backlog (status todo, awaiting approval). The result's code (e.g. BIT-12) names the task from then on. The task cannot be started or completed until a person approves it, nor while any task in dependsOn is unfinished.",
      inputSchema: {
        projectId: PROJECT_REF,
        title: TaskTitleSchema,
        description: z.string().optional(),
        status: z.literal("todo").optional(),
        isPublic: z.boolean().optional(),
        dueDate: DueDateSchema.optional(),
        priority: TaskPrioritySchema.optional(),
        labels: z.array(z.string()).optional(),
        order: TaskOrderSchema.optional(),
        checklist: ChecklistSchema.optional().describe(CHECKLIST_DESCRIPTION),
        needsHuman: NeedsHumanSchema.optional().describe(NEEDS_HUMAN_DESCRIPTION),
        dependsOn: z.array(TASK_REF).optional().describe(DEPENDS_ON_DESCRIPTION),
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const { dependsOn: dependencyRefs, ...rest } = args;
        const projectId = await resolveProjectRef(storage, rest.projectId, opts);
        const dependsOn = dependencyRefs === undefined ? [] : await resolveTaskRefs(storage, dependencyRefs, opts);
        await checkNewTaskStatus(storage, { status: rest.status, dependsOn }, "add_task", opts);
        // Not an input: every task an agent creates waits for a person to approve it.
        const parsed = CreateTaskInputSchema.parse({
          ...rest,
          projectId,
          status: "todo",
          pendingApproval: true,
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
        });
        const task = await storage.saveTask(parsed, opts);
        return formatSuccessResult(await withCode(task, opts));
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 8. update_task
  server.registerTool(
    "update_task",
    {
      description:
        "Update task fields (set null to clear optional fields). Moving a task to another project gives it a new code there. Moving it to in_progress or done is refused while it awaits approval or any task it depends on is unfinished.",
      inputSchema: {
        id: TASK_REF,
        projectId: PROJECT_REF.optional(),
        title: TaskTitleSchema.optional(),
        description: z.string().optional(),
        status: TaskStatusSchema.optional(),
        isPublic: z.boolean().optional(),
        dueDate: DueDateSchema.nullable().optional(),
        priority: TaskPrioritySchema.nullable().optional(),
        labels: z.array(z.string()).nullable().optional(),
        order: TaskOrderSchema.nullable().optional(),
        checklist: ChecklistSchema.nullable()
          .optional()
          .describe(`${CHECKLIST_DESCRIPTION} Replaces the whole list; null or [] removes it.`),
        needsHuman: NeedsHumanSchema.nullable()
          .optional()
          .describe(
            `${NEEDS_HUMAN_DESCRIPTION} null clears it when resolved manually or when a person's comment explicitly states it is resolved.`,
          ),
        dependsOn: z
          .array(TASK_REF)
          .nullable()
          .optional()
          .describe(`${DEPENDS_ON_DESCRIPTION} Replaces the whole list; null or [] removes it.`),
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const { id: ref, projectId: projectRef, dependsOn: dependencyRefs, ...rest } = args;
        const id = await resolveTaskRef(storage, ref, opts);
        const resolved = dependencyRefs ? await resolveTaskRefs(storage, dependencyRefs, opts) : undefined;
        // An empty list clears dependencies, as null does.
        const dependsOn = dependencyRefs === null || resolved?.length === 0 ? null : resolved;
        if (rest.status !== undefined) await assertAgentMayMove(id, rest.status, "update_task", opts, dependsOn);
        const fields = dependsOn === undefined ? rest : { ...rest, dependsOn };
        const patch =
          projectRef === undefined ? fields : { ...fields, projectId: await resolveProjectRef(storage, projectRef, opts) };
        const task = await storage.updateTask(id, patch, opts);
        if (rest.status !== undefined && FINISHED_STATUSES.has(rest.status)) await options?.onTaskFinished?.(task);
        return formatSuccessResult(await withCode(task, opts));
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 9. complete_task
  server.registerTool(
    "complete_task",
    {
      description:
        "Mark a task as completed/done (idempotent). Refused while the task awaits approval or any task it depends on is unfinished.",
      annotations: { idempotentHint: true },
      inputSchema: {
        id: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const id = await resolveTaskRef(storage, args.id, opts);
        await assertAgentMayMove(id, "done", "complete_task", opts);
        const task = await storage.completeTask(id, opts);
        await options?.onTaskFinished?.(task);
        return formatSuccessResult(await withCode(task, opts));
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 10. delete_task
  server.registerTool(
    "delete_task",
    {
      description: "Permanently delete a task by ID or ticket code",
      annotations: { destructiveHint: true },
      inputSchema: {
        id: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const id = await resolveTaskRef(storage, args.id, opts);
        await storage.deleteTask(id, opts);
        return formatSuccessResult({ success: true, deletedTaskId: id });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 11. backfill_ticket_codes
  server.registerTool(
    "backfill_ticket_codes",
    {
      description:
        "Give projects created before ticket codes a key and number their tasks, oldest first. Safe to run again; existing codes never change.",
      annotations: { idempotentHint: true },
      inputSchema: {},
    },
    async (_args, extra) => {
      try {
        const result = await backfillTicketCodes(storage, { signal: extra.signal });
        return formatSuccessResult({ keyedProjects: result.projects, numberedTasks: result.tasks });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 12. list_comments
  server.registerTool(
    "list_comments",
    {
      description: "List a task's comments, oldest first",
      annotations: { readOnlyHint: true },
      inputSchema: {
        taskId: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const taskId = await resolveTaskRef(storage, args.taskId, opts);
        return formatSuccessResult(await storage.getComments(taskId, opts));
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 13. add_comment
  server.registerTool(
    "add_comment",
    {
      description:
        "Add a Markdown comment to a task: context worth keeping for later, a decision, or a question for a person. People answer with comments too.",
      inputSchema: {
        taskId: TASK_REF,
        body: CommentBodySchema,
        author: CommentAuthorSchema.optional().describe("Your name, e.g. claude"),
        authorType: CommentAuthorTypeSchema.optional().describe(
          "agent (the default) or human, when relaying a person's own words",
        ),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const taskId = await resolveTaskRef(storage, args.taskId, opts);
        const comment = await storage.addComment({ ...args, taskId, authorType: args.authorType ?? "agent" }, opts);
        return formatSuccessResult(comment);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 13a. save_checkpoint
  server.registerTool(
    "save_checkpoint",
    {
      description:
        "Save where you are on a task so work can resume after an interruption. One checkpoint per stepIndex: saving a step again overwrites it. It records progress only and never changes the task's status, approval or needsHuman state. Replies with a short confirmation, not the stored snapshot.",
      annotations: { idempotentHint: true },
      inputSchema: {
        ...SaveCheckpointInputSchema.shape,
        taskId: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const taskId = await resolveTaskRef(storage, args.taskId, opts);
        const checkpoint = await storage.saveCheckpoint({ ...args, taskId }, opts);
        return formatSuccessResult({
          success: true,
          taskId: args.taskId,
          checkpointId: checkpoint.id,
          stepIndex: checkpoint.stepIndex,
          status: checkpoint.status,
        });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 13b. resume_from_checkpoint
  server.registerTool(
    "resume_from_checkpoint",
    {
      description:
        "Get what you need to continue a task: its goal, checklist, current approval/needsHuman/dependency gates, a bounded recent history of earlier steps, and the checkpoint to resume from (the latest step, or the given stepIndex). Gates come from live task state, not from the saved snapshot, so check them before acting: you may not start work a person has not approved or that is blocked.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        taskId: TASK_REF,
        stepIndex: SaveCheckpointInputSchema.shape.stepIndex.optional().describe("Resume from this step instead of the latest"),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const id = await resolveTaskRef(storage, args.taskId, opts);
        const task = await storage.getTask(id, opts);
        if (task === null) throw new NotFoundError("task", args.taskId);
        const [checkpoints, dependencies] = await Promise.all([
          storage.getCheckpoints(id, opts),
          Promise.all((task.dependsOn ?? []).map((dependencyId) => storage.getTask(dependencyId, opts))),
        ]);
        const context = buildExecutionContext(
          task,
          checkpoints,
          dependencies.filter((dependency): dependency is Task => dependency !== null),
          args.stepIndex,
        );
        return formatSuccessResult({ ...context, task: { ...context.task, code: (await withCode(task, opts)).code } });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 14. delete_comment
  server.registerTool(
    "delete_comment",
    {
      description: "Permanently delete a comment by its ID",
      annotations: { destructiveHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        await storage.deleteComment(args.id, { signal: extra.signal });
        return formatSuccessResult({ success: true, deletedCommentId: args.id });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 14a. list_attachments
  server.registerTool(
    "list_attachments",
    {
      description: "List a task's file attachments (metadata only), oldest first",
      annotations: { readOnlyHint: true },
      inputSchema: {
        taskId: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const taskId = await resolveTaskRef(storage, args.taskId, opts);
        return formatSuccessResult(await storage.getAttachments(taskId, opts));
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 14b. get_attachment
  server.registerTool(
    "get_attachment",
    {
      description:
        "Get a file attachment by ID. Returns decoded UTF-8 text in `content` for Markdown/text files (`.md`, `.txt`, `.json`, `.csv`, `.yaml`, `.xml`) and base64-encoded bytes in `data` plus `downloadUrl` for images and binary files.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const attachment = await storage.getAttachment(args.id, opts);
        if (attachment === null) throw new NotFoundError("attachment", args.id);
        const meta = stripAttachmentData(attachment);
        if (isTextAttachmentMimeType(meta.mimeType)) {
          return formatSuccessResult({
            ...meta,
            content: decodeUtf8(attachment.data),
          });
        }
        return formatSuccessResult({
          ...meta,
          data: encodeBase64(attachment.data),
          downloadUrl: `/api/attachments/${meta.id}`,
        });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 14c. add_attachment
  server.registerTool(
    "add_attachment",
    {
      description:
        "Attach a file (Markdown, plain text, JSON, CSV, YAML, XML, PDF, image, or archive) to a task. Pass UTF-8 text in `content` for Markdown/text files, or base64-encoded bytes in `data` for binary files.",
      inputSchema: {
        taskId: TASK_REF,
        name: AttachmentNameSchema.describe("File name with extension, e.g. 'spec.md' or 'screenshot.png'"),
        mimeType: z
          .string()
          .optional()
          .describe("Optional MIME type (inferred from file extension when omitted)"),
        content: z.string().optional().describe("UTF-8 text content for Markdown or text attachments"),
        data: z.string().optional().describe("Base64-encoded file bytes for binary or image attachments"),
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const taskId = await resolveTaskRef(storage, args.taskId, opts);
        let payload: Uint8Array | string;
        if (args.content !== undefined) {
          payload = args.content;
        } else if (args.data !== undefined) {
          payload = decodeBase64(args.data, "add_attachment");
        } else {
          throw new ValidationError("add_attachment", [
            { code: "custom", path: ["content"], message: "Provide either content (text) or data (base64)", input: undefined },
          ]);
        }
        const attachment = await storage.addAttachment(
          {
            taskId,
            name: args.name,
            ...(args.mimeType !== undefined ? { mimeType: args.mimeType } : {}),
            data: payload,
          },
          opts,
        );
        return formatSuccessResult(attachment);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 14d. delete_attachment
  server.registerTool(
    "delete_attachment",
    {
      description: "Permanently delete a file attachment by its ID",
      annotations: { destructiveHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        await storage.deleteAttachment(args.id, { signal: extra.signal });
        return formatSuccessResult({ success: true, deletedAttachmentId: args.id });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 15. list_webhooks
  server.registerTool(
    "list_webhooks",
    {
      description: "List incoming webhooks, optionally filtered by project ID or key",
      annotations: { readOnlyHint: true },
      inputSchema: {
        projectId: PROJECT_REF.optional(),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const projectId =
          args.projectId === undefined ? undefined : await resolveProjectRef(storage, args.projectId, opts);
        return formatSuccessResult(
          await storage.getWebhooks(projectId === undefined ? undefined : { projectId }, opts),
        );
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 16. create_webhook
  server.registerTool(
    "create_webhook",
    {
      description:
        "Create an incoming webhook endpoint for a project. Returns the webhook including its secret token for POST /webhooks/<token>.",
      inputSchema: {
        projectId: PROJECT_REF,
        name: WebhookNameSchema,
        provider: WebhookProviderSchema.optional().describe("generic (default), sentry, jira, or github"),
        enabled: z.boolean().optional(),
        mapping: WebhookMappingSchema.optional().describe(WEBHOOK_MAPPING_DESCRIPTION),
        defaultPriority: TaskPrioritySchema.optional(),
        defaultLabels: z.array(z.string()).optional(),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const projectId = await resolveProjectRef(storage, args.projectId, opts);
        const parsed = CreateWebhookInputSchema.parse({ ...args, projectId });
        const webhook = await storage.createWebhook(parsed, opts);
        return formatSuccessResult(webhook);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 17. update_webhook
  server.registerTool(
    "update_webhook",
    {
      description:
        "Update a webhook's configuration, field mapping, enabled state, or rotate its secret token (regenerateToken: true)",
      inputSchema: {
        id: IdSchema,
        projectId: PROJECT_REF.optional(),
        name: WebhookNameSchema.optional(),
        provider: WebhookProviderSchema.optional(),
        enabled: z.boolean().optional(),
        mapping: WebhookMappingSchema.nullable().optional().describe(WEBHOOK_MAPPING_DESCRIPTION),
        defaultPriority: TaskPrioritySchema.nullable().optional(),
        defaultLabels: z.array(z.string()).nullable().optional(),
        regenerateToken: z.boolean().optional().describe("Set true to rotate the secret token"),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const { id, projectId: projectRef, ...rest } = args;
        const patch =
          projectRef === undefined ? rest : { ...rest, projectId: await resolveProjectRef(storage, projectRef, opts) };
        const webhook = await storage.updateWebhook(id, patch, opts);
        return formatSuccessResult(webhook);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 18. delete_webhook
  server.registerTool(
    "delete_webhook",
    {
      description: "Permanently delete a webhook by its ID",
      annotations: { destructiveHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        await storage.deleteWebhook(args.id, { signal: extra.signal });
        return formatSuccessResult({ success: true, deletedWebhookId: args.id });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 19. start_t3_thread
  server.registerTool(
    "report_t3_git_metadata",
    {
      description: "Record Git metadata for the current task run. Pass your T3 thread ID (and the run ID from the launch instructions when known). Omitted fields preserve saved values; null clears a field and [] clears PR links. Diff counts are tracked changes in the working tree or latest task commit, excluding untracked files. Never guess metadata.",
      inputSchema: ReportT3GitMetadataInputSchema.shape,
    },
    async (args, extra) => {
      try {
        const taskId = await resolveTaskRef(storage, args.taskId, { signal: extra.signal });
        if (!await storage.getTask(taskId, { signal: extra.signal })) throw new NotFoundError("task", taskId);
        if (!options?.reportT3GitMetadata) throw new Error("T3 metadata reporting is not configured on this server");
        const run = await options.reportT3GitMetadata({ ...args, taskId }, extra.signal);
        return formatSuccessResult({ run });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  server.registerTool(
    "start_t3_thread",
    {
      description:
        "Launch a T3 Code thread for a task on the connected T3 host. Refused if the task has pendingApproval: true, has unfinished dependencies in dependsOn, belongs to an unmapped project, or if no T3 host is connected. Moves the task to in_progress and records the T3 thread link. From an umbrella task's T3 session, pass parentTaskId to start one related task as a child session: the umbrella session then waits (waiting_subagent), so end your turn; Bitig resumes it with the child's completion context when the child task is done, or tells it when the child session fails or stops. Checklist items are steps of a task, never child sessions.",
      inputSchema: {
        taskId: TASK_REF,
        parentTaskId: TASK_REF.optional().describe(
          "Umbrella task whose T3 session starts this task as a child session, as a task ID or ticket code, e.g. TAS-1. It must have a T3 session and not already wait on another unfinished child task. A dependency of taskId on it does not block the launch.",
        ),
        workspaceStrategy: T3WorkspaceStrategySchema.optional().describe(
          "Workspace strategy: 'worktree' (default, isolated git worktree on HEAD) or 'root'",
        ),
        providerInstanceId: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional T3 provider instance ID"),
        model: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe("Optional model slug to run in T3"),
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const taskId = await resolveTaskRef(storage, args.taskId, opts);
        const parentTaskId =
          args.parentTaskId === undefined ? undefined : await resolveTaskRef(storage, args.parentTaskId, opts);
        // The umbrella task is in progress while it delegates, so a dependency on it does not block its child.
        const task = parentTaskId === undefined ? null : await storage.getTask(taskId, opts);
        const dependsOn = task ? (task.dependsOn ?? []).filter((id) => id !== parentTaskId) : undefined;
        await checkStatusChange(storage, taskId, "in_progress", "start_t3_thread", {
          signal: opts.signal,
          ...(dependsOn ? { dependsOn } : {}),
        });
        if (!options?.startT3Thread) {
          throw new ValidationError("start_t3_thread", [
            {
              code: "custom",
              path: ["t3Connection"],
              message: "T3 integration is not configured on this server",
              input: args.taskId,
            },
          ]);
        }
        const result = await options.startT3Thread({
          taskId,
          workspaceStrategy: args.workspaceStrategy,
          providerInstanceId: args.providerInstanceId,
          model: args.model,
          actor,
          ...(parentTaskId ? { parentTaskId } : {}),
        });
        return formatSuccessResult({
          run: result.run,
          task: await withCode(result.task, opts),
        });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );
}
