import type { Webhook } from "@bitig/core";
import { WebhookSchema } from "@bitig/core";
import {
  formatAddressCoordinate,
  NOSTR_KIND_PROJECT,
  NOSTR_KIND_WEBHOOK,
  NOSTR_TAG_A,
  NOSTR_TAG_ALT,
  NOSTR_TAG_D,
  NOSTR_TAG_PROJECT,
} from "../kinds";
import { NOSTR_TAG_CREATED_AT_ISO, NOSTR_TAG_UPDATED_AT_ISO, type NostrEventLike } from "./project-codec";
import type { TaskDecryptor, TaskEncryptor } from "./task-codec";

/**
 * Encodes a webhook into a NIP-44 self-encrypted Nostr event template so the
 * secret webhook token is never exposed in plaintext on relays.
 */
export async function encodeWebhookEvent(
  webhook: Webhook,
  authorPubkey: string,
  encryptor: TaskEncryptor,
): Promise<{
  kind: typeof NOSTR_KIND_WEBHOOK;
  created_at: number;
  tags: string[][];
  content: string;
}> {
  const updatedUnix = Math.floor(Date.parse(webhook.updatedAt) / 1000);
  return {
    kind: NOSTR_KIND_WEBHOOK,
    created_at: Number.isFinite(updatedUnix) ? updatedUnix : Math.floor(Date.now() / 1000),
    tags: [
      [NOSTR_TAG_D, webhook.id],
      [NOSTR_TAG_A, formatAddressCoordinate(NOSTR_KIND_PROJECT, authorPubkey, webhook.projectId)],
      [NOSTR_TAG_PROJECT, webhook.projectId],
      [NOSTR_TAG_CREATED_AT_ISO, webhook.createdAt],
      [NOSTR_TAG_UPDATED_AT_ISO, webhook.updatedAt],
      [NOSTR_TAG_ALT, "Bitig Webhook"],
    ],
    content: await encryptor.nip44Encrypt(authorPubkey, JSON.stringify(webhook)),
  };
}

/** Decodes and decrypts a webhook event. */
export async function decodeWebhookEvent(
  event: NostrEventLike,
  authorPubkey: string,
  decryptor: TaskDecryptor,
): Promise<Webhook> {
  if (event.kind !== NOSTR_KIND_WEBHOOK) {
    throw new Error(`Expected kind ${String(NOSTR_KIND_WEBHOOK)}, received ${String(event.kind)}`);
  }
  const decrypted = JSON.parse(await decryptor.nip44Decrypt(authorPubkey, event.content)) as unknown;
  return WebhookSchema.parse(decrypted);
}

