import { createContext } from "react";
import { withTaskCodes, type Project, type Task, type TaskStatus } from "@bitig/core";

/** What a `#BIT-64` mention shows about the task it names. */
export interface MentionTarget {
  readonly code: string;
  readonly title: string;
  readonly status: TaskStatus;
}

/** Looks up a normalised code (`BIT-64`); `undefined` leaves the mention as plain text. */
export type MentionResolver = (code: string) => MentionTarget | undefined;

/** Indexes the loaded tasks by code once, so rendering mentions needs no requests. */
export function buildMentionResolver(projects: readonly Project[], tasks: readonly Task[]): MentionResolver {
  const byCode = new Map<string, MentionTarget>();
  for (const task of withTaskCodes(tasks, projects)) {
    if (task.code !== undefined) byCode.set(task.code, { code: task.code, title: task.title, status: task.status });
  }
  return (code) => byCode.get(code);
}

/** Without a provider, Markdown renders mentions as plain text. */
export const TaskMentionsContext = createContext<MentionResolver | undefined>(undefined);
