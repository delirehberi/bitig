import type { Task } from "@bitig/core";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DEFAULT_NOTIFICATION_PREFERENCES, saveNotificationPreferences } from "../services/notifications";
import { FakeNotification, MemoryStorage, NOTIFY_PROJECT, notifyRun, notifyTask } from "../test/notification-fixtures";
import { useNotificationDispatcher, useNotificationSettings } from "./useBrowserNotifications";
import { dispatchRealtimeEvent } from "./useRealtime";

const OPEN = notifyTask(1, { title: "Ship it" });

function enable(triggers: Partial<typeof DEFAULT_NOTIFICATION_PREFERENCES.triggers> = {}) {
  saveNotificationPreferences({ enabled: true, triggers: { ...DEFAULT_NOTIFICATION_PREFERENCES.triggers, ...triggers } });
}

function renderDispatcher(tasks: readonly Task[] = [OPEN]) {
  return renderHook(() => { useNotificationDispatcher({ projects: [NOTIFY_PROJECT], tasks }); });
}

function emit(task: Task) {
  act(() => {
    dispatchRealtimeEvent({ type: "task.updated", task });
  });
}

describe("useNotificationDispatcher", () => {
  let hasFocus: MockInstance<() => boolean>;

  beforeEach(() => {
    MemoryStorage.install();
    window.history.replaceState(null, "", "/projects");
    FakeNotification.install("granted");
    hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
  });

  it("notifies on a realtime transition while Bitig is in the background", () => {
    enable();
    renderDispatcher();
    emit({ ...OPEN, status: "done" });
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]?.title).toBe("ALP-1 · Ship it");
    expect(FakeNotification.instances[0]?.options).toMatchObject({ body: "Task completed", tag: `bitig:task:${OPEN.id}:done` });
    // The server echoing the same state does not notify twice.
    emit({ ...OPEN, status: "done" });
    expect(FakeNotification.instances).toHaveLength(1);
  });

  it("opens the task in the current view when the notification is clicked", () => {
    enable();
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    renderDispatcher();
    emit({ ...OPEN, needsHuman: "Which region?" });
    act(() => {
      FakeNotification.instances[0]?.click();
    });
    expect(focus).toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/projects?task=ALP-1");
  });

  it("names the task of an agent run", () => {
    enable();
    renderDispatcher();
    act(() => {
      dispatchRealtimeEvent({ type: "agent_run.updated", run: notifyRun(OPEN, "failed") });
    });
    expect(FakeNotification.instances[0]?.title).toBe("ALP-1 · Ship it");
    expect(FakeNotification.instances[0]?.options?.body).toBe("Agent run failed");
  });

  it("stays quiet while the tab is focused and does not fire late once it is not", () => {
    enable();
    hasFocus.mockReturnValue(true);
    renderDispatcher();
    emit({ ...OPEN, status: "done" });
    hasFocus.mockReturnValue(false);
    emit({ ...OPEN, status: "done" });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("respects the master switch, per-trigger toggles, and permission", () => {
    renderDispatcher();
    emit({ ...OPEN, status: "done" });
    expect(FakeNotification.instances).toHaveLength(0);

    act(() => { enable({ needsHuman: false }); });
    emit({ ...OPEN, needsHuman: "Pick one" });
    expect(FakeNotification.instances).toHaveLength(0);

    FakeNotification.permission = "denied";
    act(() => { window.dispatchEvent(new Event("focus")); });
    emit({ ...OPEN, pendingApproval: true });
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("does not announce state that was already loaded", () => {
    enable();
    const done = { ...OPEN, status: "done" as const };
    renderDispatcher([done]);
    emit(done);
    expect(FakeNotification.instances).toHaveLength(0);
  });
});

describe("useNotificationSettings", () => {
  beforeEach(() => {
    MemoryStorage.install();
  });

  it("reflects permission changes and preference saves live", async () => {
    FakeNotification.install("default");
    const { result } = renderHook(() => useNotificationSettings());
    expect(result.current.permission).toBe("default");
    expect(result.current.preferences.enabled).toBe(false);

    await act(async () => {
      await result.current.requestPermission();
    });
    expect(result.current.permission).toBe("granted");

    act(() => {
      result.current.setPreferences({ ...result.current.preferences, enabled: true });
    });
    expect(result.current.preferences.enabled).toBe(true);

    expect(result.current.sendTestNotification()).toBe(true);
    expect(FakeNotification.instances[0]?.options?.tag).toBe("bitig:test");
  });

  it("reports unsupported browsers", () => {
    const { result } = renderHook(() => useNotificationSettings());
    expect(result.current.permission).toBe("unsupported");
    expect(result.current.sendTestNotification()).toBe(false);
  });
});
