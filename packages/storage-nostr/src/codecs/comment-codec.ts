import type { Comment } from "@bitig/core";
import { CommentSchema } from "@bitig/core";
import {
  formatAddressCoordinate,
  NOSTR_KIND_COMMENT,
  NOSTR_KIND_TASK,
  NOSTR_TAG_A,
  NOSTR_TAG_ALT,
  NOSTR_TAG_AUTHOR_TYPE,
  NOSTR_TAG_D,
  NOSTR_TAG_TASK,
} from "../kinds";
import { NOSTR_TAG_CREATED_AT_ISO, type NostrEventLike } from "./project-codec";
import type { TaskDecryptor, TaskEncryptor } from "./task-codec";

/** Event content before encryption. */
export interface CommentPayload {
  body: string;
  /** Omitted when the comment has no author name. */
  author?: string;
}

/**
 * Encodes a comment into a Nostr event template. The content is always NIP-44
 * self-encrypted, whatever the task's visibility: a task can be made private
 * later, and relays keep old events.
 */
export async function encodeCommentEvent(
  comment: Comment,
  authorPubkey: string,
  encryptor: TaskEncryptor,
): Promise<{
  kind: typeof NOSTR_KIND_COMMENT;
  created_at: number;
  tags: string[][];
  content: string;
}> {
  const createdUnix = Math.floor(Date.parse(comment.createdAt) / 1000);
  const payload: CommentPayload = { body: comment.body };
  if (comment.author !== undefined) payload.author = comment.author;

  return {
    kind: NOSTR_KIND_COMMENT,
    created_at: Number.isFinite(createdUnix) ? createdUnix : Math.floor(Date.now() / 1000),
    tags: [
      [NOSTR_TAG_D, comment.id],
      [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_TASK, authorPubkey, comment.taskId)],
      [NOSTR_TAG_TASK, comment.taskId],
      [NOSTR_TAG_AUTHOR_TYPE, comment.authorType],
      [NOSTR_TAG_CREATED_AT_ISO, comment.createdAt],
      [NOSTR_TAG_ALT, "Bitig Comment"],
    ],
    content: await encryptor.nip44Encrypt(authorPubkey, JSON.stringify(payload)),
  };
}

/** Decodes and decrypts a comment event. */
export async function decodeCommentEvent(
  event: NostrEventLike,
  authorPubkey: string,
  decryptor: TaskDecryptor,
): Promise<Comment> {
  if (event.kind !== NOSTR_KIND_COMMENT) {
    throw new Error(`Expected kind ${String(NOSTR_KIND_COMMENT)}, received ${String(event.kind)}`);
  }

  const tag = (name: string): string | undefined => event.tags.find((t) => t[0] === name)?.[1];
  const payload = JSON.parse(await decryptor.nip44Decrypt(authorPubkey, event.content)) as CommentPayload;

  const raw: Record<string, unknown> = {
    id: tag(NOSTR_TAG_D),
    taskId: tag(NOSTR_TAG_TASK),
    body: payload.body,
    authorType: tag(NOSTR_TAG_AUTHOR_TYPE),
    createdAt: tag(NOSTR_TAG_CREATED_AT_ISO) ?? new Date(event.created_at * 1000).toISOString(),
  };
  if (payload.author !== undefined) raw.author = payload.author;
  return CommentSchema.parse(raw);
}
