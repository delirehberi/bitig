import { SimplePool } from "nostr-tools/pool";
import type { Filter } from "nostr-tools/filter";
import type { Event, VerifiedEvent } from "nostr-tools/pure";
import { NOSTR_KIND_DELETE } from "../kinds";
import { buildTombstoneSet, resolveReplaceableEvents, type TombstoneSet } from "./tombstones";

export interface RelayManagerOptions {
  relays: readonly string[];
  pool?: SimplePool;
}

export const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
] as const;

export class RelayManager {
  private readonly relays: string[];
  private readonly pool: SimplePool;
  private readonly ownPool: boolean;

  constructor(options?: RelayManagerOptions) {
    this.relays =
      options?.relays && options.relays.length > 0 ? [...options.relays] : [...DEFAULT_RELAYS];
    if (this.relays.length === 0) {
      throw new Error("RelayManager requires at least one relay URL");
    }
    if (options?.pool) {
      this.pool = options.pool;
      this.ownPool = false;
    } else {
      this.pool = new SimplePool();
      this.ownPool = true;
    }
  }

  getRelays(): readonly string[] {
    return [...this.relays];
  }

  /**
   * Publishes a signed event to all configured relays.
   * Resolves as soon as at least 1 relay confirms publication.
   */
  async publishEvent(event: VerifiedEvent): Promise<void> {
    if (this.relays.length === 0) {
      throw new Error("No relays configured for publishing");
    }

    const publishPromises = this.pool.publish(this.relays, event);
    try {
      await Promise.any(publishPromises);
    } catch (aggregateError) {
      const errs = aggregateError instanceof AggregateError ? aggregateError.errors : [aggregateError];
      throw new Error(`Failed to publish event to any relay: ${errs.map(String).join(", ")}`, {
        cause: aggregateError,
      });
    }
  }

  /**
   * Queries raw events matching filter from all configured relays until EOSE.
   */
  async queryEvents(filter: Filter): Promise<Event[]> {
    if (this.relays.length === 0) return [];
    const events = await this.pool.querySync(this.relays, filter);
    return events;
  }

  /**
   * Fetches all Kind 5 deletion events authored by pubkey.
   */
  async fetchTombstones(pubkey: string): Promise<TombstoneSet> {
    const deletionEvents = await this.queryEvents({
      kinds: [NOSTR_KIND_DELETE],
      authors: [pubkey],
    });
    return buildTombstoneSet(deletionEvents);
  }

  /**
   * Queries parameterized replaceable events and resolves latest versions (LWW),
   * excluding any tombstones.
   */
  async queryReplaceable(filter: Filter, authorPubkey: string): Promise<Event[]> {
    const [events, tombstones] = await Promise.all([
      this.queryEvents(filter),
      this.fetchTombstones(authorPubkey),
    ]);
    return resolveReplaceableEvents(events, tombstones);
  }

  close(): void {
    if (this.ownPool) {
      this.pool.close(this.relays);
    }
  }
}
