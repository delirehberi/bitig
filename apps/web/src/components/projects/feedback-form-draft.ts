import {
  DEFAULT_FEEDBACK_FIELDS,
  DEFAULT_FEEDBACK_THANK_YOU_TEXT,
  DEFAULT_FEEDBACK_TURNSTILE,
  DEFAULT_FEEDBACK_ENABLED,
  type FeedbackEmailMode,
  type FeedbackForm,
  type TaskPriority,
  type UpdateFeedbackFormInput,
} from "@bitig/core";
import type { CreateFeedbackFormBody, FeedbackFormSummary } from "@bitig/api-client";

/**
 * The feedback form editor's state, as plain strings and booleans that the inputs bind to.
 * `draftToCreateInput` and `draftToUpdatePatch` turn it into the API bodies.
 */
export interface FeedbackFormDraft {
  readonly name: string;
  readonly title: string;
  readonly intro: string;
  readonly enabled: boolean;
  readonly emailMode: FeedbackEmailMode;
  readonly nameField: boolean;
  readonly categoriesText: string;
  readonly allowedOriginsText: string;
  readonly turnstile: boolean;
  readonly labelsText: string;
  /** Empty string means "no default priority". */
  readonly defaultPriority: TaskPriority | "";
  readonly thankYouText: string;
  /** Empty string means "theme accent". */
  readonly accentColor: string;
}

const LIST_SEPARATOR = "\n";
const LABEL_SEPARATOR = ",";

function parseLines(text: string): string[] {
  return text
    .split(LIST_SEPARATOR)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseLabels(text: string): string[] {
  return text
    .split(LABEL_SEPARATOR)
    .map((label) => label.trim())
    .filter((label) => label.length > 0);
}

function joinLines(values: readonly string[]): string {
  return values.join(LIST_SEPARATOR);
}

/** The draft for a new form, using the server's defaults. */
export function emptyFeedbackFormDraft(): FeedbackFormDraft {
  return {
    name: "",
    title: "",
    intro: "",
    enabled: DEFAULT_FEEDBACK_ENABLED,
    emailMode: DEFAULT_FEEDBACK_FIELDS.email,
    nameField: DEFAULT_FEEDBACK_FIELDS.name,
    categoriesText: "",
    allowedOriginsText: "",
    turnstile: DEFAULT_FEEDBACK_TURNSTILE,
    labelsText: "",
    defaultPriority: "",
    thankYouText: DEFAULT_FEEDBACK_THANK_YOU_TEXT,
    accentColor: "",
  };
}

/** The draft for editing an existing form. */
export function feedbackFormDraftFrom(form: FeedbackForm): FeedbackFormDraft {
  return {
    name: form.name,
    title: form.title,
    intro: form.intro,
    enabled: form.enabled,
    emailMode: form.fields.email,
    nameField: form.fields.name,
    categoriesText: joinLines(form.fields.categories),
    allowedOriginsText: joinLines(form.allowedOrigins),
    turnstile: form.turnstile,
    labelsText: (form.defaultLabels ?? []).join(LABEL_SEPARATOR + " "),
    defaultPriority: form.defaultPriority ?? "",
    thankYouText: form.thankYouText,
    accentColor: form.accentColor ?? "",
  };
}

/** Builds the create body. Empty optional values are left out, so the server applies its defaults. */
export function draftToCreateInput(draft: FeedbackFormDraft): CreateFeedbackFormBody {
  const title = draft.title.trim();
  const labels = parseLabels(draft.labelsText);
  const accentColor = draft.accentColor.trim();
  return {
    name: draft.name.trim(),
    ...(title.length > 0 ? { title } : {}),
    intro: draft.intro.trim(),
    enabled: draft.enabled,
    fields: {
      email: draft.emailMode,
      name: draft.nameField,
      categories: parseLines(draft.categoriesText),
    },
    allowedOrigins: parseLines(draft.allowedOriginsText),
    turnstile: draft.turnstile,
    thankYouText: draft.thankYouText.trim(),
    ...(labels.length > 0 ? { defaultLabels: labels } : {}),
    ...(draft.defaultPriority !== "" ? { defaultPriority: draft.defaultPriority } : {}),
    ...(accentColor.length > 0 ? { accentColor } : {}),
  };
}

/**
 * Builds the update patch for an existing form. Every editable field is sent, and cleared optional fields
 * are sent as `null`. The form's banned words and blocked IP hashes are kept as they are, since this editor
 * does not change them.
 */
export function draftToUpdatePatch(draft: FeedbackFormDraft, form: FeedbackFormSummary): UpdateFeedbackFormInput {
  const title = draft.title.trim();
  const labels = parseLabels(draft.labelsText);
  const accentColor = draft.accentColor.trim();
  return {
    name: draft.name.trim(),
    title: title.length > 0 ? title : form.title,
    intro: draft.intro.trim(),
    enabled: draft.enabled,
    fields: {
      ...form.fields,
      email: draft.emailMode,
      name: draft.nameField,
      categories: parseLines(draft.categoriesText),
    },
    allowedOrigins: parseLines(draft.allowedOriginsText),
    turnstile: draft.turnstile,
    thankYouText: draft.thankYouText.trim(),
    defaultLabels: labels.length > 0 ? labels : null,
    defaultPriority: draft.defaultPriority !== "" ? draft.defaultPriority : null,
    accentColor: accentColor.length > 0 ? accentColor : null,
  };
}
