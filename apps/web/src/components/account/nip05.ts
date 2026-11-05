const NIP05_ROOT_PREFIX = "_@";

/** NIP-05 shows the root identifier `_@domain` as just the domain. */
export function formatNip05(identifier: string): string {
  return identifier.startsWith(NIP05_ROOT_PREFIX) ? identifier.slice(NIP05_ROOT_PREFIX.length) : identifier;
}
