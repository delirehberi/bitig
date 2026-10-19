/**
 * Domain vocabulary and field limits shared by every storage adapter.
 * Adapters must not hard-code these values; persistence layers (D1 check
 * constraints, frontmatter validation, Nostr tags) derive from them.
 */

export const TASK_STATUSES = ["todo", "in_progress", "done", "archived"] as const;
export const DEFAULT_TASK_STATUS = "todo" satisfies (typeof TASK_STATUSES)[number];
export const COMPLETED_TASK_STATUS = "done" satisfies (typeof TASK_STATUSES)[number];

/** Ordered lowest to highest. */
export const TASK_PRIORITIES = ["trivial", "low", "medium", "high", "urgent"] as const;

export const PROJECT_KINDS = ["paid", "hobby", "open_source", "personal", "internal"] as const;
export const DEFAULT_PROJECT_KIND = "hobby" satisfies (typeof PROJECT_KINDS)[number];

export const DEFAULT_DESCRIPTION = "";
export const DEFAULT_IS_PUBLIC = false;

export const PROJECT_NAME_MAX = 200;
export const TASK_TITLE_MAX = 500;
export const DESCRIPTION_MAX = 50_000;
export const LABEL_MAX = 64;
export const LABELS_MAX_COUNT = 32;


/** Subtasks: a task's checklist. Items are ordered by position; an empty list is stored as no list. */
export const CHECKLIST_ITEM_TEXT_MAX = 500;
export const CHECKLIST_MAX_ITEMS = 200;
