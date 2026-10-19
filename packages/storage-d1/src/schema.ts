import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IS_PUBLIC,
  DEFAULT_PROJECT_KIND,
  DEFAULT_TASK_STATUS,
  type ChecklistItem,
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
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("tasks_project_id_idx").on(table.projectId),
    index("tasks_status_idx").on(table.status),
    index("tasks_order_idx").on(table.order),
  ],
);

export type ProjectRecord = typeof projects.$inferSelect;
export type InsertProjectRecord = typeof projects.$inferInsert;
export type TaskRecord = typeof tasks.$inferSelect;
export type InsertTaskRecord = typeof tasks.$inferInsert;

