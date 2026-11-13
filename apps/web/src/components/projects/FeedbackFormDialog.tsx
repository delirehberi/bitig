import { useId, useRef, useState, type SyntheticEvent } from "react";
import { X } from "lucide-react";
import {
  FEEDBACK_EMAIL_MODES,
  FEEDBACK_FORM_NAME_MAX,
  FEEDBACK_FORM_TITLE_MAX,
  FEEDBACK_FORM_INTRO_MAX,
  FEEDBACK_THANK_YOU_TEXT_MAX,
  TASK_PRIORITIES,
  type FeedbackEmailMode,
  type TaskPriority,
} from "@bitig/core";
import type { FeedbackFormSummary } from "@bitig/api-client";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import {
  feedbackFormDraftFrom,
  emptyFeedbackFormDraft,
  type FeedbackFormDraft,
} from "./feedback-form-draft";

const ICON_SIZE = 16;
const FIELD_CLASS =
  "w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-xs text-ink disabled:opacity-50";
const LABEL_CLASS = "flex flex-col gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3";
const CHECK_CLASS = "flex items-center gap-2 text-xs font-medium normal-case tracking-normal text-ink";
const SAVE_ERROR_FALLBACK = "Could not save the feedback form.";

export interface FeedbackFormDialogProps {
  /** The form being edited, or `null` to create one. */
  readonly editing: FeedbackFormSummary | null;
  readonly onClose: () => void;
  /** Saves the draft. Resolving closes the dialog; rejecting keeps it open and shows the message. */
  readonly onSave: (draft: FeedbackFormDraft) => Promise<void>;
}

const EMAIL_LABELS: Readonly<Record<FeedbackEmailMode, string>> = {
  off: "Off",
  optional: "Optional",
  required: "Required",
};

export function FeedbackFormDialog({ editing, onClose, onSave }: FeedbackFormDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);
  const headingId = useId();
  const [draft, setDraft] = useState<FeedbackFormDraft>(() =>
    editing ? feedbackFormDraftFrom(editing) : emptyFeedbackFormDraft(),
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const idPrefix = useId();
  const fieldId = (name: string): string => `${idPrefix}-${name}`;

  function update<K extends keyof FeedbackFormDraft>(key: K, value: FeedbackFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(event: SyntheticEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (draft.name.trim().length === 0) {
      setError("Enter a name for the form.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await onSave(draft);
    } catch (err) {
      setError(err instanceof Error && err.message.length > 0 ? err.message : SAVE_ERROR_FALLBACK);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={headingId}
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-rule bg-paper p-6 shadow-lg outline-none"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>
        <h2 id={headingId} className="m-0 mb-4 pr-6 font-display text-lg font-bold text-ink">
          {editing ? "Edit feedback form" : "New feedback form"}
        </h2>

        <form className="flex flex-col gap-3.5" onSubmit={(e) => void handleSubmit(e)} noValidate>
          <label htmlFor={fieldId("name")} className={LABEL_CLASS}>
            Name
            <input
              id={fieldId("name")}
              className={FIELD_CLASS}
              value={draft.name}
              maxLength={FEEDBACK_FORM_NAME_MAX}
              onChange={(e) => {
                update("name", e.target.value);
              }}
              required
            />
          </label>

          <label htmlFor={fieldId("title")} className={LABEL_CLASS}>
            Title shown on the form
            <input
              id={fieldId("title")}
              className={FIELD_CLASS}
              value={draft.title}
              maxLength={FEEDBACK_FORM_TITLE_MAX}
              onChange={(e) => {
                update("title", e.target.value);
              }}
            />
          </label>

          <label htmlFor={fieldId("intro")} className={LABEL_CLASS}>
            Intro
            <textarea
              id={fieldId("intro")}
              className={`${FIELD_CLASS} min-h-16`}
              value={draft.intro}
              maxLength={FEEDBACK_FORM_INTRO_MAX}
              onChange={(e) => {
                update("intro", e.target.value);
              }}
            />
          </label>

          <div className="flex flex-wrap gap-4">
            <label className={CHECK_CLASS}>
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => {
                  update("enabled", e.target.checked);
                }}
              />
              Accepting submissions
            </label>
            <label className={CHECK_CLASS}>
              <input
                type="checkbox"
                checked={draft.turnstile}
                onChange={(e) => {
                  update("turnstile", e.target.checked);
                }}
              />
              Require Turnstile check
            </label>
          </div>

          <fieldset className="flex flex-col gap-3 rounded-md border border-rule p-3">
            <legend className="px-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">Fields</legend>
            <label htmlFor={fieldId("email")} className={LABEL_CLASS}>
              Email
              <select
                id={fieldId("email")}
                className={FIELD_CLASS}
                value={draft.emailMode}
                onChange={(e) => {
                  update("emailMode", e.target.value as FeedbackEmailMode);
                }}
              >
                {FEEDBACK_EMAIL_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {EMAIL_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>
            <label className={CHECK_CLASS}>
              <input
                type="checkbox"
                checked={draft.nameField}
                onChange={(e) => {
                  update("nameField", e.target.checked);
                }}
              />
              Ask for a name
            </label>
            <label htmlFor={fieldId("categories")} className={LABEL_CLASS}>
              Category options (one per line)
              <textarea
                id={fieldId("categories")}
                className={`${FIELD_CLASS} min-h-16 font-mono`}
                value={draft.categoriesText}
                onChange={(e) => {
                  update("categoriesText", e.target.value);
                }}
              />
            </label>
          </fieldset>

          <label htmlFor={fieldId("origins")} className={LABEL_CLASS}>
            Allowed origins for embeds (one per line)
            <textarea
              id={fieldId("origins")}
              className={`${FIELD_CLASS} min-h-16 font-mono`}
              placeholder="https://example.com"
              value={draft.allowedOriginsText}
              onChange={(e) => {
                update("allowedOriginsText", e.target.value);
              }}
            />
          </label>

          <fieldset className="flex flex-col gap-3 rounded-md border border-rule p-3">
            <legend className="px-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
              Tasks created from submissions
            </legend>
            <label htmlFor={fieldId("labels")} className={LABEL_CLASS}>
              Default labels (comma separated)
              <input
                id={fieldId("labels")}
                className={FIELD_CLASS}
                value={draft.labelsText}
                onChange={(e) => {
                  update("labelsText", e.target.value);
                }}
              />
            </label>
            <label htmlFor={fieldId("priority")} className={LABEL_CLASS}>
              Default priority
              <select
                id={fieldId("priority")}
                className={FIELD_CLASS}
                value={draft.defaultPriority}
                onChange={(e) => {
                  update("defaultPriority", e.target.value as TaskPriority | "");
                }}
              >
                <option value="">None</option>
                {TASK_PRIORITIES.map((priority) => (
                  <option key={priority} value={priority}>
                    {priority}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>

          <label htmlFor={fieldId("thanks")} className={LABEL_CLASS}>
            Thank-you text
            <textarea
              id={fieldId("thanks")}
              className={`${FIELD_CLASS} min-h-12`}
              value={draft.thankYouText}
              maxLength={FEEDBACK_THANK_YOU_TEXT_MAX}
              onChange={(e) => {
                update("thankYouText", e.target.value);
              }}
            />
          </label>

          <label htmlFor={fieldId("accent")} className={LABEL_CLASS}>
            Accent colour (hex, optional)
            <input
              id={fieldId("accent")}
              className={`${FIELD_CLASS} font-mono`}
              placeholder="#2563eb"
              value={draft.accentColor}
              onChange={(e) => {
                update("accentColor", e.target.value);
              }}
            />
          </label>

          {error && (
            <p role="alert" className="m-0 text-2xs text-danger">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-rule bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-2"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md border border-accent/40 bg-accent-soft px-3 py-1.5 text-xs font-semibold text-accent-ink hover:bg-accent-soft/80 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save form"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
