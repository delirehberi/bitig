import { AlertTriangle, Bell, BellOff, CheckCircle2, Send } from "lucide-react";
import { useState } from "react";
import { useNotificationSettings } from "../../hooks/useBrowserNotifications";
import {
  NOTIFICATION_TRIGGERS,
  type NotificationPreferences,
  type NotificationSupport,
  type NotificationTrigger,
} from "../../services/notifications";

const TRIGGER_COPY: Readonly<Record<NotificationTrigger, { readonly label: string; readonly hint: string }>> = {
  taskCompleted: { label: "Task completed", hint: "A task moves to done." },
  needsHuman: { label: "Human input required", hint: "An agent marks a task as needing you." },
  awaitingApproval: { label: "Task awaiting approval", hint: "An agent or webhook creates a task for you to approve." },
  agentRun: { label: "Agent run needs attention", hint: "A T3 run waits for approval, finishes, fails, or stops." },
};

const PERMISSION_COPY: Readonly<Record<NotificationSupport, string>> = {
  granted: "Allowed",
  denied: "Blocked",
  default: "Not requested",
  unsupported: "Not supported",
};

const SAVE_FAILED = "Could not save your notification settings: browser storage is unavailable.";
const TEST_FAILED = "The test notification could not be shown.";
const DENIED_HELP = "Notifications are blocked for this site. Allow them in your browser's site settings, then return to this tab.";
const UNSUPPORTED_HELP = "This browser does not support desktop notifications.";

function PermissionBadge({ permission }: { readonly permission: NotificationSupport }) {
  const tone =
    permission === "granted"
      ? "border-accent/30 bg-accent-soft text-accent-ink"
      : permission === "denied"
        ? "border-danger/30 bg-danger-soft text-danger"
        : "border-rule bg-paper-2 text-ink-3";
  const Icon = permission === "granted" ? CheckCircle2 : permission === "default" ? Bell : AlertTriangle;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-pill border px-3 py-1 text-xs font-semibold ${tone}`}>
      <Icon size={13} aria-hidden="true" />
      Permission: {PERMISSION_COPY[permission]}
    </span>
  );
}

/** Browser notification permission and per-event toggles (#BIT-169). */
export function NotificationsPanel() {
  const { permission, preferences, setPreferences, requestPermission, sendTestNotification } = useNotificationSettings();
  const [error, setError] = useState<string | null>(null);
  const [isRequesting, setIsRequesting] = useState(false);

  function save(next: NotificationPreferences) {
    setError(setPreferences(next) ? null : SAVE_FAILED);
  }

  async function handleEnable() {
    setIsRequesting(true);
    try {
      const result = permission === "granted" ? permission : await requestPermission();
      if (result === "granted") save({ ...preferences, enabled: true });
    } finally {
      setIsRequesting(false);
    }
  }

  function handleTest() {
    setError(sendTestNotification() ? null : TEST_FAILED);
  }

  const canNotify = permission === "granted";
  const isOn = preferences.enabled && canNotify;

  return (
    <section
      aria-labelledby="notifications-heading"
      className="flex flex-col gap-5 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="notifications-heading" className="m-0 flex items-center gap-2 font-display text-lg font-bold text-ink">
            <Bell size={18} aria-hidden="true" className="text-accent-ink" />
            Browser notifications
          </h2>
          <p className="m-0 text-xs text-ink-2">
            Get a desktop notification while Bitig is in another tab or window. Settings are saved in this browser.
          </p>
        </div>
        <PermissionBadge permission={permission} />
      </div>

      {error && (
        <div role="alert" className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {permission === "unsupported" && <p role="note" className="m-0 text-sm text-ink-2">{UNSUPPORTED_HELP}</p>}
      {permission === "denied" && <p role="note" className="m-0 text-sm text-ink-2">{DENIED_HELP}</p>}

      <div className="flex flex-wrap gap-2">
        {isOn ? (
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-md border border-rule px-4 py-2 text-sm font-semibold text-ink hover:bg-paper-2"
            onClick={() => { save({ ...preferences, enabled: false }); }}
          >
            <BellOff size={15} aria-hidden="true" />
            Turn off notifications
          </button>
        ) : (
          <button
            type="button"
            disabled={isRequesting || permission === "unsupported" || permission === "denied"}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => { void handleEnable(); }}
          >
            <Bell size={15} aria-hidden="true" />
            Enable notifications
          </button>
        )}
        <button
          type="button"
          disabled={!canNotify}
          className="inline-flex items-center gap-2 rounded-md border border-rule px-4 py-2 text-sm font-semibold text-ink hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={handleTest}
        >
          <Send size={15} aria-hidden="true" />
          Send test notification
        </button>
      </div>

      <fieldset disabled={!isOn} className="m-0 flex flex-col gap-3 border-0 p-0 disabled:opacity-60">
        <legend className="mb-2 p-0 text-sm font-semibold text-ink">Notify me when</legend>
        {NOTIFICATION_TRIGGERS.map((trigger) => (
          <label key={trigger} className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preferences.triggers[trigger]}
              onChange={(event) => {
                save({ ...preferences, triggers: { ...preferences.triggers, [trigger]: event.target.checked } });
              }}
            />
            <span className="flex flex-col">
              <span className="font-medium">{TRIGGER_COPY[trigger].label}</span>
              <span className="text-xs text-ink-2">{TRIGGER_COPY[trigger].hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}
