import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IS_PUBLIC,
  DEFAULT_PROJECT_KIND,
  DEFAULT_TASK_STATUS,
  type ChecklistItem,
  type CommentAuthorType,
  type ProjectKind,
  type ProjectResource,
  type TaskPriority,
  type TaskStatus,
} from "@bitig/core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(DEFAULT_DESCRIPTION),
  kind: text("kind").$type<ProjectKind>().notNull().default(DEFAULT_PROJECT_KIND),
  resources: text("resources", { mode: "json" }).$type<ProjectResource[]>(),
  key: text("key"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(DEFAULT_DESCRIPTION),
    status: text("status").$type<TaskStatus>().notNull().default(DEFAULT_TASK_STATUS),
    isPublic: integer("is_public", { mode: "boolean" })
      .notNull()
      .default(DEFAULT_IS_PUBLIC),
    dueDate: text("due_date"),
    priority: text("priority").$type<TaskPriority>(),
    labels: text("labels", { mode: "json" }).$type<string[]>(),
    order: real("order"),
    checklist: text("checklist", { mode: "json" }).$type<ChecklistItem[]>(),
    needsHuman: text("needs_human"),
    number: integer("number"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_status_idx").on(table.status),
    index("tasks_order_idx").on(table.order),
    index("tasks_project_number_idx").on(table.projectId, table.number),
  ],
);

export const comments = sqliteTable(
  "comments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    authorType: text("author_type").$type<CommentAuthorType>().notNull(),
    author: text("author"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("comments_task_id_idx").on(table.taskId)],
);

export type ProjectRecord = typeof projects.$inferSelect;
export type InsertProjectRecord = typeof projects.$inferInsert;
export type TaskRecord = typeof tasks.$inferSelect;
export type InsertTaskRecord = typeof tasks.$inferInsert;

export type CommentRecord = typeof comments.$inferSelect;
export type InsertCommentRecord = typeof comments.$inferInsert;
