/**
 * Nostr event kinds and tag identifiers for Bitig.
 *
 * Conforms to docs/nostr-spec.md:
 * - Kinds 30000-39999 are parameterized replaceable events (NIP-01, NIP-33).
 * - Kind 5 is deletion (NIP-09).
 * - Kind 31989 is App Handler (NIP-89).
 */

export const NOSTR_KIND_PROJECT = 30331 as const;
export const NOSTR_KIND_TASK = 30332 as const;
export const NOSTR_KIND_APP_HANDLER = 31989 as const;
export const NOSTR_KIND_DELETE = 5 as const;

export type BitigNostrKind =
  | typeof NOSTR_KIND_PROJECT
  | typeof NOSTR_KIND_TASK
  | typeof NOSTR_KIND_APP_HANDLER
  | typeof NOSTR_KIND_DELETE;

export const NOSTR_TAG_D = "d" as const;
export const NOSTR_TAG_A = "a" as const;
export const NOSTR_TAG_PROJECT = "project" as const;
export const NOSTR_TAG_NAME = "name" as const;
export const NOSTR_TAG_KIND = "kind" as const;
export const NOSTR_TAG_STATUS = "status" as const;
export const NOSTR_TAG_IS_PUBLIC = "is_public" as const;
export const NOSTR_TAG_PRIORITY = "priority" as const;
export const NOSTR_TAG_DUE = "due" as const;
export const NOSTR_TAG_ORDER = "order" as const;
export const NOSTR_TAG_LABEL = "t" as const;
export const NOSTR_TAG_ALT = "alt" as const;
/** Project key for ticket codes: `["key", "BIT"]`. */
export const NOSTR_TAG_PROJECT_KEY = "key" as const;
/** Task number within its project: `["number", "12"]`. */
export const NOSTR_TAG_NUMBER = "number" as const;
/** Project resource link: `["resource", url, type, label]`, one tag per link, in order. */
export const NOSTR_TAG_RESOURCE = "resource" as const;

/**
 * Builds an address coordinate string `kind:pubkey:dTag`.
 */
export function formatAddressCoordinate(kind: number, pubkey: string, dTag: string): string {
  return `${String(kind)}:${pubkey}:${dTag}`;
}

