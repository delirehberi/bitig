import { useEffect, useState } from "react";
import type { Checkpoint, StorageProvider } from "@bitig/core";
import { useRealtimeEvent } from "./useRealtime";

/**
 * One task's checkpoints, ordered by step. Read-only: agents write them.
 * Mount it once per task (key the component by task ID): state is not reset when `taskId` changes.
 */
export function useCheckpoints(storage: StorageProvider, taskId: string) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    storage
      .getCheckpoints(taskId, { signal: controller.signal })
      .then((result) => {
        setCheckpoints(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load checkpoints");
        setIsLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [storage, taskId]);

  useRealtimeEvent((event) => {
    if (event.type !== "sync") return;
    void storage
      .getCheckpoints(taskId)
      .then((result) => {
        setCheckpoints(result);
      })
      .catch((err: unknown) => {
        console.warn("failed to resync checkpoints", err);
      });
  });

  return { checkpoints, isLoading, error };
}
