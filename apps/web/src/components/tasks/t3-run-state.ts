import type { AgentRunState } from "@bitig/core";

/** Display labels and badge styles for T3 thread states, shared by task and project T3 panels. */
export const STATE_LABELS: Record<AgentRunState, string> = {
  working: "working",
  waiting_for_approval: "waiting for approval",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
  offline: "offline",
};

export const STATE_BADGE_CLASSES: Record<AgentRunState, string> = {
  working: "border-accent/40 bg-accent-soft text-accent-ink",
  waiting_for_approval: "border-danger/40 bg-danger-soft text-danger",
  finished: "border-rule bg-paper-2 text-ink-2",
  failed: "border-danger/40 bg-danger-soft text-danger",
  stopped: "border-rule bg-paper-3 text-ink-3",
  offline: "border-rule bg-paper-3 text-ink-3",
};
