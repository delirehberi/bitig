import { createContext } from "react";
import type { Task } from "@bitig/core";

/**
 * Actions and bulk-selection state the Awaiting approval view hands to pending feedback cards (#BIT-181).
 * Cards outside that view see `null` and show the plain approval note.
 */
export interface FeedbackTaskControls {
  readonly onMerge: (task: Task) => void;
  readonly onReject: (task: Task) => void;
  readonly onSpam: (task: Task) => void;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelect: (task: Task) => void;
}

export const FeedbackTaskControlsContext = createContext<FeedbackTaskControls | null>(null);
