import type { StorageMode } from "@bitig/core";
import { createContext } from "react";

/**
 * UI capabilities that only make sense for some storage backends. The mode is
 * fixed per deployment, so these flags are derived from it rather than toggled.
 */
export interface FeatureFlags {
  /** Public/private task visibility: Nostr publishes public tasks and NIP-44 encrypts the rest. */
  readonly taskVisibility: boolean;
  /** Password sign-in on /login, backed by the Worker's session cookie. */
  readonly passwordLogin: boolean;
}

export function featuresFor(mode: StorageMode): FeatureFlags {
  return {
    taskVisibility: mode === "nostr",
    passwordLogin: mode === "cloudflare",
  };
}

export const FeatureFlagsContext = createContext<FeatureFlags | null>(null);
