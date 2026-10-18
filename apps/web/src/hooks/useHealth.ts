import type { StorageMode } from "@bitig/core";
import { useEffect, useState } from "react";
import { HealthCheckError, fetchHealth } from "../services/health";

export type HealthState =
  | { kind: "checking" }
  | { kind: "online"; version: string; storageMode: StorageMode }
  | { kind: "unreachable"; reason: string };

const UNKNOWN_FAILURE = "health check failed";

export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: "checking" });

  useEffect(() => {
    const controller = new AbortController();

    fetchHealth(controller.signal).then(
      (payload) => {
        setState({ kind: "online", version: payload.version, storageMode: payload.storageMode });
      },
      (error: unknown) => {
        // Unmount cancelled the request; there is no UI left to update.
        if (controller.signal.aborted) return;
        const reason = error instanceof HealthCheckError ? error.message : UNKNOWN_FAILURE;
        if (!(error instanceof HealthCheckError)) {
          console.error("unexpected health check failure", error);
        }
        setState({ kind: "unreachable", reason });
      },
    );

    return () => {
      controller.abort();
    };
  }, []);

  return state;
}

