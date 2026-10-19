/**
 * Registration of Bitig MCP tools onto an McpServer instance.
 */
import {
  ChecklistSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  DueDateSchema,
  IdSchema,
  NotFoundError,
  ProjectKindSchema,
  ProjectNameSchema,
  ProjectResourcesSchema,
  TaskOrderSchema,
  TaskPrioritySchema,
  TaskStatusSchema,
  TaskTitleSchema,
  type StorageProvider,
} from "@bitig/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { formatErrorResult, formatSuccessResult } from "./errors";
import { serializeProjectLink } from "./project-link";

const RESOURCES_DESCRIPTION =
  "Links to outside resources in order, each { type, label, url }. type is repository, issue_tracker, design, documentation or other; url must be http(s). To add, edit or remove a link, send the full edited list.";

const CHECKLIST_DESCRIPTION =
  "Subtasks in order, each { text, done }. To check, rename, reorder, add or remove an item, send the full edited list.";

export function registerBitigTools(server: McpServer, storage: StorageProvider): void {
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
      description: "Update project metadata (name, description, kind, resources)",
      inputSchema: {
        id: IdSchema,
        name: ProjectNameSchema.optional(),
        description: z.string().optional(),
        kind: ProjectKindSchema.optional(),
        resources: ProjectResourcesSchema.nullable()
          .optional()
          .describe(`${RESOURCES_DESCRIPTION} Replaces the whole list; null or [] removes it.`),
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
      description: "List tasks, optionally filtered by project ID",
      annotations: { readOnlyHint: true },
      inputSchema: {
        projectId: IdSchema.optional(),
      },
    },
    async (args, extra) => {
      try {
        const tasks = await storage.getTasks(args.projectId !== undefined ? { projectId: args.projectId } : undefined, {
          signal: extra.signal,
        });
        return formatSuccessResult(tasks);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 6. get_task
  server.registerTool(
    "get_task",
    {
      description: "Get a task by its unique ID",
      annotations: { readOnlyHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        const task = await storage.getTask(args.id, { signal: extra.signal });
        if (task === null) throw new NotFoundError("task", args.id);
        return formatSuccessResult(task);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 7. add_task
  server.registerTool(
    "add_task",
    {
      description: "Add a new task to a project",
      inputSchema: {
        projectId: IdSchema,
        title: TaskTitleSchema,
        description: z.string().optional(),
        status: TaskStatusSchema.optional(),
        isPublic: z.boolean().optional(),
        dueDate: DueDateSchema.optional(),
        priority: TaskPrioritySchema.optional(),
        labels: z.array(z.string()).optional(),
        order: TaskOrderSchema.optional(),
        checklist: ChecklistSchema.optional().describe(CHECKLIST_DESCRIPTION),
      },
    },
    async (args, extra) => {
      try {
        const parsed = CreateTaskInputSchema.parse(args);
        const task = await storage.saveTask(parsed, { signal: extra.signal });
        return formatSuccessResult(task);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 8. update_task
  server.registerTool(
    "update_task",
    {
      description: "Update task fields (set null to clear optional fields)",
      inputSchema: {
        id: IdSchema,
        projectId: IdSchema.optional(),
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
      },
    },
    async (args, extra) => {
      try {
        const { id, ...patch } = args;
        const task = await storage.updateTask(id, patch, { signal: extra.signal });
        return formatSuccessResult(task);
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
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        const task = await storage.completeTask(args.id, { signal: extra.signal });
        return formatSuccessResult(task);
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );

  // 10. delete_task
  server.registerTool(
    "delete_task",
    {
      description: "Permanently delete a task by ID",
      annotations: { destructiveHint: true },
      inputSchema: {
        id: IdSchema,
      },
    },
    async (args, extra) => {
      try {
        await storage.deleteTask(args.id, { signal: extra.signal });
        return formatSuccessResult({ success: true, deletedTaskId: args.id });
      } catch (err) {
        return formatErrorResult(err);
      }
    },
  );
}
