import { useEffect, useState } from "react";
import { Copy, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { FeedbackFormSummary } from "@bitig/api-client";
import { useApiStorage } from "../../hooks/useStorage";
import { formatTimeAgo } from "../../domain/time-ago";
import { buildFeedbackIframeSnippet, buildFeedbackScriptSnippet } from "../../domain/feedback-snippets";
import { FeedbackFormDialog } from "./FeedbackFormDialog";
import { draftToCreateInput, draftToUpdatePatch, type FeedbackFormDraft } from "./feedback-form-draft";

const ICON_SIZE = 12;
const ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1 text-2xs font-semibold text-ink-2 hover:bg-paper-2 disabled:opacity-50";
const DANGER_ACTION_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-danger/40 bg-paper px-2 py-1 text-2xs font-semibold text-danger hover:bg-paper-2 disabled:opacity-50";
const NEVER_SUBMITTED = "never";
const LOAD_ERROR = "Could not load feedback forms.";
const CLIPBOARD_UNAVAILABLE = "Clipboard is not available in this browser.";
const COPY_NOTICE_LABELS = {
  link: "Link copied.",
  iframe: "iframe snippet copied.",
  script: "Script snippet copied.",
} as const;

type CopyKind = keyof typeof COPY_NOTICE_LABELS;

interface ConfirmAction {
  readonly kind: "rotate" | "delete";
  readonly form: FeedbackFormSummary;
}

interface DialogTarget {
  readonly editing: FeedbackFormSummary | null;
}

export interface ProjectFeedbackPanelProps {
  readonly projectId: string;
  /** Editors and above can change forms; viewers see the list and copy or preview links only. */
  readonly canEdit: boolean;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.length > 0 ? err.message : fallback;
}

/** Lists a project's feedback forms with their embed snippets and, for editors, the management actions. */
export function ProjectFeedbackPanel({ projectId, canEdit }: ProjectFeedbackPanelProps) {
  const storage = useApiStorage();
  const [forms, setForms] = useState<FeedbackFormSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogTarget | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [busyFormId, setBusyFormId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    storage
      .listFeedbackForms(projectId, { signal: controller.signal })
      .then((loaded) => {
        setForms(loaded);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setLoadError(errorMessage(err, LOAD_ERROR));
      });
    return () => {
      controller.abort();
    };
  }, [storage, projectId]);

  function replaceForm(updated: FeedbackFormSummary): void {
    setForms((prev) => prev?.map((form) => (form.id === updated.id ? updated : form)) ?? prev);
  }

  async function copyText(text: string, kind: CopyKind): Promise<void> {
    setNotice(null);
    setActionError(null);
    // Clipboard is missing on insecure origins, so its presence is checked at runtime.
    const clipboard = (navigator as Partial<Navigator>).clipboard;
    if (!clipboard) {
      setActionError(CLIPBOARD_UNAVAILABLE);
      return;
    }
    try {
      await clipboard.writeText(text);
      setNotice(COPY_NOTICE_LABELS[kind]);
    } catch (err) {
      setActionError(errorMessage(err, "Could not copy to the clipboard."));
    }
  }

  async function saveDraft(draft: FeedbackFormDraft): Promise<void> {
    const editing = dialog?.editing ?? null;
    if (editing) {
      const updated = await storage.updateFeedbackForm(editing.id, draftToUpdatePatch(draft, editing));
      replaceForm(updated);
    } else {
      const created = await storage.createFeedbackForm(projectId, draftToCreateInput(draft));
      setForms((prev) => [...(prev ?? []), created]);
    }
    setDialog(null);
    setNotice(editing ? "Form saved." : "Form created.");
  }

  async function runFormAction(form: FeedbackFormSummary, action: () => Promise<void>): Promise<void> {
    setNotice(null);
    setActionError(null);
    setBusyFormId(form.id);
    try {
      await action();
    } catch (err) {
      setActionError(errorMessage(err, "The change could not be saved."));
    } finally {
      setBusyFormId(null);
    }
  }

  function toggleEnabled(form: FeedbackFormSummary): Promise<void> {
    return runFormAction(form, async () => {
      replaceForm(await storage.updateFeedbackForm(form.id, { enabled: !form.enabled }));
      setNotice(form.enabled ? "Form paused." : "Form is accepting submissions.");
    });
  }

  function rotateLink(form: FeedbackFormSummary): Promise<void> {
    return runFormAction(form, async () => {
      replaceForm(await storage.rotateFeedbackFormPublicId(form.id));
      setConfirm(null);
      setNotice("Link rotated. The old link and embeds no longer work.");
    });
  }

  function deleteForm(form: FeedbackFormSummary): Promise<void> {
    return runFormAction(form, async () => {
      await storage.deleteFeedbackForm(form.id);
      setForms((prev) => prev?.filter((item) => item.id !== form.id) ?? prev);
      setConfirm(null);
      setNotice("Form deleted.");
    });
  }

  return (
    <section aria-labelledby="project-feedback-title" className="mb-5 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="project-feedback-title" className="m-0 text-2xs font-semibold uppercase tracking-wider text-ink-3">
          Feedback forms
        </h3>
        {canEdit && forms !== null && (
          <button
            type="button"
            onClick={() => {
              setNotice(null);
              setActionError(null);
              setDialog({ editing: null });
            }}
            className={ACTION_CLASS}
          >
            <Plus size={ICON_SIZE} aria-hidden="true" />
            New form
          </button>
        )}
      </div>

      {loadError && (
        <p role="alert" className="m-0 text-2xs text-danger">
          {loadError}
        </p>
      )}
      {forms === null && !loadError && <p className="m-0 text-xs text-ink-3">Loading feedback forms...</p>}
      {forms !== null && forms.length === 0 && (
        <p className="m-0 text-xs text-ink-3">No feedback forms yet.</p>
      )}

      {forms?.map((form) => {
        const isBusy = busyFormId === form.id;
        const pending = confirm?.form.id === form.id ? confirm : null;
        return (
          <article key={form.id} className="flex flex-col gap-2 rounded-md border border-rule bg-paper-2 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">{form.name}</span>
              <span
                className={`rounded-pill px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
                  form.enabled ? "bg-ok-soft text-ok" : "bg-paper-3 text-ink-3"
                }`}
              >
                {form.enabled ? "Accepting" : "Paused"}
              </span>
            </div>
            <p className="m-0 text-2xs text-ink-3">
              {form.pendingCount} pending · {form.submissionCount} submissions · last submission{" "}
              {form.lastSubmittedAt ? formatTimeAgo(form.lastSubmittedAt) : NEVER_SUBMITTED}
            </p>

            <div className="flex flex-wrap gap-1.5">
              <button type="button" className={ACTION_CLASS} onClick={() => void copyText(form.publicUrl, "link")}>
                <Copy size={ICON_SIZE} aria-hidden="true" />
                Copy link
              </button>
              <button
                type="button"
                className={ACTION_CLASS}
                onClick={() => void copyText(buildFeedbackIframeSnippet(form), "iframe")}
              >
                <Copy size={ICON_SIZE} aria-hidden="true" />
                Copy iframe
              </button>
              <button
                type="button"
                className={ACTION_CLASS}
                onClick={() => void copyText(buildFeedbackScriptSnippet(form), "script")}
              >
                <Copy size={ICON_SIZE} aria-hidden="true" />
                Copy script
              </button>
              <a href={form.publicUrl} target="_blank" rel="noopener noreferrer" className={ACTION_CLASS}>
                <ExternalLink size={ICON_SIZE} aria-hidden="true" />
                Preview
              </a>
              {canEdit && (
                <>
                  <button
                    type="button"
                    className={ACTION_CLASS}
                    disabled={isBusy}
                    onClick={() => {
                      setNotice(null);
                      setActionError(null);
                      setDialog({ editing: form });
                    }}
                  >
                    <Pencil size={ICON_SIZE} aria-hidden="true" />
                    Edit
                  </button>
                  <button type="button" className={ACTION_CLASS} disabled={isBusy} onClick={() => void toggleEnabled(form)}>
                    {form.enabled ? "Pause" : "Enable"}
                  </button>
                  <button
                    type="button"
                    className={ACTION_CLASS}
                    disabled={isBusy}
                    onClick={() => {
                      setNotice(null);
                      setActionError(null);
                      setConfirm({ kind: "rotate", form });
                    }}
                  >
                    <RefreshCw size={ICON_SIZE} aria-hidden="true" />
                    Rotate link
                  </button>
                  <button
                    type="button"
                    className={DANGER_ACTION_CLASS}
                    disabled={isBusy}
                    onClick={() => {
                      setNotice(null);
                      setActionError(null);
                      setConfirm({ kind: "delete", form });
                    }}
                  >
                    <Trash2 size={ICON_SIZE} aria-hidden="true" />
                    Delete
                  </button>
                </>
              )}
            </div>

            {pending && (
              <div role="alertdialog" aria-label={pending.kind === "rotate" ? "Confirm link rotation" : "Confirm delete"} className="flex flex-wrap items-center gap-2 rounded-md border border-rule bg-paper p-2 text-2xs text-ink-2">
                <span>
                  {pending.kind === "rotate"
                    ? "Rotating the link breaks the current link and every embed of this form. Continue?"
                    : `Delete "${form.name}" and all of its submissions? This cannot be undone.`}
                </span>
                <button
                  type="button"
                  className={pending.kind === "rotate" ? ACTION_CLASS : DANGER_ACTION_CLASS}
                  disabled={isBusy}
                  onClick={() => void (pending.kind === "rotate" ? rotateLink(form) : deleteForm(form))}
                >
                  {pending.kind === "rotate" ? "Rotate" : "Delete"}
                </button>
                <button
                  type="button"
                  className={ACTION_CLASS}
                  disabled={isBusy}
                  onClick={() => {
                    setConfirm(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            )}
          </article>
        );
      })}

      {notice && (
        <p role="status" className="m-0 text-2xs text-ink-3">
          {notice}
        </p>
      )}
      {actionError && (
        <p role="alert" className="m-0 text-2xs text-danger">
          {actionError}
        </p>
      )}

      {dialog && (
        <FeedbackFormDialog
          editing={dialog.editing}
          onClose={() => {
            setDialog(null);
          }}
          onSave={saveDraft}
        />
      )}
    </section>
  );
}
