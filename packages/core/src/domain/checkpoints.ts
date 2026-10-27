import { CHECKPOINT_GOAL_MAX, CHECKPOINT_HISTORY_MAX } from "./constants";
import { parseOrThrow } from "./errors";
import { CheckpointSchema, SaveCheckpointInputSchema } from "./schemas";
import type { Checkpoint, SaveCheckpointInput, Task } from "./types";
import { toTimestamp, type RuntimeDeps } from "../runtime/ids";

/** Upserts retain identity and original commit time; latest always means highest step. */
export function buildCheckpoint(input: SaveCheckpointInput, runtime: RuntimeDeps, existing?: Checkpoint): Checkpoint {
  const parsed = parseOrThrow(SaveCheckpointInputSchema, input, "save checkpoint");
  const sameStep = existing?.taskId === parsed.taskId && existing.stepIndex === parsed.stepIndex;
  return parseOrThrow(CheckpointSchema, {
    ...parsed,
    id: sameStep ? existing.id : runtime.generateId(),
    createdAt: sameStep ? existing.createdAt : toTimestamp(runtime.clock()),
  }, "checkpoint");
}

export function compareCheckpoints(left: Checkpoint, right: Checkpoint): number {
  return left.stepIndex - right.stepIndex;
}

/** Pure, bounded context. Callers supply current dependency facts, never snapshot claims. */
export function buildExecutionContext(task: Task, checkpoints: readonly Checkpoint[], dependencies: readonly Task[], stepIndex?: number) {
  const ordered = checkpoints.filter((checkpoint) => checkpoint.taskId === task.id).sort(compareCheckpoints);
  const selected = stepIndex === undefined ? ordered.at(-1) : ordered.find((checkpoint) => checkpoint.stepIndex === stepIndex);
  const previous = selected ? ordered.filter((checkpoint) => checkpoint.stepIndex < selected.stepIndex) : [];
  return {
    task: {
      id: task.id, title: task.title, status: task.status,
      description: task.description.slice(0, CHECKPOINT_GOAL_MAX),
      descriptionTruncated: task.description.length > CHECKPOINT_GOAL_MAX,
      checklist: task.checklist ?? [],
    },
    gates: {
      pendingApproval: task.pendingApproval === true,
      needsHuman: task.needsHuman ?? null,
      dependencies: (task.dependsOn ?? []).map((id) => {
        const dependency = dependencies.find((candidate) => candidate.id === id);
        return { id, status: dependency?.status ?? null, blocked: dependency?.status !== "done" };
      }),
    },
    history: previous.slice(-CHECKPOINT_HISTORY_MAX).map(({ stepIndex, status, stateSnapshot }) => ({ stepIndex, status, summary: stateSnapshot.summary })),
    omittedHistoryCount: Math.max(0, previous.length - CHECKPOINT_HISTORY_MAX),
    checkpoint: selected ?? null,
  };
}
