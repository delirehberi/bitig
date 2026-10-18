import type { StorageMode } from "@bitig/core";
import { useMemo, type ReactNode } from "react";
import { FeatureFlagsContext, featuresFor } from "./features";

interface FeatureFlagsProviderProps {
  readonly mode: StorageMode;
  readonly children: ReactNode;
}

export function FeatureFlagsProvider({ mode, children }: FeatureFlagsProviderProps) {
  const flags = useMemo(() => featuresFor(mode), [mode]);
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}
