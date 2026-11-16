import { useEffect, useState } from "react";
import type { RunLevel } from "@bitig/core";
import { useRealtimeEvent } from "../../hooks/useRealtime";
import { useRunProfiles } from "../../domain/run-profiles";
import { Link } from "../../routing/Link";
import { taskHref } from "../../routing/router";
import {
  cancelWorkQueue,
  fetchWorkQueues,
  pauseWorkQueue,
  resumeWorkQueue,
  retryWorkQueueItem,
  skipWorkQueueItem,
  type WorkQueueEntryView,
  type WorkQueueView,
} from "../../services/work-queue";
import {
  applyEntryUpdate,
  applyQueueUpdate,
  applyRealtimeEvent,
  canRetryEntry,
  canSkipEntry,
  ENTRY_STATE_LABELS,
  laneProgress,
  nextLevelUp,
  QUEUE_STATE_LABELS,
  queueControls,
  queueTitle,
} from "./work-queue-model";

const CONTROL_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-rule bg-paper px-3 py-2 text-sm font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-50 focus-visible:outline-focus sm:min-h-0 sm:py-1 sm:text-2xs";
const DANGER_CLASS =
  "inline-flex min-h-11 items-center justify-center rounded-md border border-rule bg-paper px-3 py-2 text-sm font-semibold text-danger transition-colors hover:bg-paper-3 disabled:opacity-50 focus-visible:outline-focus sm:min-h-0 sm:py-1 sm:text-2xs";
const BADGE_CLASS = "rounded-pill bg-paper-3 px-2 py-0.5 font-mono text-xs font-semibold text-ink-2";

export interface WorkQueuePanelProps {
  /** False outside Cloudflare mode or without a connected T3 host: the panel stays hidden. */
  readonly enabled: boolean;
}

/** Keys of in-flight actions, so each button is disabled while its request runs. */
function actionKey(kind: "queue" | "item", id: string, action: string): string {
  return `${kind}:${id}:${action}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

interface ItemRowProps {
  readonly entry: WorkQueueEntryView;
  readonly levels: readonly RunLevel[];
  readonly pending: ReadonlySet<string>;
  readonly onSkip: (entry: WorkQueueEntryView) => void;
  readonly onRetry: (entry: WorkQueueEntryView, level?: string) => void;
}

function WorkQueueItemRow({ entry, levels, pending, onSkip, onRetry }: ItemRowProps) {
  const taskRef = entry.taskCode ?? entry.taskId;
  const busy = (action: string) => pending.has(actionKey("item", entry.id, action));
  const higher = nextLevelUp(levels, entry.resolvedSelection);
  const retryable = canRetryEntry(entry.state);

  return (
    <li className="flex flex-col gap-2 border-t border-rule pt-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={taskHref(taskRef)} className="font-mono text-sm font-semibold text-accent-ink hover:underline">
            {entry.taskCode ?? entry.taskId}
          </Link>
          {entry.taskTitle && <span className="min-w-0 break-words text-sm text-ink">{entry.taskTitle}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <span className={BADGE_CLASS}>{ENTRY_STATE_LABELS[entry.state]}</span>
          {entry.waitingReason && <span className="break-words">{entry.waitingReason}</span>}
          {entry.umbrellaTaskId && (
            <Link href={taskHref(entry.umbrellaTaskId)} className="font-semibold text-accent-ink hover:underline">
              Lane umbrella
            </Link>
          )}
        </div>
      </div>
      {(canSkipEntry(entry.state) || retryable) && (
        <div className="flex flex-wrap gap-2">
          {canSkipEntry(entry.state) && (
            <button
              type="button"
              className={CONTROL_CLASS}
              disabled={busy("skip")}
              onClick={() => {
                onSkip(entry);
              }}
            >
              Skip
            </button>
          )}
          {retryable && (
            <button
              type="button"
              className={CONTROL_CLASS}
              disabled={busy("retry")}
              onClick={() => {
                onRetry(entry);
              }}
            >
              Retry
            </button>
          )}
          {retryable && (
            <button
              type="button"
              className={CONTROL_CLASS}
              title={higher ? `Run on ${higher.label}` : "The task is already on the highest run level"}
              disabled={busy("retry") || higher === null}
              onClick={() => {
                if (higher) onRetry(entry, higher.key);
              }}
            >
              Retry on next level up
            </button>
          )}
        </div>
      )}
    </li>
  );
}

interface QueueCardProps {
  readonly queue: WorkQueueView;
  readonly levels: readonly RunLevel[];
  readonly pending: ReadonlySet<string>;
  readonly onQueueAction: (queue: WorkQueueView, action: "pause" | "resume" | "cancel") => void;
  readonly onSkip: (entry: WorkQueueEntryView) => void;
  readonly onRetry: (entry: WorkQueueEntryView, level?: string) => void;
}

function WorkQueueCard({ queue, levels, pending, onQueueAction, onSkip, onRetry }: QueueCardProps) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const controls = queueControls(queue.state);
  const busy = (action: string) => pending.has(actionKey("queue", queue.id, action));
  const lanes = laneProgress(queue.entries);
  const headingId = `work-queue-${queue.id}`;

  return (
    <article aria-labelledby={headingId} className="flex flex-col gap-4 rounded-md border border-rule p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={headingId} className="m-0 break-words font-display text-base font-semibold text-ink">
            {queueTitle(queue.prompt)}
          </h3>
          <span className={`${BADGE_CLASS} self-start`}>{QUEUE_STATE_LABELS[queue.state]}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {controls.pause && (
            <button
              type="button"
              className={CONTROL_CLASS}
              disabled={busy("pause")}
              onClick={() => {
                onQueueAction(queue, "pause");
              }}
            >
              Pause
            </button>
          )}
          {controls.resume && (
            <button
              type="button"
              className={CONTROL_CLASS}
              disabled={busy("resume")}
              onClick={() => {
                onQueueAction(queue, "resume");
              }}
            >
              Resume
            </button>
          )}
          {controls.cancel && !confirmingCancel && (
            <button
              type="button"
              className={DANGER_CLASS}
              onClick={() => {
                setConfirmingCancel(true);
              }}
            >
              Cancel queue
            </button>
          )}
          {controls.cancel && confirmingCancel && (
            <>
              <button
                type="button"
                className={DANGER_CLASS}
                disabled={busy("cancel")}
                onClick={() => {
                  setConfirmingCancel(false);
                  onQueueAction(queue, "cancel");
                }}
              >
                Confirm cancel
              </button>
              <button
                type="button"
                className={CONTROL_CLASS}
                onClick={() => {
                  setConfirmingCancel(false);
                }}
              >
                Keep queue
              </button>
            </>
          )}
        </div>
      </div>

      {lanes.length > 0 && (
        <ul aria-label="Lane progress" className="m-0 flex list-none flex-wrap gap-2 p-0">
          {lanes.map((lane) => (
            <li key={lane.lane} className="rounded-pill bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-ink">
              {lane.label}
            </li>
          ))}
        </ul>
      )}

      {queue.entries.length > 0 ? (
        <ol aria-label="Queue items" className="m-0 flex list-none flex-col gap-0 p-0">
          {queue.entries.map((entry) => (
            <WorkQueueItemRow
              key={entry.id}
              entry={entry}
              levels={levels}
              pending={pending}
              onSkip={onSkip}
              onRetry={onRetry}
            />
          ))}
        </ol>
      ) : (
        <p className="m-0 text-sm text-ink-2">No tasks in this queue.</p>
      )}
    </article>
  );
}

/**
 * Dashboard queue panel (#BIT-206): open work queues with lane progress, each item's state and waiting
 * reason, and the pause, resume, cancel, skip and retry controls. Lists stay current through the
 * realtime socket; a change the panel cannot place (an unknown queue) reloads the list.
 */
export function WorkQueuePanel({ enabled }: WorkQueuePanelProps) {
  const { levels } = useRunProfiles();
  const [queues, setQueues] = useState<readonly WorkQueueView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchWorkQueues(controller.signal)
      .then((list) => {
        if (controller.signal.aborted) return;
        setQueues(list);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) return;
        setLoadError(errorMessage(error, "Could not load the work queues"));
      });
    return () => {
      controller.abort();
    };
  }, [enabled, reloadToken]);

  function reload(): void {
    setReloadToken((token) => token + 1);
  }

  useRealtimeEvent((event) => {
    // Without a list, a change can only be answered by loading one; a list that never loaded
    // gets a fresh attempt, and a list still loading gets its answer from that request.
    if (queues === null) {
      if (loadError !== null) reload();
      return;
    }
    const next = applyRealtimeEvent(queues, event);
    if (next === null) reload();
    else if (next !== queues) setQueues(next);
  });

  async function run(key: string, task: () => Promise<void>): Promise<void> {
    setPending((current) => new Set([...current, key]));
    setActionError(null);
    try {
      await task();
    } catch (error: unknown) {
      setActionError(errorMessage(error, "The change did not go through"));
    } finally {
      setPending((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }

  /** Applies a server answer to the list; an answer the list cannot place reloads it instead. */
  function applyResponse(next: readonly WorkQueueView[] | null): void {
    if (next === null) reload();
    else setQueues(next);
  }

  function handleQueueAction(queue: WorkQueueView, action: "pause" | "resume" | "cancel"): void {
    const request = { pause: pauseWorkQueue, resume: resumeWorkQueue, cancel: cancelWorkQueue }[action];
    void run(actionKey("queue", queue.id, action), async () => {
      const updated = await request(queue.id);
      applyResponse(queues === null ? null : applyQueueUpdate(queues, updated));
    });
  }

  function handleSkip(entry: WorkQueueEntryView): void {
    void run(actionKey("item", entry.id, "skip"), async () => {
      const updated = await skipWorkQueueItem(entry.id);
      applyResponse(queues === null ? null : applyEntryUpdate(queues, updated));
    });
  }

  function handleRetry(entry: WorkQueueEntryView, level?: string): void {
    void run(actionKey("item", entry.id, "retry"), async () => {
      const updated = await retryWorkQueueItem(entry.id, level);
      applyResponse(queues === null ? null : applyEntryUpdate(queues, updated));
    });
  }

  if (!enabled) return null;

  return (
    <section
      aria-labelledby="work-queues-heading"
      className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <h2 id="work-queues-heading" className="m-0 font-display text-lg font-semibold text-ink">
        Work queues
      </h2>

      {loadError && (
        <p role="alert" className="m-0 text-sm text-danger">
          {loadError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="m-0 text-sm text-danger">
          {actionError}
        </p>
      )}
      {queues === null && !loadError && <p className="m-0 text-sm text-ink-2">Loading work queues…</p>}
      {queues !== null && queues.length === 0 && (
        <p className="m-0 text-sm text-ink-2">No open work queues. Queue tasks from the prompt above.</p>
      )}

      {queues?.map((queue) => (
        <WorkQueueCard
          key={queue.id}
          queue={queue}
          levels={levels}
          pending={pending}
          onQueueAction={handleQueueAction}
          onSkip={handleSkip}
          onRetry={handleRetry}
        />
      ))}
    </section>
  );
}
