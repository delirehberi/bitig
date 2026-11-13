import { useEffect, useState } from "react";
import { MessageSquareText } from "lucide-react";
import { NotFoundError, type Task } from "@bitig/core";
import type { TaskFeedbackClient, TaskFeedbackDetail } from "@bitig/api-client";

interface TaskFeedbackPanelProps {
  readonly task: Task;
  readonly feedbackApi: Pick<TaskFeedbackClient, "getTaskFeedback">;
}

const LOAD_ERROR = "Could not load the feedback details.";
const NOT_SET = "Not provided";

function errorMessage(err: unknown): string {
  return err instanceof Error && err.message.length > 0 ? err.message : LOAD_ERROR;
}

/** Only http(s) page URLs become links; anything else is shown as plain text. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** The submission behind a feedback task: form, category, submitter and the page it was sent from (#BIT-181). */
export function TaskFeedbackPanel({ task, feedbackApi }: TaskFeedbackPanelProps) {
  const [detail, setDetail] = useState<TaskFeedbackDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    feedbackApi
      .getTaskFeedback(task.id, { signal: controller.signal })
      .then((loaded) => {
        setDetail(loaded);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // A feedback task without an entry has nothing to show; the panel stays hidden.
        if (err instanceof NotFoundError) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      controller.abort();
    };
  }, [feedbackApi, task.id]);

  if (loadError === null && detail === null) {
    return null;
  }
  if (loadError !== null) {
    return (
      <section aria-labelledby="task-detail-feedback" className="mb-5">
        <h3 id="task-detail-feedback" className="m-0 mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3">
          Feedback
        </h3>
        <p role="alert" className="m-0 text-xs text-danger">
          {loadError}
        </p>
      </section>
    );
  }
  if (detail === null) return null;

  const submitterName = detail.submitter.name ?? NOT_SET;
  const submitterEmail = detail.submitter.email;

  return (
    <section aria-labelledby="task-detail-feedback" className="mb-5 rounded-md border border-dashed border-rule-strong bg-paper-3 p-3">
      <h3 id="task-detail-feedback" className="m-0 mb-2 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
        <MessageSquareText size={12} aria-hidden="true" />
        Feedback
      </h3>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs">
        <dt className="text-ink-3">Form</dt>
        <dd className="m-0 text-ink">{detail.form?.name ?? NOT_SET}</dd>

        <dt className="text-ink-3">Category</dt>
        <dd className="m-0 text-ink">{detail.category ?? NOT_SET}</dd>

        <dt className="text-ink-3">Submitter</dt>
        <dd className="m-0 text-ink">
          {submitterName}
          {submitterEmail !== undefined && <span className="text-ink-3"> · {submitterEmail}</span>}
        </dd>

        <dt className="text-ink-3">Page</dt>
        <dd className="m-0 break-all text-ink">
          {detail.pageUrl === undefined ? (
            NOT_SET
          ) : isHttpUrl(detail.pageUrl) ? (
            <a href={detail.pageUrl} target="_blank" rel="noopener noreferrer" className="text-accent-ink underline">
              {detail.pageUrl}
            </a>
          ) : (
            detail.pageUrl
          )}
        </dd>
      </dl>
    </section>
  );
}
