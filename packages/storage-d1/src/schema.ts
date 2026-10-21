import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import {
  DEFAULT_DESCRIPTION,
  DEFAULT_IS_PUBLIC,
  DEFAULT_PROJECT_KIND,
  DEFAULT_TASK_STATUS,
  DEFAULT_WEBHOOK_ENABLED,
  DEFAULT_WEBHOOK_PROVIDER,
  type ChecklistItem,
  type CommentAuthorType,
  type ProjectKind,
  type ProjectResource,
  type TaskActivityEntry,
  type TaskPriority,
  type TaskStatus,
  type WebhookMapping,
  type WebhookProvider,
} from "@bitig/core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(DEFAULT_DESCRIPTION),
  kind: text("kind").$type<ProjectKind>().notNull().default(DEFAULT_PROJECT_KIND),
  resources: text("resources", { mode: "json" }).$type<ProjectResource[]>(),
  key: text("key"),
  archived: integer("archived", { mode: "boolean" }),
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
    pendingApproval: integer("pending_approval", { mode: "boolean" }),
    dependsOn: text("depends_on", { mode: "json" }).$type<string[]>(),
    number: integer("number"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdBy: text("created_by"),
    startedBy: text("started_by"),
    completedBy: text("completed_by"),
    updatedBy: text("updated_by"),
    activity: text("activity", { mode: "json" }).$type<TaskActivityEntry[]>(),
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

export const webhooks = sqliteTable(
  "webhooks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    provider: text("provider").$type<WebhookProvider>().notNull().default(DEFAULT_WEBHOOK_PROVIDER),
    token: text("token").notNull(),
    enabled: integer("enabled", { mode: "boolean" })
      .notNull()
      .default(DEFAULT_WEBHOOK_ENABLED),
    mapping: text("mapping", { mode: "json" }).$type<WebhookMapping>(),
    defaultPriority: text("default_priority").$type<TaskPriority>(),
    defaultLabels: text("default_labels", { mode: "json" }).$type<string[]>(),
    triggerCount: integer("trigger_count").notNull().default(0),
    lastTriggeredAt: integer("last_triggered_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("webhooks_project_id_idx").on(table.projectId),
    uniqueIndex("webhooks_token_idx").on(table.token),
  ],
);

export type ProjectRecord = typeof projects.$inferSelect;
export type InsertProjectRecord = typeof projects.$inferInsert;
export type TaskRecord = typeof tasks.$inferSelect;
export type InsertTaskRecord = typeof tasks.$inferInsert;

export type CommentRecord = typeof comments.$inferSelect;
export type InsertCommentRecord = typeof comments.$inferInsert;
export type WebhookRecord = typeof webhooks.$inferSelect;
export type InsertWebhookRecord = typeof webhooks.$inferInsert;
