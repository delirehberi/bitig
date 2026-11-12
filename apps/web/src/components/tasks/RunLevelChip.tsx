import { Gauge } from "lucide-react";
import type { RunLevel, TaskRunProfile } from "@bitig/core";
import { levelLabel, RUN_PROFILE_SOURCE_LABELS } from "./run-profile-labels";

interface RunLevelChipProps {
  readonly profile: Pick<TaskRunProfile, "level" | "source" | "reason"> | null | undefined;
  readonly levels: readonly RunLevel[];
}

/** A task's run level with who set it; the reason shows on hover (#BIT-188). Renders nothing without a level. */
export function RunLevelChip({ profile, levels }: RunLevelChipProps) {
  if (!profile?.level) return null;
  const source = RUN_PROFILE_SOURCE_LABELS[profile.source];
  const label = levelLabel(levels, profile.level);
  const title = profile.reason
    ? `Level ${label}, set by ${source}: ${profile.reason}`
    : `Level ${label}, set by ${source}`;
  return (
    <span
      data-testid="run-level-chip"
      title={title}
      className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink-2"
    >
      <Gauge size={11} aria-hidden="true" />
      <span>{label}</span>
      <span className="font-normal text-ink-3">· {source}</span>
    </span>
  );
}
