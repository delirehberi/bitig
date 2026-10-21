import { createContext } from "react";
import { blockingTasks, withTaskCodes, type Project, type Task, type TaskStatus } from "@bitig/core";

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

/** The codes (or IDs) of the unfinished tasks a task waits on; empty when it is free to start. */
export type BlockersResolver = (task: Pick<Task, "dependsOn">) => string[];

/** Resolves blockers among the loaded tasks, so cards and rows need no requests. */
export function buildBlockersResolver(projects: readonly Project[], tasks: readonly Task[]): BlockersResolver {
  const byId = new Map(withTaskCodes(tasks, projects).map((t) => [t.id, t]));
  return (task) => blockingTasks(task, byId).map((t) => t.code ?? t.id);
}

/** Without a provider, cards and rows show no blocked badge. */
export const TaskBlockersContext = createContext<BlockersResolver | undefined>(undefined);
