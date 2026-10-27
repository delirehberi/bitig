import type { Checkpoint } from "@bitig/core";
import { CheckpointSchema } from "@bitig/core";
import {
  formatAddressCoordinate,
  NOSTR_KIND_CHECKPOINT,
  NOSTR_KIND_TASK,
  NOSTR_TAG_A,
  NOSTR_TAG_ALT,
  NOSTR_TAG_D,
  NOSTR_TAG_TASK,
} from "../kinds";
import { NOSTR_TAG_CREATED_AT_ISO, type NostrEventLike } from "./project-codec";
import type { TaskDecryptor, TaskEncryptor } from "./task-codec";

/** Event content before encryption. Step, status and snapshot never appear in tags. */
export interface CheckpointPayload {
  stepIndex: Checkpoint["stepIndex"];
  status: Checkpoint["status"];
  stateSnapshot: Checkpoint["stateSnapshot"];
}

/**
 * Encodes a checkpoint into a Nostr event template. The content is always NIP-44
 * self-encrypted, whatever the task's visibility: snapshots carry working notes, and
 * relays keep old events. The `d` tag is the checkpoint ID, so saving a step again
 * replaces its event. `createdAt` is the event time, which the caller advances on every
 * save; the checkpoint's own creation time travels in a tag.
 */
export async function encodeCheckpointEvent(
  checkpoint: Checkpoint,
  authorPubkey: string,
  createdAt: number,
  encryptor: TaskEncryptor,
): Promise<{
  kind: typeof NOSTR_KIND_CHECKPOINT;
  created_at: number;
  tags: string[][];
  content: string;
}> {
  const payload: CheckpointPayload = {
    stepIndex: checkpoint.stepIndex,
    status: checkpoint.status,
    stateSnapshot: checkpoint.stateSnapshot,
  };

  return {
    kind: NOSTR_KIND_CHECKPOINT,
    created_at: createdAt,
    tags: [
      [NOSTR_TAG_D, checkpoint.id],
      [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_TASK, authorPubkey, checkpoint.taskId)],
      [NOSTR_TAG_TASK, checkpoint.taskId],
      [NOSTR_TAG_CREATED_AT_ISO, checkpoint.createdAt],
      [NOSTR_TAG_ALT, "Bitig Checkpoint"],
    ],
    content: await encryptor.nip44Encrypt(authorPubkey, JSON.stringify(payload)),
  };
}

/** Decodes and decrypts a checkpoint event; the result is validated against the core schema. */
export async function decodeCheckpointEvent(
  event: NostrEventLike,
  authorPubkey: string,
  decryptor: TaskDecryptor,
): Promise<Checkpoint> {
  if (event.kind !== NOSTR_KIND_CHECKPOINT) {
    throw new Error(`Expected kind ${String(NOSTR_KIND_CHECKPOINT)}, received ${String(event.kind)}`);
  }

  const tag = (name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1];
  const payload = JSON.parse(await decryptor.nip44Decrypt(authorPubkey, event.content)) as Partial<CheckpointPayload>;

  return CheckpointSchema.parse({
    id: tag(NOSTR_TAG_D),
    taskId: tag(NOSTR_TAG_TASK),
    stepIndex: payload.stepIndex,
    status: payload.status,
    stateSnapshot: payload.stateSnapshot,
    createdAt: tag(NOSTR_TAG_CREATED_AT_ISO) ?? new Date(event.created_at * 1000).toISOString(),
  });
}
