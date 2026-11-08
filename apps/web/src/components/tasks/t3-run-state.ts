import type { AgentRun, AgentRunState, T3ModelCapability } from "@bitig/core";

/** The task's T3 thread, when it has one, so a reply can switch the thread's model (#BIT-119). */
export interface TaskCommentsT3Context {
  readonly run: AgentRun;
  readonly capabilities: readonly T3ModelCapability[];
}

/** Picks a human-friendly agent label (e.g. "Codex", "Claude") from the T3 run and capability list. */
export function agentNameForT3(
  t3: TaskCommentsT3Context | undefined,
  fallbackAuthor?: string,
): string {
  if (t3) {
    const { run, capabilities } = t3;
    const byProvider = run.providerInstanceId
      ? capabilities.find((c) => c.providerInstanceId === run.providerInstanceId)
      : undefined;
    if (byProvider?.displayName) return byProvider.displayName;
    const byModel = run.model ? capabilities.find((c) => c.model === run.model) : undefined;
    if (byModel?.displayName) return byModel.displayName;
    const prov = run.providerInstanceId?.toLowerCase();
    if (prov?.includes("codex")) return "Codex";
    if (prov?.includes("claude")) return "Claude";
    if (prov?.includes("antigravity") || prov?.includes("gemini")) return "Antigravity";
    const model = run.model?.toLowerCase();
    if (model?.startsWith("gpt-") || model?.startsWith("o1") || model?.startsWith("o3") || model?.includes("codex")) {
      return "Codex";
    }
    if (model?.startsWith("claude")) return "Claude";
    if (model?.startsWith("gemini")) return "Antigravity";
    if (run.providerInstanceId) {
      return run.providerInstanceId.charAt(0).toUpperCase() + run.providerInstanceId.slice(1);
    }
  }
  if (fallbackAuthor && fallbackAuthor.trim().length > 0) {
    return fallbackAuthor;
  }
  return "Agent";
}

/** Display labels and badge styles for T3 thread states, shared by task and project T3 panels. */
export const STATE_LABELS: Record<AgentRunState, string> = {
  queued: "queued",
  working: "working",
  waiting_for_approval: "waiting for approval",
  waiting_subagent: "waiting for subagent",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
  offline: "offline",
};

export const STATE_BADGE_CLASSES: Record<AgentRunState, string> = {
  queued: "border-accent/40 bg-accent-soft text-accent-ink",
  working: "border-accent/40 bg-accent-soft text-accent-ink",
  waiting_for_approval: "border-danger/40 bg-danger-soft text-danger",
  waiting_subagent: "border-accent/40 bg-accent-soft text-accent-ink",
  finished: "border-rule bg-paper-2 text-ink-2",
  failed: "border-danger/40 bg-danger-soft text-danger",
  stopped: "border-rule bg-paper-3 text-ink-3",
  offline: "border-rule bg-paper-3 text-ink-3",
};

