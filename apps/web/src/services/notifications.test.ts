import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeNotification, MemoryStorage } from "../test/notification-fixtures";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  NOTIFICATION_PREFERENCES_KEY,
  NOTIFICATION_SETTINGS_EVENT,
  loadNotificationPreferences,
  notificationPermission,
  parseNotificationPreferences,
  requestNotificationPermission,
  saveNotificationPreferences,
  showBrowserNotification,
  type NotificationIntent,
} from "./notifications";

const INTENT: NotificationIntent = {
  tag: "bitig:task:1:done",
  trigger: "taskCompleted",
  title: "ALP-1 · Ship it",
  body: "Task completed",
  taskRef: "ALP-1",
};

describe("notification preferences", () => {
  beforeEach(() => {
    MemoryStorage.install();
  });

  it("defaults to disabled, and to not saving, when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadNotificationPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(saveNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES)).toBe(false);
  });

  it("defaults to disabled with every trigger on", () => {
    expect(loadNotificationPreferences()).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(DEFAULT_NOTIFICATION_PREFERENCES.enabled).toBe(false);
  });

  it("falls back to defaults for malformed or partial values", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(parseNotificationPreferences("{not json")).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(parseNotificationPreferences("[]")).toEqual(DEFAULT_NOTIFICATION_PREFERENCES);
    expect(parseNotificationPreferences(JSON.stringify({ enabled: true, triggers: { agentRun: false, needsHuman: "no" } }))).toEqual({
      enabled: true,
      triggers: { taskCompleted: true, needsHuman: true, awaitingApproval: true, agentRun: false },
    });
  });

  it("persists toggles and announces the change", () => {
    const listener = vi.fn();
    window.addEventListener(NOTIFICATION_SETTINGS_EVENT, listener);
    const next = { enabled: true, triggers: { ...DEFAULT_NOTIFICATION_PREFERENCES.triggers, taskCompleted: false } };
    expect(saveNotificationPreferences(next)).toBe(true);
    expect(loadNotificationPreferences()).toEqual(next);
    expect(window.localStorage.getItem(NOTIFICATION_PREFERENCES_KEY)).not.toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(NOTIFICATION_SETTINGS_EVENT, listener);
  });

  it("reports a failed save when storage rejects the write", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(MemoryStorage.install(), "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    expect(saveNotificationPreferences(DEFAULT_NOTIFICATION_PREFERENCES)).toBe(false);
  });
});

describe("notification permission", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unsupported when the Notification API is missing", async () => {
    expect("Notification" in window).toBe(false);
    expect(notificationPermission()).toBe("unsupported");
    await expect(requestNotificationPermission()).resolves.toBe("unsupported");
    expect(showBrowserNotification(INTENT, vi.fn())).toBeNull();
  });

  it("reads and requests permission", async () => {
    FakeNotification.install("default");
    expect(notificationPermission()).toBe("default");
    FakeNotification.nextPermission = "denied";
    await expect(requestNotificationPermission()).resolves.toBe("denied");
    expect(notificationPermission()).toBe("denied");
  });

  it("only shows notifications once permission is granted", () => {
    FakeNotification.install("default");
    expect(showBrowserNotification(INTENT, vi.fn())).toBeNull();
    FakeNotification.install("denied");
    expect(showBrowserNotification(INTENT, vi.fn())).toBeNull();
    expect(FakeNotification.instances).toHaveLength(0);
  });

  it("shows a tagged notification that focuses the tab and runs the click handler", () => {
    FakeNotification.install("granted");
    const focus = vi.spyOn(window, "focus").mockImplementation(() => undefined);
    const onClick = vi.fn();
    expect(showBrowserNotification(INTENT, onClick)).not.toBeNull();
    const [shown] = FakeNotification.instances;
    expect(shown?.title).toBe(INTENT.title);
    expect(shown?.options).toMatchObject({ body: INTENT.body, tag: INTENT.tag });
    shown?.click();
    expect(focus).toHaveBeenCalled();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(shown?.close).toHaveBeenCalled();
  });

  it("returns null when the browser refuses to construct a notification", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    class ThrowingNotification extends FakeNotification {
      constructor(title: string) {
        super(title);
        throw new TypeError("Illegal constructor");
      }
    }
    FakeNotification.install("granted");
    vi.stubGlobal("Notification", ThrowingNotification);
    expect(showBrowserNotification(INTENT, vi.fn())).toBeNull();
  });
});
