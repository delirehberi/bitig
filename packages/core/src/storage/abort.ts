/**
 * The subset of the web-standard `AbortSignal` that core relies on. `core`
 * compiles without DOM, Node or Workers type libraries so it stays
 * environment-neutral; a structural type lets every runtime's `AbortSignal`
 * (browser, Node, Cloudflare Workers) be passed without cross-lib mismatches.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
}

/**
 * Rejects early when the caller has already cancelled. `throwIfAborted`
 * throws `signal.reason` (a `DOMException` named `AbortError` by default).
 */
export function throwIfAborted(signal: AbortSignalLike | undefined): void {
  signal?.throwIfAborted();
}

