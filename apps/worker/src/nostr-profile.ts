import { verifyEvent, type Event } from "nostr-tools/pure";
import {
  AvatarUrlSchema,
  DISPLAY_NAME_MAX,
  DisplayNameSchema,
  Nip05Schema,
  type UpdateUserInput,
  type User,
  type UserStore,
} from "@bitig/core";

/** Nostr accounts are stored with a synthetic email `<hex pubkey>@nostr.local`. */
export const NOSTR_EMAIL_SUFFIX = "@nostr.local";

/** Public relays that index kind-0 profile metadata; NOSTR_PROFILE_RELAYS overrides them. */
export const DEFAULT_PROFILE_RELAYS: readonly string[] = [
  "wss://purplepag.es",
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.primal.net",
];

/** Overall budget for one profile lookup (relays plus NIP-05 verification). */
export const PROFILE_FETCH_TIMEOUT_MS = 5_000;

const METADATA_KIND = 0;
const HEX_PUBKEY = /^[0-9a-f]{64}$/;
const MAX_EVENTS_PER_RELAY = 10;
const MAX_METADATA_CONTENT_CHARS = 64 * 1024;
const MAX_NIP05_RESPONSE_CHARS = 64 * 1024;
const HTTP_OK = 200;
const WS_NORMAL_CLOSURE = 1000;
const SUBSCRIPTION_ID_CHARS = 12;
// C0/C1 control characters and bidi overrides have no place in a display name.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

export interface RelayFilter {
  readonly kinds: readonly number[];
  readonly authors: readonly string[];
  readonly limit: number;
}

/** Sends one REQ to a relay and resolves with the events it returned before EOSE, close, or abort. */
export interface RelayClient {
  query(relayUrl: string, filter: RelayFilter, signal: AbortSignal): Promise<unknown[]>;
}

/** Profile fields taken from a verified kind-0 event; `nip05` is present only when it resolves to the same key. */
export interface NostrProfile {
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly nip05?: string;
}

export interface NostrProfileFetcher {
  fetchProfile(pubkey: string, signal?: AbortSignal): Promise<NostrProfile | null>;
}

export interface NostrProfileFetcherOptions {
  readonly relays?: readonly string[];
  readonly relayClient?: RelayClient;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

const PLACEHOLDER_NAME_PUBKEY_CHARS = 8;

/** The display name a new Nostr account gets until its profile metadata fills it in. */
export function nostrPlaceholderDisplayName(pubkey: string): string {
  return `Nostr (${pubkey.slice(0, PLACEHOLDER_NAME_PUBKEY_CHARS)})`;
}

export function nostrPubkeyForUser(user: Pick<User, "email">): string | null {
  if (!user.email.endsWith(NOSTR_EMAIL_SUFFIX)) return null;
  const pubkey = user.email.slice(0, -NOSTR_EMAIL_SUFFIX.length);
  return HEX_PUBKEY.test(pubkey) ? pubkey : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMetadataEventFor(value: unknown, pubkey: string): value is Event {
  if (!isRecord(value)) return false;
  if (value.kind !== METADATA_KIND || value.pubkey !== pubkey) return false;
  if (typeof value.content !== "string" || value.content.length > MAX_METADATA_CONTENT_CHARS) return false;
  if (typeof value.created_at !== "number" || !Array.isArray(value.tags)) return false;
  if (typeof value.id !== "string" || typeof value.sig !== "string") return false;
  // Relays are untrusted: only a valid signature by the account's own key counts. Verify a
  // fresh copy because nostr-tools caches a "verified" symbol on the object it is given.
  const copy: Event = {
    id: value.id,
    pubkey: value.pubkey,
    created_at: value.created_at,
    kind: value.kind,
    tags: value.tags as string[][],
    content: value.content,
    sig: value.sig,
  };
  return verifyEvent(copy);
}

function sanitizeDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(UNSAFE_NAME_CHARS, "").trim().slice(0, DISPLAY_NAME_MAX).trim();
  const parsed = DisplayNameSchema.safeParse(cleaned);
  return parsed.success ? parsed.data : undefined;
}

function sanitizeAvatarUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const parsed = AvatarUrlSchema.safeParse(raw.trim());
  // Plain http images would be mixed content on the HTTPS dashboard.
  return parsed.success && parsed.data.startsWith("https://") ? parsed.data : undefined;
}

interface ParsedMetadata {
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly nip05Claim?: string;
}

/** Reads the NIP-01/NIP-24 metadata fields we use from an event's JSON content. */
export function parseMetadataContent(content: string): ParsedMetadata | null {
  let body: unknown;
  try {
    body = JSON.parse(content);
  } catch (error) {
    console.warn("ignoring kind-0 event with invalid JSON content", { error });
    return null;
  }
  if (!isRecord(body)) return null;
  const displayName =
    sanitizeDisplayName(body.display_name) ??
    sanitizeDisplayName(body.displayName) ??
    sanitizeDisplayName(body.name);
  const avatarUrl = sanitizeAvatarUrl(body.picture);
  const nip05 = typeof body.nip05 === "string" ? Nip05Schema.safeParse(body.nip05) : undefined;
  return {
    ...(displayName !== undefined ? { displayName } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(nip05?.success ? { nip05Claim: nip05.data } : {}),
  };
}

/**
 * Checks a NIP-05 identifier against `https://<domain>/.well-known/nostr.json?name=<local>`.
 * Redirects are not followed, as NIP-05 requires.
 */
export async function verifyNip05(
  identifier: string,
  pubkey: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
): Promise<boolean> {
  const parsed = Nip05Schema.safeParse(identifier);
  if (!parsed.success) return false;
  const at = parsed.data.lastIndexOf("@");
  const local = parsed.data.slice(0, at);
  const domain = parsed.data.slice(at + 1);
  const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`;
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/json" },
      redirect: "manual",
      signal,
    });
    if (response.status !== HTTP_OK) return false;
    const text = await response.text();
    if (text.length > MAX_NIP05_RESPONSE_CHARS) return false;
    const body: unknown = JSON.parse(text);
    if (!isRecord(body) || !isRecord(body.names)) return false;
    const mapped = body.names[local];
    return typeof mapped === "string" && mapped.toLowerCase() === pubkey;
  } catch (error) {
    console.warn("NIP-05 verification failed", { identifier, error });
    return false;
  }
}

/** Opens a relay WebSocket via the Workers fetch-upgrade API and runs a single subscription. */
export const workersRelayClient: RelayClient = {
  async query(relayUrl, filter, signal) {
    const upgradeUrl = relayUrl.replace(/^wss:/, "https:");
    const response = await fetch(upgradeUrl, { headers: { Upgrade: "websocket" }, signal });
    const socket = response.webSocket;
    if (!socket) throw new Error(`relay ${relayUrl} refused the WebSocket upgrade (HTTP ${String(response.status)})`);
    socket.accept();
    const subscriptionId = crypto.randomUUID().replaceAll("-", "").slice(0, SUBSCRIPTION_ID_CHARS);
    const events: unknown[] = [];

    return new Promise<unknown[]>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", finish);
        try {
          socket.close(WS_NORMAL_CLOSURE, "done");
        } catch (error) {
          console.warn("closing relay socket failed", { relayUrl, error });
        }
        resolve(events);
      };
      socket.addEventListener("message", (message) => {
        if (typeof message.data !== "string") return;
        let frame: unknown;
        try {
          frame = JSON.parse(message.data);
        } catch (error) {
          console.warn("ignoring malformed relay frame", { relayUrl, error });
          return;
        }
        if (!Array.isArray(frame) || frame[1] !== subscriptionId) return;
        if (frame[0] === "EVENT") {
          events.push(frame[2]);
          if (events.length >= MAX_EVENTS_PER_RELAY) finish();
        } else if (frame[0] === "EOSE" || frame[0] === "CLOSED") {
          finish();
        }
      });
      socket.addEventListener("close", finish);
      socket.addEventListener("error", (event) => {
        console.warn("relay socket error", { relayUrl, type: event.type });
        finish();
      });
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener("abort", finish);
      socket.send(JSON.stringify(["REQ", subscriptionId, filter]));
    });
  },
};

async function latestMetadataEvent(
  pubkey: string,
  relays: readonly string[],
  relayClient: RelayClient,
  signal: AbortSignal,
): Promise<Event | null> {
  const filter: RelayFilter = { kinds: [METADATA_KIND], authors: [pubkey], limit: 1 };
  const results = await Promise.allSettled(relays.map((relay) => relayClient.query(relay, filter, signal)));
  let latest: Event | null = null;
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.warn("relay profile query failed", { relay: relays[index], error: result.reason as unknown });
      continue;
    }
    for (const candidate of result.value) {
      if (!isMetadataEventFor(candidate, pubkey)) continue;
      if (latest === null || candidate.created_at > latest.created_at) latest = candidate;
    }
  }
  return latest;
}

export function createNostrProfileFetcher(options: NostrProfileFetcherOptions = {}): NostrProfileFetcher {
  const relays = options.relays && options.relays.length > 0 ? options.relays : DEFAULT_PROFILE_RELAYS;
  const relayClient = options.relayClient ?? workersRelayClient;
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? PROFILE_FETCH_TIMEOUT_MS;

  return {
    async fetchProfile(pubkey, signal) {
      if (!HEX_PUBKEY.test(pubkey)) return null;
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const event = await latestMetadataEvent(pubkey, relays, relayClient, combined);
      if (!event) return null;
      const metadata = parseMetadataContent(event.content);
      if (!metadata) return null;
      const claim = metadata.nip05Claim;
      const nip05 =
        claim !== undefined && (await verifyNip05(claim, pubkey, fetchImpl, combined)) ? claim : undefined;
      return {
        ...(metadata.displayName !== undefined ? { displayName: metadata.displayName } : {}),
        ...(metadata.avatarUrl !== undefined ? { avatarUrl: metadata.avatarUrl } : {}),
        ...(nip05 !== undefined ? { nip05 } : {}),
      };
    },
  };
}

export type NostrProfileField = "displayName" | "avatarUrl" | "nip05";

export interface NostrProfileSyncResult {
  readonly user: User;
  /** False when no relay returned a usable, validly signed profile. */
  readonly found: boolean;
  readonly updated: readonly NostrProfileField[];
}

/**
 * Builds a patch that only fills empty fields: the display name while it is still the generated
 * placeholder, and the avatar and NIP-05 while unset. Values the user chose are never replaced.
 */
export function emptyFieldPatch(
  user: User,
  pubkey: string,
  profile: NostrProfile,
): { patch: UpdateUserInput; fields: NostrProfileField[] } {
  const patch: { displayName?: string; avatarUrl?: string; nip05?: string } = {};
  const fields: NostrProfileField[] = [];
  if (profile.displayName !== undefined && user.displayName === nostrPlaceholderDisplayName(pubkey)) {
    patch.displayName = profile.displayName;
    fields.push("displayName");
  }
  if (profile.avatarUrl !== undefined && user.avatarUrl === undefined) {
    patch.avatarUrl = profile.avatarUrl;
    fields.push("avatarUrl");
  }
  if (profile.nip05 !== undefined && user.nip05 === undefined) {
    patch.nip05 = profile.nip05;
    fields.push("nip05");
  }
  return { patch, fields };
}

/** Fetches the account's Nostr profile and stores whatever fills its empty fields. */
export async function syncNostrProfile(
  userStore: UserStore,
  user: User,
  fetcher: NostrProfileFetcher,
  signal?: AbortSignal,
): Promise<NostrProfileSyncResult> {
  const pubkey = nostrPubkeyForUser(user);
  if (!pubkey) return { user, found: false, updated: [] };
  const profile = await fetcher.fetchProfile(pubkey, signal);
  if (!profile) return { user, found: false, updated: [] };
  // Re-read so an edit saved while relays were answering is not overwritten.
  const current = (await userStore.getById(user.id)) ?? user;
  const { patch, fields } = emptyFieldPatch(current, pubkey, profile);
  if (fields.length === 0) return { user: current, found: true, updated: [] };
  const updated = await userStore.update(current.id, patch);
  return { user: updated, found: true, updated: fields };
}
