import { createContext, useContext } from "react";
import type { RunLevel } from "@bitig/core";
import type { StoredRunProfile } from "../services/run-orchestration";

/** The organisation's task run profiles and levels, for level chips on cards and the task detail (#BIT-188). */
export interface RunProfilesValue {
  readonly levels: readonly RunLevel[];
  readonly profileFor: (taskId: string) => StoredRunProfile | undefined;
  /** Records a profile change made elsewhere (e.g. the task's T3 section) so every chip shows it at once. */
  readonly setProfile: (taskId: string, profile: StoredRunProfile | null) => void;
  readonly setLevels: (levels: readonly RunLevel[]) => void;
}

const NO_LEVELS: readonly RunLevel[] = [];

/** Without a provider (local mode, or tests) nothing is known and updates are dropped. */
export const EMPTY_RUN_PROFILES: RunProfilesValue = {
  levels: NO_LEVELS,
  profileFor: () => undefined,
  setProfile: () => undefined,
  setLevels: () => undefined,
};

export const RunProfilesContext = createContext<RunProfilesValue>(EMPTY_RUN_PROFILES);

export function useRunProfiles(): RunProfilesValue {
  return useContext(RunProfilesContext);
}
