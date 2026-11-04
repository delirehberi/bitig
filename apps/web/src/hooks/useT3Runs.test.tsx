import type { AgentRun } from "@bitig/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchRealtimeEvent } from "./useRealtime";
import { useT3Runs } from "./useT3Runs";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const POLL_INTERVAL_MS = 1_000;

const RUN: AgentRun = {
  id: "01940000-0000-7000-8000-000000000090",
  taskId: "01940000-0000-7000-8000-000000000011",
  t3ProjectId: "t3",
  threadId: "thread-a",
  state: "working",
  startedAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

function stubRuns(body: unknown, status = 200) {
  const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("useT3Runs", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads runs and active sessions", async () => {
    stubRuns({
      runs: [RUN],
      activeSessions: [{ threadId: "thread-p", projectId: "p", t3ProjectId: "t3", state: "working" }],
    });
    const { result } = renderHook(() => useT3Runs());

    expect(result.current.isLoading).toBe(true);
    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });
    expect(result.current.runs).toEqual([RUN]);
    expect(result.current.activeSessions).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it("reports a failed load instead of hiding it", async () => {
    stubRuns({ error: "T3 host unreachable" }, 502);
    const { result } = renderHook(() => useT3Runs());

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.runs).toEqual([]);
  });

  it("does not fetch when disabled", () => {
    const fetchMock = stubRuns({ runs: [] });
    const { result } = renderHook(() => useT3Runs({ enabled: false }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("applies agent_run.updated realtime events", async () => {
    stubRuns({
      runs: [RUN],
      activeSessions: [{ threadId: RUN.threadId, projectId: "p", t3ProjectId: "t3", state: "working", taskId: RUN.taskId }],
    });
    const { result } = renderHook(() => useT3Runs());
    await waitFor(() => {
      expect(result.current.runs).toHaveLength(1);
    });

    act(() => {
      dispatchRealtimeEvent({ type: "agent_run.updated", run: { ...RUN, state: "finished" } });
    });

    expect(result.current.runs[0]?.state).toBe("finished");
    expect(result.current.activeSessions).toEqual([]);
  });

  it("polls on the given interval", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetchMock = stubRuns({ runs: [] });
    renderHook(() => useT3Runs({ pollIntervalMs: POLL_INTERVAL_MS }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
