/**
 * Registration of Bitig MCP tools onto an McpServer instance.
 */
import {
  ChecklistSchema,
  CommentAuthorSchema,
  CommentAuthorTypeSchema,
  CommentBodySchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  CreateWebhookInputSchema,
  DueDateSchema,
  IdSchema,
  NeedsHumanSchema,
  NotFoundError,
  ProjectKeySchema,
  ProjectKindSchema,
  ProjectNameSchema,
  ProjectResourcesSchema,
  TaskOrderSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  TaskTitleSchema,
  TASK_ACTOR_MAX,
  WebhookMappingSchema,
  WebhookNameSchema,
  WebhookProviderSchema,
  backfillTicketCodes,
  blockingTasks,
  checkStatusChange,
  findBlockingTasks,
  resolveProjectRef,
  resolveTaskRef,
  withTaskCodes,
  type OperationOptions,
  type StorageProvider,
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
const PROJECT_REF = z.string().min(1).describe("Project ID or project key, e.g. BIT");
const KEY_DESCRIPTION =
  "Project key for ticket codes (BIT in BIT-12): 2-10 letters or digits starting with a letter, unique across projects.";
const WEBHOOK_MAPPING_DESCRIPTION =
  "Optional JSON dot-path mappings from incoming payload fields to task fields, e.g. { title: 'issue.fields.summary', description: 'issue.fields.description', priority: 'issue.fields.priority.name', labels: 'issue.fields.labels' }.";

const GENERIC_USER_AGENTS =
  /^(?:node(?:-fetch)?|undici|mozilla|curl|fetch|okhttp|axios|python-requests|go-http-client)(?:\/|\s|$)/i;

export interface RegisterBitigToolsOptions {
  /**
   * Optional fallback actor name (or getter) when the MCP transport is stateless
   * and `server.server.getClientVersion()` is not populated on the per-request server instance.
   */
  readonly fallbackActor?: string | (() => string | undefined) | undefined;
}

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
  async function assertAgentMayMove(id: string, status: Task["status"], context: string, opts: OperationOptions) {
    await checkStatusChange(storage, id, status, context, { signal: opts.signal, requireApproval: true });
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
        "Create a new project. Returns project details and the .bitig link content to save in the workspace root.",
      inputSchema: {
        name: ProjectNameSchema,
        description: z.string().optional(),
        kind: ProjectKindSchema.optional(),
        resources: ProjectResourcesSchema.optional().describe(RESOURCES_DESCRIPTION),
        key: ProjectKeySchema.optional().describe(`${KEY_DESCRIPTION} Derived from the name when omitted.`),
      },
    },
    async (args, extra) => {
      try {
        const parsed = CreateProjectInputSchema.parse(args);
        const project = await storage.createProject(parsed, { signal: extra.signal });
        const bitigFileContent = serializeProjectLink(project.id);
        return formatSuccessResult({
          ...project,
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
      description: "Update project metadata (name, description, kind, resources, key, archived)",
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
      },
    },
    async (args, extra) => {
      try {
        const { id, ...patch } = args;
        const project = await storage.updateProject(id, patch, { signal: extra.signal });
        return formatSuccessResult(project);
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

  // 6. get_task
  server.registerTool(
    "get_task",
    {
      description: "Get a task by its ID or ticket code (e.g. BIT-12), with its comments oldest first",
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
        const comments = await storage.getComments(id, opts);
        return formatSuccessResult({ ...(await withCode(task, opts)), comments });
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
        "Add a new task to a project. The result's code (e.g. BIT-12) names the task from then on. The task awaits a person's approval and cannot be started or completed until approved.",
      inputSchema: {
        projectId: PROJECT_REF,
        title: TaskTitleSchema,
        description: z.string().optional(),
        status: TaskStatusSchema.optional(),
        isPublic: z.boolean().optional(),
        dueDate: DueDateSchema.optional(),
        priority: TaskPrioritySchema.optional(),
        labels: z.array(z.string()).optional(),
        order: TaskOrderSchema.optional(),
        checklist: ChecklistSchema.optional().describe(CHECKLIST_DESCRIPTION),
        needsHuman: NeedsHumanSchema.optional().describe(NEEDS_HUMAN_DESCRIPTION),
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const projectId = await resolveProjectRef(storage, args.projectId, opts);
        // Not an input: every task an agent creates waits for a person to approve it.
        const parsed = CreateTaskInputSchema.parse({ ...args, projectId, pendingApproval: true });
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
      },
    },
    async (args, extra) => {
      try {
        const actor = resolveMcpActor(server, extra, options?.fallbackActor);
        const opts: OperationOptions = { signal: extra.signal, actor };
        const { id: ref, projectId: projectRef, ...rest } = args;
        const id = await resolveTaskRef(storage, ref, opts);
        if (rest.status !== undefined) await assertAgentMayMove(id, rest.status, "update_task", opts);
        const patch =
          projectRef === undefined ? rest : { ...rest, projectId: await resolveProjectRef(storage, projectRef, opts) };
        const task = await storage.updateTask(id, patch, opts);
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
}
