import type { z } from "zod";
import type {
  ChecklistItemSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  ProjectKindSchema,
  ProjectSchema,
  TaskFilterSchema,
  TaskPrioritySchema,
  TaskSchema,
  TaskStatusSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
  ProjectBundleSchema,
  BackupBundleSchema,
} from "./schemas";

export type Project = z.output<typeof ProjectSchema>;
export type Task = z.output<typeof TaskSchema>;
export type TaskStatus = z.output<typeof TaskStatusSchema>;
export type TaskPriority = z.output<typeof TaskPrioritySchema>;
export type ProjectKind = z.output<typeof ProjectKindSchema>;
export type ChecklistItem = z.output<typeof ChecklistItemSchema>;

export type ProjectBundle = z.output<typeof ProjectBundleSchema>;
export type BackupBundle = z.output<typeof BackupBundleSchema>;

/** Caller-facing inputs: fields with defaults are optional. */
export type CreateProjectInput = z.input<typeof CreateProjectInputSchema>;
export type UpdateProjectInput = z.input<typeof UpdateProjectInputSchema>;
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;
export type UpdateTaskInput = z.input<typeof UpdateTaskInputSchema>;
export type TaskFilter = z.input<typeof TaskFilterSchema>;

/** Inputs after validation and defaulting. */
export type ParsedCreateProjectInput = z.output<typeof CreateProjectInputSchema>;
export type ParsedUpdateProjectInput = z.output<typeof UpdateProjectInputSchema>;
export type ParsedCreateTaskInput = z.output<typeof CreateTaskInputSchema>;
export type ParsedUpdateTaskInput = z.output<typeof UpdateTaskInputSchema>;

