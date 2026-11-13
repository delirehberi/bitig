import type { StorageMode } from "@bitig/core";
import { createContext } from "react";

/**
 * UI capabilities that only make sense for some storage backends. The mode is
 * fixed per deployment, so these flags are derived from it rather than toggled.
 */
export interface FeatureFlags {
  /** Dashboard sign-in on /login, backed by the Worker's session cookie. */
  readonly passwordLogin: boolean;
  /** Live WebSocket updates from the Worker's RealtimeHub Durable Object (/api/realtime). */
  readonly realtimeSync: boolean;
  /** Project Feedback tab for managing public feedback forms (the Worker's /api/feedback-forms routes). */
  readonly feedbackForms: boolean;
}

export function featuresFor(mode: StorageMode): FeatureFlags {
  return {
    passwordLogin: mode === "cloudflare",
    realtimeSync: mode === "cloudflare",
    feedbackForms: mode === "cloudflare",
  };
}

export const FeatureFlagsContext = createContext<FeatureFlags | null>(null);
