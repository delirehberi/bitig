import { useEffect, useState } from "react";
import { fetchT3Connection, fetchT3Hosts } from "../../services/t3";

export type T3ConnectionState = "checking" | "connected" | "disconnected" | "unknown";

/**
 * Whether the organisation has a connected T3 host, for the dashboard prompt. Organisations with
 * several hosts list them; a single legacy connection only answers the connection check.
 */
async function loadConnected(signal: AbortSignal): Promise<boolean> {
  const hosts = await fetchT3Hosts(signal);
  if (hosts.length > 0) return true;
  const status = await fetchT3Connection(signal);
  return status.connected;
}

/** `override` (tests, or callers that already know) skips the request. */
export function useT3Connected(enabled: boolean, override: boolean | undefined): T3ConnectionState {
  const [state, setState] = useState<T3ConnectionState>("checking");

  useEffect(() => {
    if (!enabled || override !== undefined) return;
    const controller = new AbortController();
    loadConnected(controller.signal)
      .then((connected) => {
        if (!controller.signal.aborted) setState(connected ? "connected" : "disconnected");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Could not check the T3 connection", error);
        setState("unknown");
      });
    return () => {
      controller.abort();
    };
  }, [enabled, override]);

  if (!enabled) return "disconnected";
  if (override !== undefined) return override ? "connected" : "disconnected";
  return state;
}
