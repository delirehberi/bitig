import {
  isActiveAgentRunState,
  type AgentRun,
  type T3ProjectActiveSession,
  type T3RunsLiveResponse,
} from "@bitig/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { T3ApiError, fetchT3Runs } from "../services/t3";
import { useRealtimeEvent } from "./useRealtime";

export interface UseT3RunsOptions {
  /** False skips every fetch, e.g. when a parent or a test already supplies the runs. */
  readonly enabled?: boolean;
  /**
   * Re-reads `/api/t3/runs` on this interval while the page is visible. The worker only
   * reconciles thread states with the T3 host when this endpoint is read, so a view that must
   * notice a thread starting to wait on a person polls it. Omit to load once.
   */
  readonly pollIntervalMs?: number;
}

export interface T3RunsState {
  readonly runs: readonly AgentRun[];
  readonly activeSessions: readonly T3ProjectActiveSession[];
  /** True until the first load settles. */
  readonly isLoading: boolean;
  /** True while a manual refresh is in flight. */
  readonly isRefreshing: boolean;
  /** The last load failure, cleared by the next successful load. */
  readonly error: string | null;
  readonly refresh: () => Promise<void>;
}

const UNKNOWN_FAILURE = "Could not load T3 sessions";

function describeError(error: unknown): string {
  if (error instanceof T3ApiError) return error.message;
  console.error("unexpected T3 runs failure", error);
  return UNKNOWN_FAILURE;
}

function upsertRun(runs: readonly AgentRun[], run: AgentRun): AgentRun[] {
  // The worker keeps one run per task, so the task id identifies it.
  const index = runs.findIndex((existing) => existing.taskId === run.taskId);
  if (index === -1) return [...runs, run];
  const next = [...runs];
  next[index] = run;
  return next;
}

/**
 * Live T3 runs and active project sessions from `/api/t3/runs`, kept current by
 * `agent_run.updated` realtime events and, optionally, by polling.
 */
export function useT3Runs({ enabled = true, pollIntervalMs }: UseT3RunsOptions = {}): T3RunsState {
  const [runs, setRuns] = useState<readonly AgentRun[]>([]);
  const [activeSessions, setActiveSessions] = useState<readonly T3ProjectActiveSession[]>([]);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  // State is only set in promise callbacks, never synchronously in the effects that call this.
  const load = useCallback((): Promise<void> => {
    // A newer load supersedes an older one, so stale responses never overwrite fresh state.
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return fetchT3Runs(controller.signal).then(
      (response: T3RunsLiveResponse) => {
        if (controller.signal.aborted) return;
        setRuns(response.runs);
        setActiveSessions(response.activeSessions ?? []);
        setError(null);
        setIsLoading(false);
      },
      (loadError: unknown) => {
        if (controller.signal.aborted) return;
        setError(describeError(loadError));
        setIsLoading(false);
      },
    );
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      await load();
    } finally {
      setIsRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    if (!enabled) return;
    void load();
    return () => {
      controllerRef.current?.abort();
    };
  }, [enabled, load]);

  useEffect(() => {
    if (!enabled || pollIntervalMs === undefined || pollIntervalMs <= 0) return;
    const timer = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      void load();
    }, pollIntervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [enabled, pollIntervalMs, load]);

  useRealtimeEvent((event) => {
    if (!enabled || event.type !== "agent_run.updated") return;
    setRuns((prev) => upsertRun(prev, event.run));
    if (!isActiveAgentRunState(event.run.state)) {
      setActiveSessions((prev) =>
        prev.filter((session) => session.threadId !== event.run.threadId && session.taskId !== event.run.taskId),
      );
    }
  });

  return { runs, activeSessions, isLoading, isRefreshing, error, refresh };
}
