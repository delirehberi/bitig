import type { ChecklistItem, Task, TaskActivityEntry } from "@bitig/core";
import { TaskSchema } from "@bitig/core";
import {
  formatAddressCoordinate,
  NOSTR_KIND_PROJECT,
  NOSTR_KIND_TASK,
  NOSTR_TAG_A,
  NOSTR_TAG_ALT,
  NOSTR_TAG_COMPLETED_AT_ISO,
  NOSTR_TAG_COMPLETED_BY,
  NOSTR_TAG_CREATED_BY,
  NOSTR_TAG_D,
  NOSTR_TAG_DUE,
  NOSTR_TAG_IS_PUBLIC,
  NOSTR_TAG_LABEL,
  NOSTR_TAG_NUMBER,
  NOSTR_TAG_ORDER,
  NOSTR_TAG_PRIORITY,
  NOSTR_TAG_PROJECT,
  NOSTR_TAG_STARTED_AT_ISO,
  NOSTR_TAG_STARTED_BY,
  NOSTR_TAG_STATUS,
  NOSTR_TAG_UPDATED_BY,
} from "../kinds";
import { NOSTR_TAG_CREATED_AT_ISO, NOSTR_TAG_UPDATED_AT_ISO, type NostrEventLike } from "./project-codec";

/** Event content: cleartext for public tasks, NIP-44 encrypted for private ones. */
export interface TaskPayload {
  title: string;
  description: string;
  /** Omitted when the task has no checklist. */
  checklist?: ChecklistItem[];
  /** What the task needs from a person; omitted when it needs nobody. */
  needsHuman?: string;
  /** Set while the task waits for a person to approve it; omitted once approved. */
  pendingApproval?: true;
  /** IDs of the tasks this one waits on; omitted when none. */
  dependsOn?: string[];
  /** Ordered LLM/actor activity entries; omitted when none. */
  activity?: TaskActivityEntry[];
}

export interface TaskEncryptor {
  nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;
}

export interface TaskDecryptor {
  nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
}

/**
 * Encodes a Bitig Task into a Nostr event template.
 * If task.isPublic is false, encrypts the title and description using NIP-44 self-encryption.
 */
export async function encodeTaskEvent(
  task: Task,
  authorPubkey: string,
  encryptor?: TaskEncryptor,
): Promise<{
  kind: typeof NOSTR_KIND_TASK;
  created_at: number;
  tags: string[][];
  content: string;
}> {
  const createdUnix = Math.floor(Date.parse(task.updatedAt) / 1000);

  const tags: string[][] = [
    [NOSTR_TAG_D, task.id],
    [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_PROJECT, authorPubkey, task.projectId)],
    [NOSTR_TAG_PROJECT, task.projectId],
    [NOSTR_TAG_STATUS, task.status],
    [NOSTR_TAG_IS_PUBLIC, task.isPublic ? "true" : "false"],
    [NOSTR_TAG_CREATED_AT_ISO, task.createdAt],
    [NOSTR_TAG_UPDATED_AT_ISO, task.updatedAt],
  ];

  if (task.priority !== undefined) {
    tags.push([NOSTR_TAG_PRIORITY, task.priority]);
  }
  if (task.dueDate !== undefined) {
    tags.push([NOSTR_TAG_DUE, task.dueDate]);
  }
  if (task.order !== undefined) {
    tags.push([NOSTR_TAG_ORDER, String(task.order)]);
  }
  if (task.number !== undefined) {
    tags.push([NOSTR_TAG_NUMBER, String(task.number)]);
  }
  if (task.startedAt !== undefined) {
    tags.push([NOSTR_TAG_STARTED_AT_ISO, task.startedAt]);
  }
  if (task.completedAt !== undefined) {
    tags.push([NOSTR_TAG_COMPLETED_AT_ISO, task.completedAt]);
  }
  if (task.createdBy !== undefined) {
    tags.push([NOSTR_TAG_CREATED_BY, task.createdBy]);
  }
  if (task.startedBy !== undefined) {
    tags.push([NOSTR_TAG_STARTED_BY, task.startedBy]);
  }
  if (task.completedBy !== undefined) {
    tags.push([NOSTR_TAG_COMPLETED_BY, task.completedBy]);
  }
  if (task.updatedBy !== undefined) {
    tags.push([NOSTR_TAG_UPDATED_BY, task.updatedBy]);
  }
  if (task.labels !== undefined) {
    for (const label of task.labels) {
      tags.push([NOSTR_TAG_LABEL, label]);
    }
  }

  tags.push([NOSTR_TAG_ALT, `Bitig Task: ${task.isPublic ? task.title : "Private Task"}`]);

  const payload: TaskPayload = {
    title: task.title,
    description: task.description,
  };
  if (task.checklist !== undefined) {
    payload.checklist = task.checklist;
  }
  if (task.needsHuman !== undefined) {
    payload.needsHuman = task.needsHuman;
  }
  if (task.pendingApproval !== undefined) {
    payload.pendingApproval = task.pendingApproval;
  }
  if (task.dependsOn !== undefined) {
    payload.dependsOn = task.dependsOn;
  }
  if (task.activity !== undefined) {
    payload.activity = task.activity;
  }
  const jsonPayload = JSON.stringify(payload);

  let content: string;
  if (task.isPublic) {
    content = jsonPayload;
  } else {
    if (!encryptor) {
      throw new Error("Encryption is required for private tasks, but no encryptor was provided");
    }
    content = await encryptor.nip44Encrypt(authorPubkey, jsonPayload);
  }

  return {
    kind: NOSTR_KIND_TASK,
    created_at: Number.isFinite(createdUnix) ? createdUnix : Math.floor(Date.now() / 1000),
    tags,
    content,
  };
}

/**
 * Decodes a Nostr event into a Bitig Task domain entity.
 * Decrypts content using NIP-44 if isPublic is false.
 */
export async function decodeTaskEvent(
  event: NostrEventLike,
  authorPubkey: string,
  decryptor?: TaskDecryptor,
): Promise<Task> {
  if (event.kind !== NOSTR_KIND_TASK) {
    throw new Error(`Expected kind ${String(NOSTR_KIND_TASK)}, received ${String(event.kind)}`);
  }

  let dTag: string | undefined;
  let projectTag: string | undefined;
  let statusTag: string | undefined;
  let isPublicTag: string | undefined;
  let priorityTag: string | undefined;
  let dueTag: string | undefined;
  let orderTag: string | undefined;
  let numberTag: string | undefined;
  let startedAtIso: string | undefined;
  let completedAtIso: string | undefined;
  let createdByTag: string | undefined;
  let startedByTag: string | undefined;
  let completedByTag: string | undefined;
  let updatedByTag: string | undefined;
  let createdAtIso: string | undefined;
  let updatedAtIso: string | undefined;
  const labels: string[] = [];

  for (const tag of event.tags) {
    const key = tag[0];
    const val = tag[1];
    if (!val) continue;

    if (key === NOSTR_TAG_D) {
      dTag = val;
    } else if (key === NOSTR_TAG_PROJECT) {
      projectTag = val;
    } else if (key === NOSTR_TAG_STATUS) {
      statusTag = val;
    } else if (key === NOSTR_TAG_IS_PUBLIC) {
      isPublicTag = val;
    } else if (key === NOSTR_TAG_PRIORITY) {
      priorityTag = val;
    } else if (key === NOSTR_TAG_DUE) {
      dueTag = val;
    } else if (key === NOSTR_TAG_ORDER) {
      orderTag = val;
    } else if (key === NOSTR_TAG_NUMBER) {
      numberTag = val;
    } else if (key === NOSTR_TAG_STARTED_AT_ISO) {
      startedAtIso = val;
    } else if (key === NOSTR_TAG_COMPLETED_AT_ISO) {
      completedAtIso = val;
    } else if (key === NOSTR_TAG_CREATED_BY) {
      createdByTag = val;
    } else if (key === NOSTR_TAG_STARTED_BY) {
      startedByTag = val;
    } else if (key === NOSTR_TAG_COMPLETED_BY) {
      completedByTag = val;
    } else if (key === NOSTR_TAG_UPDATED_BY) {
      updatedByTag = val;
    } else if (key === NOSTR_TAG_LABEL) {
      labels.push(val);
    } else if (key === NOSTR_TAG_CREATED_AT_ISO) {
      createdAtIso = val;
    } else if (key === NOSTR_TAG_UPDATED_AT_ISO) {
      updatedAtIso = val;
    }
  }

  if (!dTag) {
    throw new Error("Missing 'd' tag on task event");
  }
  if (!projectTag) {
    throw new Error("Missing 'project' tag on task event");
  }

  const isPublic = isPublicTag === "true";
  let payloadStr: string;

  if (isPublic) {
    payloadStr = event.content;
  } else {
    if (!decryptor) {
      throw new Error("Decryption is required for private tasks, but no decryptor was provided");
    }
    payloadStr = await decryptor.nip44Decrypt(authorPubkey, event.content);
  }

  let parsedPayload: TaskPayload;
  try {
    parsedPayload = JSON.parse(payloadStr) as TaskPayload;
  } catch (err) {
    throw new Error(
      `Failed to parse task payload JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const fallbackIso = new Date(event.created_at * 1000).toISOString();
  const rawTask: Record<string, unknown> = {
    id: dTag,
    projectId: projectTag,
    title: parsedPayload.title,
    description: parsedPayload.description,
    status: statusTag ?? "todo",
    isPublic,
    createdAt: createdAtIso ?? fallbackIso,
    updatedAt: updatedAtIso ?? fallbackIso,
  };

  if (priorityTag) {
    rawTask.priority = priorityTag;
  }
  if (dueTag) {
    rawTask.dueDate = dueTag;
  }
  if (orderTag !== undefined && !Number.isNaN(Number(orderTag))) {
    rawTask.order = Number(orderTag);
  }
  if (numberTag !== undefined) {
    rawTask.number = Number(numberTag);
  }
  if (startedAtIso !== undefined) {
    rawTask.startedAt = startedAtIso;
  }
  if (completedAtIso !== undefined) {
    rawTask.completedAt = completedAtIso;
  }
  if (createdByTag !== undefined) {
    rawTask.createdBy = createdByTag;
  }
  if (startedByTag !== undefined) {
    rawTask.startedBy = startedByTag;
  }
  if (completedByTag !== undefined) {
    rawTask.completedBy = completedByTag;
  }
  if (updatedByTag !== undefined) {
    rawTask.updatedBy = updatedByTag;
  }
  if (labels.length > 0) {
    rawTask.labels = labels;
  }
  if (parsedPayload.checklist !== undefined) {
    rawTask.checklist = parsedPayload.checklist;
  }
  if (parsedPayload.needsHuman !== undefined) {
    rawTask.needsHuman = parsedPayload.needsHuman;
  }
  if (parsedPayload.pendingApproval !== undefined) {
    rawTask.pendingApproval = parsedPayload.pendingApproval;
  }
  if (parsedPayload.dependsOn !== undefined && parsedPayload.dependsOn.length > 0) {
    rawTask.dependsOn = parsedPayload.dependsOn;
  }
  if (parsedPayload.activity !== undefined) {
    rawTask.activity = parsedPayload.activity;
  }

  return TaskSchema.parse(rawTask);
}

