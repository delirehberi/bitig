import { GitMerge, ShieldAlert, XCircle } from "lucide-react";
import type { Task } from "@bitig/core";
import type { FeedbackTaskControls } from "./feedback-task-controls";

interface FeedbackReviewButtonsProps {
  readonly task: Task;
  readonly controls: FeedbackTaskControls;
}

const ICON_SIZE = 12;
const BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-semibold transition-colors hover:bg-paper-2 focus-visible:outline-focus";

/** Merge, Reject and Spam for a pending feedback task, shown beside Approve on its card (#BIT-181). */
export function FeedbackReviewButtons({ task, controls }: FeedbackReviewButtonsProps) {
  return (
    <>
      <button
        type="button"
        onClick={() => {
          controls.onMerge(task);
        }}
        className={`${BUTTON_CLASS} border-rule bg-paper text-ink`}
      >
        <GitMerge size={ICON_SIZE} aria-hidden="true" />
        Merge
      </button>
      <button
        type="button"
        onClick={() => {
          controls.onReject(task);
        }}
        className={`${BUTTON_CLASS} border-danger/30 bg-danger-soft text-danger`}
      >
        <XCircle size={ICON_SIZE} aria-hidden="true" />
        Reject
      </button>
      <button
        type="button"
        onClick={() => {
          controls.onSpam(task);
        }}
        className={`${BUTTON_CLASS} border-danger/30 bg-paper text-danger`}
      >
        <ShieldAlert size={ICON_SIZE} aria-hidden="true" />
        Spam
      </button>
    </>
  );
}
