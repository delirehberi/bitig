import type { AgentRun, Project, Task } from "@bitig/core";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { taskRef } from "../domain/task-ref";
import { navigate, taskHref } from "../routing/router";
import { NotificationTracker, type TriggerLabels } from "../services/notification-triggers";
import {
  NOTIFICATION_PREFERENCES_KEY,
  NOTIFICATION_SETTINGS_EVENT,
  notificationPermission,
  parseNotificationPreferences,
  readStoredNotificationPreferences,
  requestNotificationPermission,
  saveNotificationPreferences,
  showBrowserNotification,
  type NotificationIntent,
  type NotificationPreferences,
  type NotificationSupport,
} from "../services/notifications";
import { useRealtimeEvent } from "./useRealtime";

const TEST_NOTIFICATION_TAG = "bitig:test";
const TEST_NOTIFICATION_TITLE = "Bitig notifications are on";
const TEST_NOTIFICATION_BODY = "You will be notified here when tasks finish or need you.";

function subscribe(onChange: () => void): () => void {
  function handleStorage(event: StorageEvent) {
    // Another tab changed the preferences; `key` is null when storage was cleared.
    if (event.key === null || event.key === NOTIFICATION_PREFERENCES_KEY) onChange();
  }
  window.addEventListener(NOTIFICATION_SETTINGS_EVENT, onChange);
  window.addEventListener("storage", handleStorage);
  // Permission can also change in the browser's site settings while the tab is in the background.
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener(NOTIFICATION_SETTINGS_EVENT, onChange);
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export interface NotificationSettings {
  readonly permission: NotificationSupport;
  readonly preferences: NotificationPreferences;
  /** Persists preferences; false when browser storage is unavailable. */
  readonly setPreferences: (preferences: NotificationPreferences) => boolean;
  readonly requestPermission: () => Promise<NotificationSupport>;
  /** Shows a sample notification; false when permission is not granted or it failed. */
  readonly sendTestNotification: () => boolean;
}

/** Notification permission and preferences, shared live between every caller and tab. */
export function useNotificationSettings(): NotificationSettings {
  const permission = useSyncExternalStore(subscribe, notificationPermission, () => "unsupported" as const);
  const stored = useSyncExternalStore(subscribe, readStoredNotificationPreferences, () => null);
  const preferences = useMemo(() => parseNotificationPreferences(stored), [stored]);

  const sendTestNotification = useCallback(
    () =>
      showBrowserNotification(
        {
          tag: TEST_NOTIFICATION_TAG,
          trigger: "taskCompleted",
          title: TEST_NOTIFICATION_TITLE,
          body: TEST_NOTIFICATION_BODY,
          taskRef: "",
        },
        () => undefined,
      ) !== null,
    [],
  );

  return {
    permission,
    preferences,
    setPreferences: saveNotificationPreferences,
    requestPermission: requestNotificationPermission,
    sendTestNotification,
  };
}

/** Bitig is in the background: another tab, another window, or a minimized browser. */
function isPageInactive(): boolean {
  return document.visibilityState === "hidden" || !document.hasFocus();
}

export interface NotificationDispatcherInput {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly agentRuns?: readonly AgentRun[];
}

/**
 * Raises browser notifications for realtime task and agent run transitions (#BIT-169).
 *
 * Only shown while Bitig is in the background, since the in-page dashboard already surfaces the
 * same attention items. Transitions are still recorded while the page is active or a trigger is
 * off, so they never fire late. Clicking a notification focuses the tab and opens the task.
 */
export function useNotificationDispatcher({ projects, tasks, agentRuns }: NotificationDispatcherInput): void {
  const { permission, preferences } = useNotificationSettings();
  const [tracker] = useState(() => new NotificationTracker());

  const latest = useRef({ projects, tasks, permission, preferences });
  useEffect(() => {
    latest.current = { projects, tasks, permission, preferences };
  });

  // Realtime handlers run synchronously on dispatch, before React re-renders with the new tasks,
  // so loaded state is only ever reconciled after the event has been judged.
  useEffect(() => {
    tracker.observeTasks(tasks);
  }, [tracker, tasks]);
  useEffect(() => {
    if (agentRuns) tracker.observeRuns(agentRuns);
  }, [tracker, agentRuns]);

  useRealtimeEvent((event) => {
    const current = latest.current;
    const labels: TriggerLabels = {
      forTask: (task) => ({ ref: taskRef(task, current.projects), title: task.title }),
      forTaskId: (taskId) => {
        const task = current.tasks.find((candidate) => candidate.id === taskId);
        return task === undefined ? undefined : { ref: taskRef(task, current.projects), title: task.title };
      },
    };
    const intents = tracker.handleEvent(event, labels);
    if (intents.length === 0) return;
    if (!current.preferences.enabled || current.permission !== "granted" || !isPageInactive()) return;
    for (const intent of intents) {
      if (current.preferences.triggers[intent.trigger]) showTaskNotification(intent);
    }
  });
}

function showTaskNotification(intent: NotificationIntent): void {
  showBrowserNotification(intent, () => {
    navigate(taskHref(intent.taskRef));
  });
}
