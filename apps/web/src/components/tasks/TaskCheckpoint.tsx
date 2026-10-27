import { Bot, Flag } from "lucide-react";
import type { CheckpointStatus, StorageProvider } from "@bitig/core";
import { useCheckpoints } from "../../hooks/useCheckpoints";

const ICON_SIZE = 12;

const STATUS_LABELS: Record<CheckpointStatus, string> = {
  PENDING: "Pending",
  IN_PROGRESS: "In progress",
  WAITING_HUMAN_APPROVAL: "Waiting for approval",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

interface TaskCheckpointProps {
  readonly storage: StorageProvider;
  readonly taskId: string;
}

/** The task's latest checkpoint at a glance: who saved it and where the work stands. Hidden when there is none. */
export function TaskCheckpoint({ storage, taskId }: TaskCheckpointProps) {
  const { checkpoints, error } = useCheckpoints(storage, taskId);
  const latest = checkpoints.at(-1);

  if (error !== null) {
    return (
      <p role="alert" className="mb-5 text-xs text-danger">
        {error}
      </p>
    );
  }
  if (!latest) return null;

  return (
    <section aria-labelledby="task-detail-checkpoint" className="mb-5">
      <h3
        id="task-detail-checkpoint"
        className="m-0 mb-2 flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3"
      >
        <Flag size={ICON_SIZE} aria-hidden="true" />
        Checkpoint
      </h3>
      <div className="rounded-md border border-rule bg-paper-2 px-3 py-2 text-xs text-ink-2">
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-2xs text-ink-3">
          <span className="rounded-pill border border-rule bg-paper px-2 py-0.5 font-semibold text-ink-2">
            {STATUS_LABELS[latest.status]}
          </span>
          <span>Step {String(latest.stepIndex)}</span>
          {latest.createdBy !== undefined && (
            <span className="inline-flex items-center gap-1">
              <Bot size={ICON_SIZE} aria-hidden="true" />
              by <strong className="font-semibold text-ink-2">{latest.createdBy}</strong>
            </span>
          )}
          <time dateTime={latest.createdAt} className="ml-auto font-mono">
            {formatTimestamp(latest.createdAt)}
          </time>
        </div>
        <p className="m-0 text-sm text-ink">{latest.stateSnapshot.summary}</p>
        <p className="m-0 mt-1">
          <span className="font-semibold text-ink-2">Next: </span>
          {latest.stateSnapshot.nextStepInstructions}
        </p>
      </div>
    </section>
  );
}
