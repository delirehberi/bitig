import type { StorageMode } from "@bitig/core";
import { createContext } from "react";

/**
 * UI capabilities that only make sense for some storage backends. The mode is
 * fixed per deployment, so these flags are derived from it rather than toggled.
 */
export interface FeatureFlags {
  /** Public/private task visibility: Nostr publishes public tasks and NIP-44 encrypts the rest. */
  readonly taskVisibility: boolean;
  /** Basic Auth sign-in against the Worker's REST API. */
  readonly basicAuthLogin: boolean;
}

export function featuresFor(mode: StorageMode): FeatureFlags {
  return {
    taskVisibility: mode === "nostr",
    basicAuthLogin: mode === "cloudflare",
  };
}

export const FeatureFlagsContext = createContext<FeatureFlags | null>(null);
