import { FEEDBACK_LABEL, type Task } from "@bitig/core";

/** Whether a task was created from a feedback form, which the server labels `feedback` (#BIT-179). */
export function isFeedbackTask(task: Pick<Task, "labels">): boolean {
  return task.labels?.includes(FEEDBACK_LABEL) === true;
}
