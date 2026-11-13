import { GitMerge } from "lucide-react";
import { formatUmbrellaProgress, type UmbrellaProgressSummary } from "@bitig/core";

export interface UmbrellaProgressBadgeProps {
  readonly progress: UmbrellaProgressSummary | undefined;
  readonly className?: string | undefined;
}

/**
 * Compact umbrella progress pill for board cards, list rows, and umbrella headers (#BIT-191),
 * e.g. `"2 of 5 running, 1 merged"`. Renders nothing when `progress` is absent or empty.
 */
export function UmbrellaProgressBadge({ progress, className = "" }: UmbrellaProgressBadgeProps) {
  if (!progress || progress.total === 0) {
    return null;
  }

  const label = formatUmbrellaProgress(progress);
  const allMerged = progress.merged === progress.total;
  const toneClass =
    progress.running > 0
      ? "border-accent/30 bg-accent-soft text-accent-ink"
      : allMerged
        ? "border-ok/30 bg-ok-soft text-ok"
        : "border-rule bg-paper-2 text-ink-2";

  return (
    <span
      data-testid="umbrella-progress-badge"
      title={`Umbrella children: ${label}`}
      className={`inline-flex items-center gap-1 rounded-pill border px-2 py-0.5 font-mono text-2xs font-semibold ${toneClass} ${className}`.trim()}
    >
      <GitMerge size={11} aria-hidden="true" className="shrink-0" />
      <span>{label}</span>
    </span>
  );
}
