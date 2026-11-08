import type { AgentRun, AgentRunState, RealtimeEvent, Task } from "@bitig/core";
import type { NotificationIntent, NotificationTrigger } from "./notifications";

/** How a notification names a task: its ticket code (or ID) and title. */
export interface TaskLabel {
  readonly ref: string;
  readonly title: string;
}

export interface TriggerLabels {
  readonly forTask: (task: Task) => TaskLabel;
  /** Agent runs carry only a task ID; undefined when the task is not loaded. */
  readonly forTaskId: (taskId: string) => TaskLabel | undefined;
}

type AttentionRunState = Extract<AgentRunState, "waiting_for_approval" | "finished" | "failed" | "stopped">;

const RUN_REASONS: Readonly<Record<AttentionRunState, string>> = {
  waiting_for_approval: "Agent is waiting for your approval",
  finished: "Agent run finished",
  failed: "Agent run failed",
  stopped: "Agent run stopped",
};

function isAttentionRunState(state: AgentRunState): state is AttentionRunState {
  return Object.hasOwn(RUN_REASONS, state);
}

const TAG_PREFIX = "bitig";
const TASK_COMPLETED_REASON = "Task completed";
const AWAITING_APPROVAL_REASON = "Task is awaiting your approval";
const NEEDS_HUMAN_REASON = "Needs your input";
const UNKNOWN_TASK_TITLE = "Task";

interface Signal {
  readonly tag: string;
  readonly trigger: NotificationTrigger;
  readonly reason: string;
}

function taskSignals(task: Task): Signal[] {
  const prefix = `${TAG_PREFIX}:task:${task.id}`;
  const signals: Signal[] = [];
  if (task.status === "done") {
    signals.push({ tag: `${prefix}:done`, trigger: "taskCompleted", reason: TASK_COMPLETED_REASON });
  }
  if (task.needsHuman !== undefined && task.needsHuman.trim() !== "") {
    // Keyed without the text: rewording an open request is not a new event.
    signals.push({ tag: `${prefix}:needs-human`, trigger: "needsHuman", reason: `${NEEDS_HUMAN_REASON}: ${task.needsHuman}` });
  }
  if (task.pendingApproval === true) {
    signals.push({ tag: `${prefix}:approval`, trigger: "awaitingApproval", reason: AWAITING_APPROVAL_REASON });
  }
  return signals;
}

function runSignals(run: AgentRun): Signal[] {
  if (!isAttentionRunState(run.state)) return [];
  return [{ tag: `${TAG_PREFIX}:run:${run.id}:${run.state}`, trigger: "agentRun", reason: RUN_REASONS[run.state] }];
}

function intentTitle(label: TaskLabel): string {
  return `${label.ref} · ${label.title}`;
}

/**
 * Turns realtime events into notifications only on meaningful transitions (#BIT-169).
 *
 * Each task or run is an entity whose currently active signals (done, needs a human, awaiting
 * approval, run waiting/ended) are remembered by tag. A signal is announced once when it becomes
 * active and forgotten when it clears, so a task reopened and completed again notifies again,
 * while repeated deliveries of the same state (a local dispatch echoed by the server, unrelated
 * edits to a done task) stay quiet. `observeTasks`/`observeRuns` record loaded state silently, so
 * existing state and this tab's own mutations never notify.
 */
export class NotificationTracker {
  private readonly active = new Map<string, ReadonlySet<string>>();

  /** Records loaded tasks as the baseline without announcing anything. */
  observeTasks(tasks: readonly Task[]): void {
    for (const task of tasks) this.reconcile(`task:${task.id}`, taskSignals(task));
  }

  /** Records loaded agent runs as the baseline without announcing anything. */
  observeRuns(runs: readonly AgentRun[]): void {
    for (const run of runs) this.reconcile(`run:${run.id}`, runSignals(run));
  }

  /** Returns the notifications an event should raise; empty when it is not a new transition. */
  handleEvent(event: RealtimeEvent, labels: TriggerLabels): NotificationIntent[] {
    switch (event.type) {
      case "task.created": {
        // A task created as done did not transition to done; only open requests announce.
        const fresh = this.reconcile(`task:${event.task.id}`, taskSignals(event.task));
        const label = labels.forTask(event.task);
        return fresh.filter((signal) => signal.trigger !== "taskCompleted").map((signal) => toIntent(signal, label));
      }
      case "task.updated": {
        const label = labels.forTask(event.task);
        return this.reconcile(`task:${event.task.id}`, taskSignals(event.task)).map((signal) => toIntent(signal, label));
      }
      case "task.deleted":
        this.active.delete(`task:${event.id}`);
        return [];
      case "agent_run.updated": {
        const label = labels.forTaskId(event.run.taskId) ?? { ref: event.run.taskId, title: UNKNOWN_TASK_TITLE };
        return this.reconcile(`run:${event.run.id}`, runSignals(event.run)).map((signal) => toIntent(signal, label));
      }
      default:
        return [];
    }
  }

  /** Replaces an entity's active signals and returns the ones that were not active before. */
  private reconcile(entity: string, signals: readonly Signal[]): Signal[] {
    const previous = this.active.get(entity);
    const fresh = signals.filter((signal) => previous?.has(signal.tag) !== true);
    if (signals.length === 0) this.active.delete(entity);
    else this.active.set(entity, new Set(signals.map((signal) => signal.tag)));
    return fresh;
  }
}

function toIntent(signal: Signal, label: TaskLabel): NotificationIntent {
  return {
    tag: signal.tag,
    trigger: signal.trigger,
    title: intentTitle(label),
    body: signal.reason,
    taskRef: label.ref,
  };
}
