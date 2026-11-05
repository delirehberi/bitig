import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { describe, expect, it } from "vitest";
import { InMemoryUserStore } from "@bitig/core";
import {
  createNostrProfileFetcher,
  emptyFieldPatch,
  nostrPlaceholderDisplayName,
  syncNostrProfile,
  type NostrProfile,
  type NostrProfileFetcher,
  nostrPubkeyForUser,
  parseMetadataContent,
  verifyNip05,
  type RelayClient,
  type RelayFilter,
  workersRelayClient,
} from "../src/nostr-profile";
import { TEST_NOSTR_PROFILE_RELAY } from "./constants";

const SECRET_KEY = new Uint8Array(32).fill(9);
const PUBKEY = getPublicKey(SECRET_KEY);
const OTHER_SECRET_KEY = new Uint8Array(32).fill(10);
const RELAY_A = "wss://relay-a.test";
const RELAY_B = "wss://relay-b.test";

function metadataEvent(content: Record<string, unknown> | string, createdAt: number, secretKey = SECRET_KEY) {
  return finalizeEvent(
    {
      kind: 0,
      created_at: createdAt,
      tags: [],
      content: typeof content === "string" ? content : JSON.stringify(content),
    },
    secretKey,
  );
}

function fakeRelays(byRelay: Record<string, unknown[] | Error>): RelayClient & { filters: RelayFilter[] } {
  const filters: RelayFilter[] = [];
  return {
    filters,
    query(relayUrl, filter) {
      filters.push(filter);
      const result = byRelay[relayUrl];
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result ?? []);
    },
  };
}

function nip05Fetch(names: Record<string, string>, status = 200): typeof fetch & { urls: string[] } {
  const urls: string[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit) => {
    urls.push(typeof input === "string" ? input : input instanceof Request ? input.url : input.toString());
    expect(init?.redirect).toBe("manual");
    return Promise.resolve(new Response(JSON.stringify({ names }), { status }));
  };
  return Object.assign(impl, { urls });
}

describe("nostrPubkeyForUser", () => {
  it("extracts the hex key from a Nostr account email only", () => {
    expect(nostrPubkeyForUser({ email: `${PUBKEY}@nostr.local` })).toBe(PUBKEY);
    expect(nostrPubkeyForUser({ email: "alice@example.com" })).toBeNull();
    expect(nostrPubkeyForUser({ email: "not-hex@nostr.local" })).toBeNull();
  });
});

describe("parseMetadataContent", () => {
  it("prefers display_name, sanitizes names, and keeps only https pictures", () => {
    expect(
      parseMetadataContent(
        JSON.stringify({
          name: "alice",
          display_name: "  Alice‮\u0007 Wonder  ",
          picture: "https://cdn.test/a.png",
          nip05: "Alice@Example.com",
        }),
      ),
    ).toEqual({ displayName: "Alice Wonder", avatarUrl: "https://cdn.test/a.png", nip05Claim: "alice@example.com" });

    expect(parseMetadataContent(JSON.stringify({ name: "bob", picture: "http://cdn.test/b.png" }))).toEqual({
      displayName: "bob",
    });
    expect(parseMetadataContent(JSON.stringify({ picture: "javascript:alert(1)", nip05: "bad" }))).toEqual({});
    expect(parseMetadataContent(JSON.stringify({ name: "x".repeat(500) }))?.displayName).toHaveLength(120);
  });

  it("returns null for invalid or non-object JSON", () => {
    expect(parseMetadataContent("{not json")).toBeNull();
    expect(parseMetadataContent("[]")).toBeNull();
  });
});

describe("verifyNip05", () => {
  const signal = AbortSignal.timeout(1_000);

  it("accepts a matching mapping and requests the well-known URL", async () => {
    const fetchImpl = nip05Fetch({ alice: PUBKEY });
    expect(await verifyNip05("alice@example.com", PUBKEY, fetchImpl, signal)).toBe(true);
    expect(fetchImpl.urls).toEqual(["https://example.com/.well-known/nostr.json?name=alice"]);
  });

  it("rejects mismatched keys, missing names, non-200 answers, and network errors", async () => {
    expect(await verifyNip05("alice@example.com", PUBKEY, nip05Fetch({ alice: "f".repeat(64) }), signal)).toBe(false);
    expect(await verifyNip05("alice@example.com", PUBKEY, nip05Fetch({}), signal)).toBe(false);
    expect(await verifyNip05("alice@example.com", PUBKEY, nip05Fetch({ alice: PUBKEY }, 302), signal)).toBe(false);
    const failing = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    expect(await verifyNip05("alice@example.com", PUBKEY, failing, signal)).toBe(false);
    expect(await verifyNip05("no-at-sign", PUBKEY, nip05Fetch({}), signal)).toBe(false);
  });
});

describe("createNostrProfileFetcher", () => {
  it("uses the newest validly signed kind-0 event across relays and verifies its NIP-05", async () => {
    const older = metadataEvent({ name: "Old Name", picture: "https://cdn.test/old.png" }, 100);
    const newer = metadataEvent({ name: "New Name", picture: "https://cdn.test/new.png", nip05: "me@example.com" }, 200);
    const forged = { ...metadataEvent({ name: "Forged" }, 300, OTHER_SECRET_KEY), pubkey: PUBKEY };
    const relays = fakeRelays({ [RELAY_A]: [older, forged, "garbage"], [RELAY_B]: [newer] });
    const fetcher = createNostrProfileFetcher({
      relays: [RELAY_A, RELAY_B],
      relayClient: relays,
      fetch: nip05Fetch({ me: PUBKEY }),
    });

    expect(await fetcher.fetchProfile(PUBKEY)).toEqual({
      displayName: "New Name",
      avatarUrl: "https://cdn.test/new.png",
      nip05: "me@example.com",
    });
    expect(relays.filters[0]).toEqual({ kinds: [0], authors: [PUBKEY], limit: 1 });
  });

  it("drops an unverified NIP-05 claim but keeps the other fields", async () => {
    const event = metadataEvent({ name: "Carol", nip05: "carol@example.com" }, 100);
    const fetcher = createNostrProfileFetcher({
      relays: [RELAY_A],
      relayClient: fakeRelays({ [RELAY_A]: [event] }),
      fetch: nip05Fetch({ carol: "e".repeat(64) }),
    });
    expect(await fetcher.fetchProfile(PUBKEY)).toEqual({ displayName: "Carol" });
  });

  it("returns null when relays fail, return nothing, or the key is invalid", async () => {
    const fetcher = createNostrProfileFetcher({
      relays: [RELAY_A, RELAY_B],
      relayClient: fakeRelays({ [RELAY_A]: new Error("connection refused"), [RELAY_B]: [] }),
      fetch: nip05Fetch({}),
    });
    expect(await fetcher.fetchProfile(PUBKEY)).toBeNull();
    expect(await fetcher.fetchProfile("not-a-key")).toBeNull();
  });

  it("passes an abort signal that fires on timeout", async () => {
    const seen: AbortSignal[] = [];
    const hanging: RelayClient = {
      query(_relay, _filter, signal) {
        seen.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => {
            resolve([]);
          });
        });
      },
    };
    const fetcher = createNostrProfileFetcher({ relays: [RELAY_A], relayClient: hanging, timeoutMs: 20 });
    expect(await fetcher.fetchProfile(PUBKEY)).toBeNull();
    expect(seen[0]?.aborted).toBe(true);
  });
});

function staticFetcher(profile: NostrProfile | null): NostrProfileFetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetchProfile(pubkey) {
      calls.push(pubkey);
      return Promise.resolve(profile);
    },
  };
}

const FULL_PROFILE: NostrProfile = {
  displayName: "Alice",
  avatarUrl: "https://cdn.test/alice.png",
  nip05: "alice@example.com",
};

async function nostrUser(store: InMemoryUserStore, overrides: { displayName?: string; avatarUrl?: string; nip05?: string } = {}) {
  return store.create({
    email: `${PUBKEY}@nostr.local`,
    username: `nostr-${PUBKEY.slice(0, 16)}`,
    displayName: overrides.displayName ?? nostrPlaceholderDisplayName(PUBKEY),
    ...(overrides.avatarUrl !== undefined ? { avatarUrl: overrides.avatarUrl } : {}),
    ...(overrides.nip05 !== undefined ? { nip05: overrides.nip05 } : {}),
  });
}

describe("emptyFieldPatch", () => {
  it("fills the placeholder name, a missing avatar, and a missing NIP-05", async () => {
    const user = await nostrUser(new InMemoryUserStore());
    expect(emptyFieldPatch(user, PUBKEY, FULL_PROFILE)).toEqual({
      patch: FULL_PROFILE,
      fields: ["displayName", "avatarUrl", "nip05"],
    });
  });

  it("never replaces values the user already has", async () => {
    const user = await nostrUser(new InMemoryUserStore(), {
      displayName: "Chosen Name",
      avatarUrl: "https://cdn.test/mine.png",
      nip05: "me@mine.test",
    });
    expect(emptyFieldPatch(user, PUBKEY, FULL_PROFILE)).toEqual({ patch: {}, fields: [] });
  });
});

describe("syncNostrProfile", () => {
  it("stores only the empty fields and reports them", async () => {
    const store = new InMemoryUserStore();
    const user = await nostrUser(store, { avatarUrl: "https://cdn.test/mine.png" });
    const result = await syncNostrProfile(store, user, staticFetcher(FULL_PROFILE));
    expect(result.found).toBe(true);
    expect(result.updated).toEqual(["displayName", "nip05"]);
    expect(result.user.displayName).toBe("Alice");
    expect(result.user.avatarUrl).toBe("https://cdn.test/mine.png");
    expect((await store.getById(user.id))?.nip05).toBe("alice@example.com");
  });

  it("does not overwrite an edit saved while the profile was being fetched", async () => {
    const store = new InMemoryUserStore();
    const user = await nostrUser(store);
    await store.update(user.id, { displayName: "Edited Meanwhile" });
    const result = await syncNostrProfile(store, user, staticFetcher(FULL_PROFILE));
    expect(result.user.displayName).toBe("Edited Meanwhile");
    expect(result.updated).toEqual(["avatarUrl", "nip05"]);
  });

  it("skips non-Nostr accounts and reports a missing profile", async () => {
    const store = new InMemoryUserStore();
    const emailUser = await store.create({ email: "bob@example.com", username: "bob", displayName: "Bob" });
    const fetcher = staticFetcher(FULL_PROFILE);
    expect(await syncNostrProfile(store, emailUser, fetcher)).toEqual({ user: emailUser, found: false, updated: [] });
    expect(fetcher.calls).toEqual([]);

    const user = await nostrUser(store);
    expect(await syncNostrProfile(store, user, staticFetcher(null))).toEqual({ user, found: false, updated: [] });
  });
});

describe("workersRelayClient", () => {
  it("rejects when the relay refuses the connection", async () => {
    await expect(
      workersRelayClient.query(
        TEST_NOSTR_PROFILE_RELAY,
        { kinds: [0], authors: [PUBKEY], limit: 1 },
        AbortSignal.timeout(2_000),
      ),
    ).rejects.toThrow();
  });
});
