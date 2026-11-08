/**
 * Browser notification support (#BIT-169): capability and permission checks around the Web
 * Notification API, plus the user's notification preferences persisted in `localStorage`.
 */

export const NOTIFICATION_TRIGGERS = ["taskCompleted", "needsHuman", "awaitingApproval", "agentRun"] as const;
export type NotificationTrigger = (typeof NOTIFICATION_TRIGGERS)[number];

export interface NotificationPreferences {
  /** Master switch: nothing is shown while false. */
  readonly enabled: boolean;
  readonly triggers: Readonly<Record<NotificationTrigger, boolean>>;
}

/** Notifications are opt-in; every trigger is on once the user enables them. */
export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  enabled: false,
  triggers: { taskCompleted: true, needsHuman: true, awaitingApproval: true, agentRun: true },
};

export const NOTIFICATION_PREFERENCES_KEY = "bitig.notifications";
/** Dispatched on `window` after this tab changes preferences or permission. */
export const NOTIFICATION_SETTINGS_EVENT = "bitig:notification-settings";

/** The browser's permission, or `unsupported` when the Notification API is unavailable. */
export type NotificationSupport = NotificationPermission | "unsupported";

export interface NotificationIntent {
  /** Deduplication key, also passed as the Notification `tag` so the browser replaces repeats. */
  readonly tag: string;
  readonly trigger: NotificationTrigger;
  readonly title: string;
  readonly body: string;
  /** Ticket code (or ID) of the task to open on click. */
  readonly taskRef: string;
}

const NOTIFICATION_ICON = "/favicon.svg";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses stored preferences, falling back to the defaults for anything missing or malformed. */
export function parseNotificationPreferences(raw: string | null): NotificationPreferences {
  if (raw === null) return DEFAULT_NOTIFICATION_PREFERENCES;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    console.warn("ignoring malformed notification preferences", error);
    return DEFAULT_NOTIFICATION_PREFERENCES;
  }
  if (!isRecord(parsed)) return DEFAULT_NOTIFICATION_PREFERENCES;
  const storedTriggers = isRecord(parsed.triggers) ? parsed.triggers : {};
  const triggers = { ...DEFAULT_NOTIFICATION_PREFERENCES.triggers };
  for (const trigger of NOTIFICATION_TRIGGERS) {
    const value = storedTriggers[trigger];
    if (typeof value === "boolean") triggers[trigger] = value;
  }
  return {
    enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    triggers,
  };
}

function localStorageOrNull(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    // Typed as possibly missing: some runtimes (e.g. Node's own global) expose no usable storage.
    const storage = window.localStorage as Storage | undefined;
    return storage ?? null;
  } catch (error) {
    // Some browsers throw on access when storage is disabled (e.g. strict privacy settings).
    console.warn("localStorage is unavailable", error);
    return null;
  }
}

/** The raw stored preferences string; a stable primitive suitable for `useSyncExternalStore`. */
export function readStoredNotificationPreferences(): string | null {
  const storage = localStorageOrNull();
  if (storage === null) return null;
  try {
    return storage.getItem(NOTIFICATION_PREFERENCES_KEY);
  } catch (error) {
    console.warn("could not read notification preferences", error);
    return null;
  }
}

export function loadNotificationPreferences(): NotificationPreferences {
  return parseNotificationPreferences(readStoredNotificationPreferences());
}

/** Persists preferences; returns false when storage is unavailable or full. */
export function saveNotificationPreferences(preferences: NotificationPreferences): boolean {
  const storage = localStorageOrNull();
  if (storage === null) return false;
  try {
    storage.setItem(NOTIFICATION_PREFERENCES_KEY, JSON.stringify(preferences));
  } catch (error) {
    console.warn("could not save notification preferences", error);
    return false;
  }
  window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_EVENT));
  return true;
}

export function isNotificationSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function notificationPermission(): NotificationSupport {
  return isNotificationSupported() ? window.Notification.permission : "unsupported";
}

/** Asks the browser for permission; resolves to the resulting state without throwing. */
export async function requestNotificationPermission(): Promise<NotificationSupport> {
  if (!isNotificationSupported()) return "unsupported";
  let permission: NotificationPermission;
  try {
    permission = await window.Notification.requestPermission();
  } catch (error) {
    console.warn("notification permission request failed", error);
    permission = window.Notification.permission;
  }
  window.dispatchEvent(new Event(NOTIFICATION_SETTINGS_EVENT));
  return permission;
}

/**
 * Shows a notification when the API is available and permission is granted; returns it, or
 * null when nothing could be shown. `onClick` runs after the window is focused.
 */
export function showBrowserNotification(intent: NotificationIntent, onClick: () => void): Notification | null {
  if (notificationPermission() !== "granted") return null;
  let notification: Notification;
  try {
    notification = new window.Notification(intent.title, {
      body: intent.body,
      tag: intent.tag,
      icon: NOTIFICATION_ICON,
    });
  } catch (error) {
    // Chrome on Android only allows notifications through a service worker and throws here.
    console.warn("could not show browser notification", error);
    return null;
  }
  notification.onclick = (event) => {
    event.preventDefault();
    window.focus();
    onClick();
    notification.close();
  };
  return notification;
}
