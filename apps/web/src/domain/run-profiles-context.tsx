import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { RunLevel } from "@bitig/core";
import { fetchRunProfiles, type StoredRunProfile } from "../services/run-orchestration";
import { RunProfilesContext, type RunProfilesValue } from "./run-profiles";

interface RunProfilesProviderProps {
  /** False (local mode) skips the request; chips then stay hidden. */
  readonly enabled: boolean;
  /** Changing it (e.g. switching organisation) reloads the profiles. */
  readonly scopeKey?: string | undefined;
  readonly children: ReactNode;
}

/** Loads every task run profile in the organisation once, so cards need no request each (#BIT-188). */
export function RunProfilesProvider({ enabled, scopeKey, children }: RunProfilesProviderProps) {
  const [profiles, setProfiles] = useState<ReadonlyMap<string, StoredRunProfile>>(new Map());
  const [levels, setLevelsState] = useState<readonly RunLevel[]>([]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchRunProfiles(controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setProfiles(new Map(res.profiles.map((p) => [p.taskId, p])));
        setLevelsState(res.levels);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Chips are an extra: a failure only hides them.
        console.warn("Could not load task run profiles", err);
      });
    return () => {
      controller.abort();
    };
  }, [enabled, scopeKey]);

  const setProfile = useCallback((taskId: string, profile: StoredRunProfile | null) => {
    setProfiles((prev) => {
      const next = new Map(prev);
      if (profile) next.set(taskId, profile);
      else next.delete(taskId);
      return next;
    });
  }, []);

  const setLevels = useCallback((next: readonly RunLevel[]) => {
    setLevelsState(next);
  }, []);

  const value = useMemo<RunProfilesValue>(
    () => ({
      levels,
      profileFor: (taskId) => profiles.get(taskId),
      setProfile,
      setLevels,
    }),
    [levels, profiles, setProfile, setLevels],
  );

  return <RunProfilesContext.Provider value={value}>{children}</RunProfilesContext.Provider>;
}
