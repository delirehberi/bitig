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
  backfillTicketCodes,
  resolveProjectRef,
  resolveTaskRef,
  withTaskCodes,
  type OperationOptions,
  type StorageProvider,
  type Task,
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

export function registerBitigTools(server: McpServer, storage: StorageProvider): void {
  /** The task with its ticket code (`code`), which callers can pass wherever a task ID is accepted. */
  async function withCode(task: Task, opts: OperationOptions) {
    const project = await storage.getProject(task.projectId, opts);
    return withTaskCodes([task], project === null ? [] : [project])[0] ?? task;
  }

  // 1. list_projects
  server.registerTool(
    "list_projects",
    {
      description: "List all projects in Bitig storage",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async (_args, extra) => {
      try {
        const projects = await storage.getProjects({ signal: extra.signal });
        return formatSuccessResult(projects);
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
      description: "Update project metadata (name, description, kind, resources, key)",
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
        "List tasks with their ticket codes, optionally filtered by project ID or key, or to the tasks that need a human",
      annotations: { readOnlyHint: true },
      inputSchema: {
        projectId: PROJECT_REF.optional(),
        needsHuman: z
          .boolean()
          .optional()
          .describe("true lists only tasks waiting on a person, false only tasks that are not"),
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const projectId =
          args.projectId === undefined ? undefined : await resolveProjectRef(storage, args.projectId, opts);
        const tasks = await storage.getTasks(projectId === undefined ? undefined : { projectId }, opts);
        const matching =
          args.needsHuman === undefined
            ? tasks
            : tasks.filter((task) => (task.needsHuman !== undefined) === args.needsHuman);
        return formatSuccessResult(withTaskCodes(matching, await storage.getProjects(opts)));
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
      description: "Add a new task to a project. The result's code (e.g. BIT-12) names the task from then on.",
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
        const opts = { signal: extra.signal };
        const projectId = await resolveProjectRef(storage, args.projectId, opts);
        const parsed = CreateTaskInputSchema.parse({ ...args, projectId });
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
        "Update task fields (set null to clear optional fields). Moving a task to another project gives it a new code there.",
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
        const opts = { signal: extra.signal };
        const { id: ref, projectId: projectRef, ...rest } = args;
        const id = await resolveTaskRef(storage, ref, opts);
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
      description: "Mark a task as completed/done (idempotent)",
      annotations: { idempotentHint: true },
      inputSchema: {
        id: TASK_REF,
      },
    },
    async (args, extra) => {
      try {
        const opts = { signal: extra.signal };
        const task = await storage.completeTask(await resolveTaskRef(storage, args.id, opts), opts);
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
}
