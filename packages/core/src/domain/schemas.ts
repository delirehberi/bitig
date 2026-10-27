import { z } from "zod";
import {
  CHECKPOINT_STATUSES,
  CHECKPOINT_SUMMARY_MAX,
  CHECKPOINT_INSTRUCTIONS_MAX,
  CHECKPOINT_ITEMS_MAX,
  CHECKPOINT_ARTIFACT_MAX,
  CHECKPOINT_VALUE_MAX,
  CHECKPOINT_KEY_MAX,
  CHECKLIST_ITEM_TEXT_MAX,
  CHECKLIST_MAX_ITEMS,
  COMMENT_AUTHOR_MAX,
  COMMENT_AUTHOR_TYPES,
  COMMENT_BODY_MAX,
  DEFAULT_COMMENT_AUTHOR_TYPE,
  DEFAULT_DESCRIPTION,
  DEFAULT_IS_PUBLIC,
  DEFAULT_PROJECT_KIND,
  DEFAULT_TASK_STATUS,
  DEFAULT_WEBHOOK_ENABLED,
  DEFAULT_WEBHOOK_PROVIDER,
  DESCRIPTION_MAX,
  LABELS_MAX_COUNT,
  DEPENDS_ON_MAX_COUNT,
  LABEL_MAX,
  NEEDS_HUMAN_MAX,
  PROJECT_KINDS,
  PROJECT_KEY_PATTERN,
  PROJECT_NAME_MAX,
  RESOURCES_MAX_COUNT,
  RESOURCE_LABEL_MAX,
  RESOURCE_TYPES,
  RESOURCE_URL_MAX,
  TASK_ACTIVITY_ACTIONS,
  TASK_ACTIVITY_MAX_ITEMS,
  TASK_ACTOR_MAX,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TITLE_MAX,
  WEBHOOK_MAPPING_PATH_MAX,
  WEBHOOK_NAME_MAX,
  WEBHOOK_PROVIDERS,
  WEBHOOK_TOKEN_PATTERN,
} from "./constants";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Domain IDs are UUIDv7 strings. Validating them here also closes off path
 * traversal for adapters that map IDs onto filesystem paths. */
export const IdSchema = z.uuidv7();

/** ISO 8601 UTC timestamp; offsets other than `Z` are rejected. */
export const TimestampSchema = z.iso.datetime();

export const CheckpointStatusSchema = z.enum(CHECKPOINT_STATUSES);
const CheckpointValueSchema = z.union([z.string().max(CHECKPOINT_VALUE_MAX), z.number(), z.boolean(), z.null()]);
const CheckpointMapSchema = z.record(z.string().min(1).max(CHECKPOINT_KEY_MAX), CheckpointValueSchema)
  .refine((value) => Object.keys(value).length <= CHECKPOINT_ITEMS_MAX, "Too many checkpoint metadata fields");
export const StateSnapshotSchema = z.strictObject({
  summary: z.string().trim().min(1).max(CHECKPOINT_SUMMARY_MAX),
  modifiedArtifacts: z.array(z.string().trim().min(1).max(CHECKPOINT_ARTIFACT_MAX)).max(CHECKPOINT_ITEMS_MAX),
  decisionsMade: z.array(z.string().trim().min(1).max(CHECKPOINT_VALUE_MAX)).max(CHECKPOINT_ITEMS_MAX),
  blockersOrErrors: z.union([z.string().max(CHECKPOINT_INSTRUCTIONS_MAX), CheckpointMapSchema]).exactOptional(),
  nextStepInstructions: z.string().trim().min(1).max(CHECKPOINT_INSTRUCTIONS_MAX),
  metadata: CheckpointMapSchema.exactOptional(),
});
export const SaveCheckpointInputSchema = z.strictObject({
  taskId: IdSchema,
  stepIndex: z.number().int().nonnegative(),
  status: CheckpointStatusSchema,
  stateSnapshot: StateSnapshotSchema,
});
export const CheckpointSchema = SaveCheckpointInputSchema.extend({
  id: IdSchema,
  createdAt: TimestampSchema,
});

/** Calendar date `YYYY-MM-DD`; zod's regex rejects impossible dates (e.g. Feb 30). */
export const DueDateSchema = z.iso.date();

export const TaskStatusSchema = z.enum(TASK_STATUSES);
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export const ProjectKindSchema = z.enum(PROJECT_KINDS);

export const ProjectNameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX);

/** Project key for ticket codes, e.g. `BIT`. Input is trimmed and uppercased. */
export const ProjectKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(PROJECT_KEY_PATTERN, "Project key must be 2-10 letters or digits and start with a letter");

/** A task's number within its project; with the project key it forms the ticket code. */
export const TaskNumberSchema = z.int().positive();
export const TaskTitleSchema = z.string().trim().min(1).max(TASK_TITLE_MAX);
export const DescriptionSchema = z.string().trim().max(DESCRIPTION_MAX);
export const LabelSchema = z.string().trim().min(1).max(LABEL_MAX);

export const LabelsSchema = z
  .array(LabelSchema)
  .max(LABELS_MAX_COUNT)
  .refine((labels) => new Set(labels).size === labels.length, {
    message: "Labels must be unique",
  });

export const TaskOrderSchema = z.number();

/**
 * IDs of the tasks a task waits on. IDs, not codes, because a code changes when a task moves
 * project or its project key changes. Existence and cycles are checked by storage
 * (`assertTaskDependencies`), since they depend on the other tasks.
 */
export const DependsOnSchema = z
  .array(IdSchema)
  .max(DEPENDS_ON_MAX_COUNT)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Dependencies must be unique",
  });

/** One subtask. Its position in the checklist is its order. */
export const ChecklistItemSchema = z.strictObject({
  text: z.string().trim().min(1).max(CHECKLIST_ITEM_TEXT_MAX),
  done: z.boolean(),
  /** Set when work on this subtask explicitly started. */
  startedAt: TimestampSchema.exactOptional(),
  /** Set when this subtask was marked done; omitted while unchecked. */
  completedAt: TimestampSchema.exactOptional(),
});

export const ChecklistSchema = z.array(ChecklistItemSchema).max(CHECKLIST_MAX_ITEMS);

/** Why a task needs a person, e.g. a decision or an approval. Set means the task waits on a human. */
export const NeedsHumanSchema = z.string().trim().min(1).max(NEEDS_HUMAN_MAX);

/** Name of the LLM or actor that touched a task, e.g. `claude` or `antigravity`. */
export const TaskActorSchema = z.string().trim().min(1).max(TASK_ACTOR_MAX);

export const TaskActivityActionSchema = z.enum(TASK_ACTIVITY_ACTIONS);

/** One recorded LLM/actor touch on a task, in chronological order. */
export const TaskActivityEntrySchema = z.strictObject({
  action: TaskActivityActionSchema,
  actor: TaskActorSchema,
  timestamp: TimestampSchema,
  fromStatus: TaskStatusSchema.exactOptional(),
  toStatus: TaskStatusSchema.exactOptional(),
  /** On `dependency_override`: the unfinished dependencies (ticket codes, or IDs without one) a person overrode. */
  blockedBy: z.array(z.string().trim().min(1).max(TASK_ACTOR_MAX)).min(1).max(DEPENDS_ON_MAX_COUNT).exactOptional(),
});

export const TaskActivitySchema = z.array(TaskActivityEntrySchema).max(TASK_ACTIVITY_MAX_ITEMS);

export const ResourceTypeSchema = z.enum(RESOURCE_TYPES);

/** Only web links: other schemes (javascript:, file:) are never stored or rendered. */
export const ResourceUrlSchema = z.url({ protocol: /^https?$/ }).max(RESOURCE_URL_MAX);

/** A link from a project to something outside Bitig. Its position in the list is its order. */
export const ProjectResourceSchema = z.strictObject({
  type: ResourceTypeSchema,
  label: z.string().trim().min(1).max(RESOURCE_LABEL_MAX),
  url: ResourceUrlSchema,
});

export const ProjectResourcesSchema = z.array(ProjectResourceSchema).max(RESOURCES_MAX_COUNT);

export const CommentAuthorTypeSchema = z.enum(COMMENT_AUTHOR_TYPES);
/** Markdown text. Whitespace around it is trimmed; a blank comment is rejected. */
export const CommentBodySchema = z.string().trim().min(1).max(COMMENT_BODY_MAX);
/** A display name such as `Emre` or `claude`; never used for access control. */
export const CommentAuthorSchema = z.string().trim().min(1).max(COMMENT_AUTHOR_MAX);

export const WebhookProviderSchema = z.enum(WEBHOOK_PROVIDERS);
export const WebhookNameSchema = z.string().trim().min(1).max(WEBHOOK_NAME_MAX);
export const WebhookTokenSchema = z.string().regex(WEBHOOK_TOKEN_PATTERN, "Invalid webhook token");
export const WebhookMappingPathSchema = z.string().trim().min(1).max(WEBHOOK_MAPPING_PATH_MAX);
export const WebhookTriggerCountSchema = z.int().nonnegative();

/**
 * Custom dot-path mappings from an incoming JSON webhook payload to Bitig task fields
 * (e.g. `{ title: "issue.fields.summary", description: "issue.fields.description" }`).
 */
export const WebhookMappingSchema = z.strictObject({
  title: WebhookMappingPathSchema.exactOptional(),
  description: WebhookMappingPathSchema.exactOptional(),
  priority: WebhookMappingPathSchema.exactOptional(),
  labels: WebhookMappingPathSchema.exactOptional(),
});

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const ProjectSchema = z.strictObject({
  id: IdSchema,
  name: ProjectNameSchema,
  description: DescriptionSchema,
  kind: ProjectKindSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Never empty: an empty list is stored as no resources. */
  resources: ProjectResourcesSchema.min(1).exactOptional(),
  /** Set on every new project; projects created before ticket codes may lack one until backfilled. */
  key: ProjectKeySchema.exactOptional(),
  /** Set while the project is archived; omitted on active projects. */
  archived: z.literal(true).exactOptional(),
});

export const TaskSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  title: TaskTitleSchema,
  description: DescriptionSchema,
  status: TaskStatusSchema,
  isPublic: z.boolean(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  // Unset optional fields are omitted entirely (exactOptionalPropertyTypes).
  /** Set when the task first enters `in_progress` (or is created already active/done); cleared if reset to `todo`. */
  startedAt: TimestampSchema.exactOptional(),
  /** Set when the task enters `done`; cleared if reopened to `todo` or `in_progress`. */
  completedAt: TimestampSchema.exactOptional(),
  /** Actor/LLM that created the task, when created by an attributed caller. */
  createdBy: TaskActorSchema.exactOptional(),
  /** Actor/LLM that moved the task into `in_progress` (or created it active/done); cleared if reset to `todo`. */
  startedBy: TaskActorSchema.exactOptional(),
  /** Actor/LLM that marked the task `done`; cleared if reopened to `todo` or `in_progress`. */
  completedBy: TaskActorSchema.exactOptional(),
  /** Actor/LLM that performed the most recent attributed touch on the task. */
  updatedBy: TaskActorSchema.exactOptional(),
  /** Chronological history of attributed touches on the task; omitted when empty. */
  activity: TaskActivitySchema.min(1).exactOptional(),
  dueDate: DueDateSchema.exactOptional(),
  priority: TaskPrioritySchema.exactOptional(),
  labels: LabelsSchema.exactOptional(),
  order: TaskOrderSchema.exactOptional(),
  /** Never empty: an empty checklist is stored as no checklist. */
  checklist: ChecklistSchema.min(1).exactOptional(),
  /** Set while the task waits on a person; the text says what it needs. */
  needsHuman: NeedsHumanSchema.exactOptional(),
  /** Set while an agent- or webhook-created task waits for a person to approve it; omitted once approved. */
  pendingApproval: z.literal(true).exactOptional(),
  /** Tasks this one waits on. Never empty: an empty list is stored as none. */
  dependsOn: DependsOnSchema.min(1).exactOptional(),
  /** Assigned by storage, never by callers; tasks created before ticket codes may lack one until backfilled. */
  number: TaskNumberSchema.exactOptional(),
  /** Number of comments on the task; omitted when zero. */
  commentCount: z.int().positive().exactOptional(),
});

/** A note on a task. Comments are never edited: they are added and deleted. */
export const CommentSchema = z.strictObject({
  id: IdSchema,
  taskId: IdSchema,
  body: CommentBodySchema,
  /** Whether a person or an agent wrote it. */
  authorType: CommentAuthorTypeSchema,
  createdAt: TimestampSchema,
  author: CommentAuthorSchema.exactOptional(),
});

/** An incoming webhook endpoint bound to a project. */
export const WebhookSchema = z.strictObject({
  id: IdSchema,
  projectId: IdSchema,
  name: WebhookNameSchema,
  provider: WebhookProviderSchema,
  token: WebhookTokenSchema,
  enabled: z.boolean(),
  triggerCount: WebhookTriggerCountSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  mapping: WebhookMappingSchema.exactOptional(),
  defaultPriority: TaskPrioritySchema.exactOptional(),
  defaultLabels: LabelsSchema.exactOptional(),
  lastTriggeredAt: TimestampSchema.exactOptional(),
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Rejects patches that would change nothing. */
function hasAnyDefinedField(patch: Readonly<Record<string, unknown>>): boolean {
  return Object.values(patch).some((value) => value !== undefined);
}

const EMPTY_PATCH_MESSAGE = "Patch must contain at least one field";

export const CreateProjectInputSchema = z.strictObject({
  name: ProjectNameSchema,
  description: DescriptionSchema.default(DEFAULT_DESCRIPTION),
  kind: ProjectKindSchema.default(DEFAULT_PROJECT_KIND),
  resources: ProjectResourcesSchema.optional(),
  /** Derived from the name when omitted. */
  key: ProjectKeySchema.optional(),
});

/** `undefined` leaves a field unchanged; `resources` can be cleared with `null` or `[]`, and `archived` with `false` or `null`. */
export const UpdateProjectInputSchema = z
  .strictObject({
    name: ProjectNameSchema.optional(),
    description: DescriptionSchema.optional(),
    kind: ProjectKindSchema.optional(),
    /** Replaces the whole list. */
    resources: ProjectResourcesSchema.nullable().optional(),
    /** Changes the codes of every task in the project; numbers stay. */
    key: ProjectKeySchema.optional(),
    /** `true` archives the project; `false` or `null` recovers it. */
    archived: z.boolean().nullable().optional(),
  })
  .refine(hasAnyDefinedField, { message: EMPTY_PATCH_MESSAGE });

export const CreateTaskInputSchema = z.strictObject({
  projectId: IdSchema,
  title: TaskTitleSchema,
  description: DescriptionSchema.default(DEFAULT_DESCRIPTION),
  status: TaskStatusSchema.default(DEFAULT_TASK_STATUS),
  isPublic: z.boolean().default(DEFAULT_IS_PUBLIC),
  dueDate: DueDateSchema.optional(),
  priority: TaskPrioritySchema.optional(),
  labels: LabelsSchema.optional(),
  order: TaskOrderSchema.optional(),
  checklist: ChecklistSchema.optional(),
  needsHuman: NeedsHumanSchema.optional(),
  /** Set by MCP and webhook creation; people create approved tasks. */
  pendingApproval: z.literal(true).optional(),
  dependsOn: DependsOnSchema.optional(),
});

/** `undefined` (or a missing key) leaves a field unchanged; `null` clears an
 * optional field. Required fields are not nullable. */
export const UpdateTaskInputSchema = z
  .strictObject({
    projectId: IdSchema.optional(),
    title: TaskTitleSchema.optional(),
    description: DescriptionSchema.optional(),
    status: TaskStatusSchema.optional(),
    isPublic: z.boolean().optional(),
    dueDate: DueDateSchema.nullable().optional(),
    priority: TaskPrioritySchema.nullable().optional(),
    labels: LabelsSchema.nullable().optional(),
    order: TaskOrderSchema.nullable().optional(),
    /** Replaces the whole checklist; `null` or `[]` removes it. */
    checklist: ChecklistSchema.nullable().optional(),
    /** `null` clears it once a person has answered. */
    needsHuman: NeedsHumanSchema.nullable().optional(),
    /** `null` approves the task. A patch can never re-flag it. */
    pendingApproval: z.null().optional(),
    /** Replaces the whole list; `null` or `[]` removes it. */
    dependsOn: DependsOnSchema.nullable().optional(),
  })
  .refine(hasAnyDefinedField, { message: EMPTY_PATCH_MESSAGE });

export const CreateCommentInputSchema = z.strictObject({
  taskId: IdSchema,
  body: CommentBodySchema,
  authorType: CommentAuthorTypeSchema.default(DEFAULT_COMMENT_AUTHOR_TYPE),
  author: CommentAuthorSchema.optional(),
});

export const TaskFilterSchema = z.strictObject({
  projectId: IdSchema.optional(),
});

export const CreateWebhookInputSchema = z.strictObject({
  projectId: IdSchema,
  name: WebhookNameSchema,
  provider: WebhookProviderSchema.default(DEFAULT_WEBHOOK_PROVIDER),
  enabled: z.boolean().default(DEFAULT_WEBHOOK_ENABLED),
  mapping: WebhookMappingSchema.optional(),
  defaultPriority: TaskPrioritySchema.optional(),
  defaultLabels: LabelsSchema.optional(),
});

export const UpdateWebhookInputSchema = z
  .strictObject({
    projectId: IdSchema.optional(),
    name: WebhookNameSchema.optional(),
    provider: WebhookProviderSchema.optional(),
    enabled: z.boolean().optional(),
    mapping: WebhookMappingSchema.nullable().optional(),
    defaultPriority: TaskPrioritySchema.nullable().optional(),
    defaultLabels: LabelsSchema.nullable().optional(),
    /** When true, generates a fresh secret token for this webhook. */
    regenerateToken: z.boolean().optional(),
  })
  .refine(hasAnyDefinedField, { message: EMPTY_PATCH_MESSAGE });

export const WebhookFilterSchema = z.strictObject({
  projectId: IdSchema.optional(),
});

// ---------------------------------------------------------------------------
// Bundles & Interop
// ---------------------------------------------------------------------------

export const BUNDLE_VERSION = 1 as const;

export const ProjectBundleSchema = z
  .strictObject({
    version: z.literal(BUNDLE_VERSION),
    exportedAt: TimestampSchema,
    project: ProjectSchema,
    tasks: z.array(TaskSchema),
    /** Comments on the bundled tasks, oldest first. Bundles made before comments have none. */
    comments: z.array(CommentSchema).exactOptional(),
    checkpoints: z.array(CheckpointSchema).exactOptional(),
    /** Webhooks belonging to the bundled project, oldest first. Bundles made before webhooks have none. */
    webhooks: z.array(WebhookSchema).exactOptional(),
  })
  .refine((bundle) => bundle.tasks.every((task) => task.projectId === bundle.project.id), {
    message: "All tasks in bundle must belong to the bundled project",
  })
  .refine((bundle) => {
    const taskIds = new Set(bundle.tasks.map((task) => task.id));
    const checkpoints = bundle.checkpoints ?? [];
    return checkpoints.every((checkpoint) => taskIds.has(checkpoint.taskId)) &&
      new Set(checkpoints.map((checkpoint) => checkpoint.id)).size === checkpoints.length &&
      new Set(checkpoints.map((checkpoint) => `${checkpoint.taskId}:${String(checkpoint.stepIndex)}`)).size === checkpoints.length;
  }, { message: "Checkpoints must belong to bundled tasks and have unique IDs and task/step pairs" })
  .refine((bundle) => (bundle.webhooks ?? []).every((webhook) => webhook.projectId === bundle.project.id), {
    message: "All webhooks in bundle must belong to the bundled project",
  })
  .refine(
    (bundle) => {
      const taskIds = new Set(bundle.tasks.map((task) => task.id));
      return (bundle.comments ?? []).every((comment) => taskIds.has(comment.taskId));
    },
    { message: "All comments in bundle must belong to a bundled task" },
  )
  .refine(
    (bundle) => {
      const numbers = bundle.tasks.flatMap((task) => (task.number === undefined ? [] : [task.number]));
      return new Set(numbers).size === numbers.length;
    },
    { message: "Task numbers must be unique within a project" },
  );

export const BackupBundleSchema = z.strictObject({
  version: z.literal(BUNDLE_VERSION),
  exportedAt: TimestampSchema,
  bundles: z.array(ProjectBundleSchema),
});

