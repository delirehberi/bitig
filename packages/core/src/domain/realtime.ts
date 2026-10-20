import { z } from "zod";
import { CommentSchema, IdSchema, ProjectSchema, TaskSchema, WebhookSchema } from "./schemas";

/**
 * Live workspace mutation events broadcast by the Worker's RealtimeHub Durable
 * Object over `/api/realtime`.
 */
export const RealtimeEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("project.created"),
    project: ProjectSchema,
  }),
  z.strictObject({
    type: z.literal("project.updated"),
    project: ProjectSchema,
  }),
  z.strictObject({
    type: z.literal("project.deleted"),
    id: IdSchema,
  }),
  z.strictObject({
    type: z.literal("task.created"),
    task: TaskSchema,
  }),
  z.strictObject({
    type: z.literal("task.updated"),
    task: TaskSchema,
  }),
  z.strictObject({
    type: z.literal("task.deleted"),
    id: IdSchema,
  }),
  z.strictObject({
    type: z.literal("comment.created"),
    comment: CommentSchema,
  }),
  z.strictObject({
    type: z.literal("comment.deleted"),
    id: IdSchema,
    taskId: IdSchema.exactOptional(),
  }),
  z.strictObject({
    type: z.literal("webhook.created"),
    webhook: WebhookSchema,
  }),
  z.strictObject({
    type: z.literal("webhook.updated"),
    webhook: WebhookSchema,
  }),
  z.strictObject({
    type: z.literal("webhook.deleted"),
    id: IdSchema,
  }),
  z.strictObject({
    type: z.literal("sync"),
  }),
]);

export type RealtimeEvent = z.output<typeof RealtimeEventSchema>;

