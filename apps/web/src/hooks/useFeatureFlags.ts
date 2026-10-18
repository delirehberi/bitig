import { useContext } from "react";
import { FeatureFlagsContext, type FeatureFlags } from "../domain/features";

export function useFeatureFlags(): FeatureFlags {
  const flags = useContext(FeatureFlagsContext);
  if (!flags) {
    throw new Error("useFeatureFlags must be used within a FeatureFlagsProvider");
  }
  return flags;
}
