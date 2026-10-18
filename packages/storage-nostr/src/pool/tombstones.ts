import type { Event } from "nostr-tools/pure";
import { NOSTR_KIND_DELETE, NOSTR_TAG_A, NOSTR_TAG_D } from "../kinds";

export interface TombstoneSet {
  readonly deletedCoordinates: ReadonlySet<string>;
  readonly deletedEventIds: ReadonlySet<string>;
  isDeleted(kind: number, pubkey: string, dTag: string, eventId?: string): boolean;
}

/**
 * Extracts deleted coordinates and event IDs from NIP-09 deletion events.
 */
export function buildTombstoneSet(deletionEvents: readonly Event[]): TombstoneSet {
  const deletedCoordinates = new Set<string>();
  const deletedEventIds = new Set<string>();

  for (const event of deletionEvents) {
    if (event.kind !== NOSTR_KIND_DELETE) continue;

    for (const tag of event.tags) {
      const type = tag[0];
      const val = tag[1];
      if (!val) continue;

      if (type === NOSTR_TAG_A) {
        deletedCoordinates.add(val);
      } else if (type === "e") {
        deletedEventIds.add(val);
      }
    }
  }

  return {
    deletedCoordinates,
    deletedEventIds,
    isDeleted(kind: number, pubkey: string, dTag: string, eventId?: string): boolean {
      if (eventId && deletedEventIds.has(eventId)) {
        return true;
      }
      const coord = `${String(kind)}:${pubkey}:${dTag}`;
      return deletedCoordinates.has(coord);
    },
  };
}

/**
 * Filters and deduplicates a list of parameterized replaceable events using
 * last-write-wins (LWW) by created_at, respecting NIP-09 tombstones.
 */
export function resolveReplaceableEvents(
  events: readonly Event[],
  tombstones: TombstoneSet,
): Event[] {
  // Deduplicate by event ID first
  const uniqueEvents = new Map<string, Event>();
  for (const ev of events) {
    uniqueEvents.set(ev.id, ev);
  }

  // Group by (kind:pubkey:d)
  const grouped = new Map<string, Event>();

  for (const ev of uniqueEvents.values()) {
    const dTag = ev.tags.find((t) => t[0] === NOSTR_TAG_D)?.[1];
    if (!dTag) continue;

    if (tombstones.isDeleted(ev.kind, ev.pubkey, dTag, ev.id)) {
      continue;
    }

    const key = `${String(ev.kind)}:${ev.pubkey}:${dTag}`;
    const existing = grouped.get(key);

    if (!existing) {
      grouped.set(key, ev);
    } else {
      // Last-Write-Wins: higher created_at wins. Deterministic tie-break by ID.
      if (
        ev.created_at > existing.created_at ||
        (ev.created_at === existing.created_at && ev.id < existing.id)
      ) {
        grouped.set(key, ev);
      }
    }
  }

  return Array.from(grouped.values());
}

