import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Gauge,
  GitMerge,
  Play,
  Square,
} from "lucide-react";
import {
  T3_SHORT_SHA_LENGTH,
  type AgentRunChild,
  type ParallelSkipReason,
  type Task,
  type UmbrellaChildItem,
  type UmbrellaChildrenStatusResponse,
  type UmbrellaProgressSummary,
} from "@bitig/core";
import { useRealtimeEvent } from "../../hooks/useRealtime";
import { Link } from "../../routing/Link";
import { taskHref, useLocationHref } from "../../routing/router";
import {
  fetchUmbrellaChildren,
  startUmbrellaReadyChildren,
  stopAllUmbrellaChildren,
  stopTaskT3Run,
  T3ApiError,
} from "../../services/t3";
import { cleanT3Link } from "../projects/activeSessions";
import { T3GitBadges } from "./T3GitBadges";
import { UmbrellaProgressBadge } from "./UmbrellaProgressBadge";

export interface UmbrellaChildrenPanelProps {
  readonly task: Task;
  /** Whether the workspace umbrella index already knows this task has children. */
  readonly isUmbrella?: boolean | undefined;
  /** Whether task links, checklist mentions, or active run state suggest candidate children. */
  readonly hasCandidateChildren?: boolean | undefined;
  readonly className?: string | undefined;
}

const SKIP_REASON_LABELS: Record<ParallelSkipReason, string> = {
  already_running: "Already running",
  unapproved: "Awaiting approval",
  blocked: "Dependency",
  cap_reached: "Cap reached",
  running_solo_sibling: "Solo sibling running",
  no_touches: "No declared paths",
  not_parallel_safe: "Not parallel-safe",
  touches_serial_path: "Serial path",
  overlaps_running: "Path overlap",
  overlaps_picked: "Path overlap",
};

interface ChildStateDisplay {
  readonly label: string;
  readonly className: string;
}

function describeChildState(child: UmbrellaChildItem): ChildStateDisplay {
  if (child.isRunning) {
    if (child.runState === "queued") {
      return {
        label: "Queued",
        className: "border-accent/40 bg-accent-soft text-accent-ink",
      };
    }
    if (child.runState === "waiting_for_approval") {
      return {
        label: "Waiting for approval",
        className: "border-danger/40 bg-danger-soft text-danger",
      };
    }
    return {
      label: "Running",
      className: "border-accent/40 bg-accent-soft text-accent-ink",
    };
  }

  if (child.taskStatus === "done" || child.taskStatus === "archived" || child.childState === "done") {
    return {
      label: "Done",
      className: "border-ok/30 bg-ok-soft text-ok",
    };
  }

  if (child.childState === "needs_human" || child.needsHuman !== undefined) {
    return {
      label: "Needs input",
      className: "border-accent/40 bg-accent-soft text-accent-ink",
    };
  }

  if (child.childState === "failed" || child.runState === "failed") {
    return {
      label: "Failed",
      className: "border-danger/40 bg-danger-soft text-danger",
    };
  }

  if (child.childState === "stopped" || child.runState === "stopped") {
    return {
      label: "Stopped",
      className: "border-rule bg-paper-3 text-ink-3",
    };
  }

  if (child.pendingApproval === true) {
    return {
      label: "Awaiting approval",
      className: "border-dashed border-rule-strong bg-paper-3 text-ink-2",
    };
  }

  return {
    label: "Waiting",
    className: "border-rule bg-paper-2 text-ink-2",
  };
}

function formatTierAndModel(item: {
  readonly levelKey?: string | undefined;
  readonly levelLabel?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): { readonly tier?: string | undefined; readonly modelSummary?: string | undefined } {
  const tier = item.levelLabel ?? item.levelKey;
  const modelParts: string[] = [];
  if (item.model) {
    modelParts.push(item.model);
  } else if (item.providerInstanceId) {
    modelParts.push(item.providerInstanceId);
  }
  if (item.effort) {
    modelParts.push(item.effort);
  }
  const modelSummary = modelParts.length > 0 ? modelParts.join(" \u00b7 ") : undefined;
  return {
    ...(tier ? { tier } : {}),
    ...(modelSummary ? { modelSummary } : {}),
  };
}

function computeProgressFromItems(children: readonly UmbrellaChildItem[]): UmbrellaProgressSummary {
  let running = 0;
  let merged = 0;
  let done = 0;
  for (const child of children) {
    if (child.isRunning) running += 1;
    if (child.merged) merged += 1;
    if (
      child.taskStatus === "done" ||
      child.taskStatus === "archived" ||
      child.childState === "done" ||
      child.merged
    ) {
      done += 1;
    }
  }
  return {
    total: children.length,
    running,
    merged,
    done,
  };
}

function applyChildRealtimePatch(
  prev: UmbrellaChildrenStatusResponse | null,
  patch: AgentRunChild,
): UmbrellaChildrenStatusResponse | null {
  if (prev?.parentTaskId !== patch.parentTaskId) return prev;
  const idx = prev.children.findIndex((c) => c.taskId === patch.childTaskId);
  if (idx === -1) return prev;

  const current = prev.children[idx];
  if (!current) return prev;

  const isRunning = patch.state === "running";
  const merged = Boolean(patch.mergedAt ?? patch.mergedSha);
  const updatedChild: UmbrellaChildItem = {
    ...current,
    childState: patch.state,
    isRunning,
    ...(patch.branch ? { branch: patch.branch } : {}),
    ...(patch.headSha ? { headSha: patch.headSha } : {}),
    merged,
    ...(patch.mergedAt ? { mergedAt: patch.mergedAt } : {}),
    ...(patch.mergedSha ? { mergedSha: patch.mergedSha } : {}),
    ...(isRunning || patch.state === "done"
      ? { waitingReason: undefined, inReadyBatch: false }
      : {}),
  };

  const nextChildren = [...prev.children];
  nextChildren[idx] = updatedChild;

  const nextReadyBatch =
    isRunning || patch.state === "done"
      ? prev.readyBatch.filter((item) => item.taskId !== patch.childTaskId)
      : prev.readyBatch;

  return {
    ...prev,
    children: nextChildren,
    readyBatch: nextReadyBatch,
    progress: computeProgressFromItems(nextChildren),
  };
}

/**
 * Umbrella task Children panel (#BIT-191): lists each child task with state, tier & model,
 * branch, diff stat, merge state, and waiting skip reason, plus batch confirmation for
 * "Run ready children" and per-child / batch stop controls.
 */
export function UmbrellaChildrenPanel({
  task,
  isUmbrella,
  hasCandidateChildren,
  className = "",
}: UmbrellaChildrenPanelProps) {
  const locationHref = useLocationHref();
  const [status, setStatus] = useState<UmbrellaChildrenStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [isStartingBatch, setIsStartingBatch] = useState(false);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [isStoppingAll, setIsStoppingAll] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const shouldLoad =
    isUmbrella === true ||
    hasCandidateChildren === true ||
    (isUmbrella === undefined && hasCandidateChildren === undefined);
  const strictErrors =
    isUmbrella === true || (isUmbrella === undefined && hasCandidateChildren === undefined);

  const load = useCallback(
    (options: { readonly quiet?: boolean | undefined } = {}): Promise<void> => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      return fetchUmbrellaChildren(task.id, controller.signal).then(
        (next) => {
          if (controller.signal.aborted) return;
          if (!Array.isArray(next.children)) return;
          setStatus(next);
          setError(null);
          if (next.readyBatch.length === 0) {
            setConfirmingBatch(false);
          }
        },
        (err: unknown) => {
          if (controller.signal.aborted) return;
          if (options.quiet) return;
          if (err instanceof T3ApiError && strictErrors) {
            setError(err.message);
          }
        },
      );
    },
    [strictErrors, task.id],
  );

  useEffect(() => {
    if (!shouldLoad) return;
    void load();
    return () => {
      controllerRef.current?.abort();
    };
  }, [load, shouldLoad]);

  useRealtimeEvent((event) => {
    if (!shouldLoad) return;
    if (event.type === "agent_run_child.updated") {
      if (
        event.child.parentTaskId === task.id ||
        status?.children.some((c) => c.taskId === event.child.childTaskId)
      ) {
        setStatus((prev) => applyChildRealtimePatch(prev, event.child));
        void load({ quiet: true });
      }
      return;
    }
    if (event.type === "agent_run.updated") {
      if (
        event.run.taskId === task.id ||
        event.run.parentTaskId === task.id ||
        status?.children.some((c) => c.taskId === event.run.taskId)
      ) {
        void load({ quiet: true });
      }
      return;
    }
    if (
      event.type === "task.updated" ||
      event.type === "task.created" ||
      event.type === "task.deleted" ||
      event.type === "sync"
    ) {
      void load({ quiet: true });
    }
  });

  async function handleConfirmStartReady() {
    setIsStartingBatch(true);
    setError(null);
    try {
      await startUmbrellaReadyChildren(task.id);
      setConfirmingBatch(false);
      await load({ quiet: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not start ready children.");
    } finally {
      setIsStartingBatch(false);
    }
  }

  async function handleStopChild(childTaskId: string) {
    setStoppingTaskId(childTaskId);
    setError(null);
    try {
      await stopTaskT3Run(childTaskId);
      await load({ quiet: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not stop child T3 session.");
    } finally {
      setStoppingTaskId(null);
    }
  }

  async function handleStopAll() {
    setIsStoppingAll(true);
    setError(null);
    try {
      await stopAllUmbrellaChildren(task.id);
      await load({ quiet: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not stop running children.");
    } finally {
      setIsStoppingAll(false);
    }
  }

  if (!shouldLoad) {
    return null;
  }

  if (!status || status.children.length === 0) {
    if (!error) return null;
    return (
      <section
        aria-label="Children"
        data-testid="umbrella-children-panel"
        className={`mb-5 rounded-md border border-rule bg-paper-2/50 p-3.5 ${className}`.trim()}
      >
        <div
          role="alert"
          className="rounded border border-danger/30 bg-danger-soft px-2.5 py-2 text-xs text-danger"
        >
          {error}
        </div>
      </section>
    );
  }

  const runningChildren = status.children.filter((child) => child.isRunning);
  const readyCount = status.readyBatch.length;
  const anyActionBusy = isStartingBatch || isStoppingAll || stoppingTaskId !== null;

  return (
    <section
      aria-labelledby={`umbrella-children-heading-${task.id}`}
      data-testid="umbrella-children-panel"
      className={`mb-5 rounded-md border border-rule bg-paper-2/40 p-3.5 ${className}`.trim()}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3
            id={`umbrella-children-heading-${task.id}`}
            className="m-0 text-2xs font-semibold uppercase tracking-wider text-ink-3"
          >
            Children
          </h3>
          <UmbrellaProgressBadge progress={status.progress} />
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={readyCount === 0 || anyActionBusy}
            title={
              readyCount === 0
                ? "No ready children can start right now"
                : `Preview batch of ${String(readyCount)} ready ${readyCount === 1 ? "child" : "children"}`
            }
            onClick={() => {
              setConfirmingBatch((prev) => !prev);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
          >
            <Play size={12} aria-hidden="true" />
            <span>Run ready children</span>
            {readyCount > 0 && (
              <span className="rounded-pill bg-paper/20 px-1.5 py-0.2 font-mono text-2xs">
                {readyCount}
              </span>
            )}
          </button>

          {runningChildren.length > 0 && (
            <button
              type="button"
              disabled={anyActionBusy}
              onClick={() => {
                void handleStopAll();
              }}
              className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1 text-xs font-semibold text-danger transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
            >
              <Square size={11} aria-hidden="true" />
              <span>{isStoppingAll ? "Stopping\u2026" : "Stop all"}</span>
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-3 rounded border border-danger/30 bg-danger-soft px-2.5 py-2 text-xs font-medium text-danger"
        >
          {error}
        </div>
      )}

      {confirmingBatch && readyCount > 0 && (
        <div
          data-testid="umbrella-batch-confirm"
          className="mb-3 rounded-md border border-accent/30 bg-paper p-3 shadow-xs"
        >
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <strong className="text-xs font-semibold text-ink">
              Start {readyCount} ready {readyCount === 1 ? "child" : "children"} (parallel cap{" "}
              {status.maxParallelChildren})
            </strong>
            <span className="text-2xs text-ink-3">
              Branches from the umbrella worktree
            </span>
          </div>

          {!status.launchReadiness.ready && status.launchReadiness.reason && (
            <div
              role="alert"
              className="mb-2.5 flex items-start gap-1.5 rounded border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-2xs font-medium text-danger"
            >
              <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
              <span>{status.launchReadiness.reason}</span>
            </div>
          )}

          <ul className="m-0 mb-3 flex list-none flex-col gap-1.5 p-0">
            {status.readyBatch.map((batchItem) => {
              const { tier, modelSummary } = formatTierAndModel(batchItem);
              return (
                <li
                  key={batchItem.taskId}
                  className="flex flex-wrap items-center justify-between gap-2 rounded border border-rule bg-paper-2/60 px-2.5 py-1.5 text-xs"
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    {batchItem.code && (
                      <span className="shrink-0 font-mono text-2xs font-semibold text-ink-2">
                        {batchItem.code}
                      </span>
                    )}
                    <span className="truncate font-medium text-ink">{batchItem.title}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-2">
                    {tier && (
                      <span className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper px-2 py-0.5 font-semibold text-ink-2">
                        <Gauge size={10} aria-hidden="true" />
                        <span>{tier}</span>
                      </span>
                    )}
                    {modelSummary && <span className="font-mono text-ink-3">{modelSummary}</span>}
                    {batchItem.touches && batchItem.touches.length > 0 && (
                      <span
                        title={`Touches: ${batchItem.touches.join(", ")}`}
                        className="max-w-[200px] truncate rounded border border-rule bg-paper px-1.5 py-0.5 font-mono text-ink-3"
                      >
                        {batchItem.touches.join(", ")}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={isStartingBatch}
              onClick={() => {
                setConfirmingBatch(false);
              }}
              className="rounded-md border border-rule bg-paper-2 px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink disabled:opacity-50 focus-visible:outline-focus"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!status.launchReadiness.ready || isStartingBatch}
              onClick={() => {
                void handleConfirmStartReady();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
            >
              <Play size={11} aria-hidden="true" />
              <span>
                {isStartingBatch
                  ? "Starting\u2026"
                  : `Start ${String(readyCount)} ${readyCount === 1 ? "child" : "children"}`}
              </span>
            </button>
          </div>
        </div>
      )}

      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {status.children.map((child) => {
          const stateBadge = describeChildState(child);
          const { tier, modelSummary } = formatTierAndModel(child);
          const safeLink = cleanT3Link(child.link);
          const childRef = child.code ?? child.taskId;
          const isStoppingThis = stoppingTaskId === child.taskId;

          return (
            <li
              key={child.taskId}
              data-testid={`umbrella-child-row-${childRef}`}
              className="flex flex-col gap-1.5 rounded-md border border-rule bg-paper p-2.5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
                  <Link
                    href={taskHref(childRef, locationHref)}
                    className="inline-flex min-w-0 items-center gap-1.5 text-xs text-ink hover:text-accent-ink focus-visible:outline-focus"
                  >
                    {child.code && (
                      <span className="shrink-0 font-mono text-2xs font-semibold text-ink-2">
                        {child.code}
                      </span>
                    )}
                    <span className="truncate font-semibold">{child.title}</span>
                  </Link>

                  <span
                    className={`rounded-pill border px-2 py-0.5 text-2xs font-semibold ${stateBadge.className}`}
                  >
                    {stateBadge.label}
                  </span>

                  {child.merged ? (
                    <span
                      title={
                        child.mergedSha
                          ? `Merged at ${child.mergedSha}`
                          : "Merged into umbrella worktree"
                      }
                      className="inline-flex items-center gap-1 rounded-pill border border-ok/30 bg-ok-soft px-2 py-0.5 font-mono text-2xs font-semibold text-ok"
                    >
                      <GitMerge size={10} aria-hidden="true" />
                      <span>
                        Merged
                        {child.mergedSha
                          ? ` \u00b7 ${child.mergedSha.slice(0, T3_SHORT_SHA_LENGTH)}`
                          : ""}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-3">
                      Not merged
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {safeLink && (
                    <a
                      href={safeLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2 hover:text-ink focus-visible:outline-focus"
                    >
                      <span>T3</span>
                      <ExternalLink size={10} aria-hidden="true" />
                    </a>
                  )}
                  {child.isRunning && (
                    <button
                      type="button"
                      disabled={anyActionBusy}
                      aria-label={`Stop ${childRef}`}
                      onClick={() => {
                        void handleStopChild(child.taskId);
                      }}
                      className="inline-flex items-center gap-1 rounded border border-danger/30 bg-danger-soft px-2 py-0.5 text-2xs font-semibold text-danger transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
                    >
                      <Square size={10} aria-hidden="true" />
                      <span>{isStoppingThis ? "Stopping\u2026" : "Stop"}</span>
                    </button>
                  )}
                </div>
              </div>

              {(tier !== undefined ||
                modelSummary !== undefined ||
                child.branch !== undefined ||
                child.headSha !== undefined ||
                child.diffStat !== undefined ||
                (child.pullRequestUrls?.length ?? 0) > 0) && (
                <div className="flex flex-wrap items-center gap-1.5 text-2xs text-ink-2">
                  {tier && (
                    <span
                      title="Resolved run tier"
                      className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper-2 px-2 py-0.5 font-semibold text-ink-2"
                    >
                      <Gauge size={10} aria-hidden="true" />
                      <span>{tier}</span>
                    </span>
                  )}
                  {modelSummary && (
                    <span
                      title="Resolved model"
                      className="rounded border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-ink-2"
                    >
                      {modelSummary}
                    </span>
                  )}
                  <T3GitBadges
                    branch={child.branch}
                    headSha={child.headSha}
                    diffStat={child.diffStat}
                    pullRequestUrls={child.pullRequestUrls}
                  />
                </div>
              )}

              {!child.isRunning &&
                child.taskStatus !== "done" &&
                child.taskStatus !== "archived" &&
                child.childState !== "done" &&
                (child.waitingReason !== undefined || child.inReadyBatch) && (
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs">
                    {child.waitingReason ? (
                      <>
                        <span className="rounded border border-rule-strong bg-paper-2 px-1.5 py-0.5 font-semibold text-ink-2">
                          {SKIP_REASON_LABELS[child.waitingReason.reason]}
                        </span>
                        <span className="text-ink-3">{child.waitingReason.detail}</span>
                      </>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-ok">
                        <Check size={11} aria-hidden="true" />
                        <span>Ready in next batch</span>
                      </span>
                    )}
                  </div>
                )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
