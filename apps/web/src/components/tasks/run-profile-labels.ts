import type { ResolvedRunSelection, RunLevel, RunProfileSource } from "@bitig/core";

/** Who set a task's run profile, as people read it (#BIT-188). */
export const RUN_PROFILE_SOURCE_LABELS: Record<RunProfileSource, string> = {
  manual: "you",
  agent: "agent",
  router: "router",
};

export function levelLabel(levels: readonly RunLevel[], key: string): string {
  return levels.find((level) => level.key === key)?.label ?? key;
}

/** Explains where the Start in T3 picker's preselected model came from. */
export function describeResolvedSelection(resolved: ResolvedRunSelection, levels: readonly RunLevel[]): string {
  const level = resolved.levelKey ? levelLabel(levels, resolved.levelKey) : undefined;
  const by = resolved.profileSource ? ` (set by ${RUN_PROFILE_SOURCE_LABELS[resolved.profileSource]})` : "";
  switch (resolved.source) {
    case "explicit":
      return "Model picked for this run";
    case "explicit_level":
      return level ? `From level ${level}` : "From the requested level";
    case "profile_override":
      return `From the task's model override${by}`;
    case "profile_level":
      return level ? `From the task's level ${level}${by}` : `From the task's level${by}`;
    case "project_default_level":
      return level ? `From the project's default level ${level}` : "From the project's default level";
    case "default":
      return "No level applies: T3 picks its default model";
  }
}
