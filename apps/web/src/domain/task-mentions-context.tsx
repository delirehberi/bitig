import type { Project, Task } from "@bitig/core";
import { useMemo, type ReactNode } from "react";
import { buildBlockersResolver, buildMentionResolver, TaskBlockersContext, TaskMentionsContext } from "./task-mentions";

interface TaskMentionsProviderProps {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly children: ReactNode;
}

/**
 * Lets Markdown below it turn `#BIT-64` into links to the tasks in `tasks`, and cards and rows
 * show which unfinished tasks block a task.
 */
export function TaskMentionsProvider({ projects, tasks, children }: TaskMentionsProviderProps) {
  const resolve = useMemo(() => buildMentionResolver(projects, tasks), [projects, tasks]);
  const blockers = useMemo(() => buildBlockersResolver(projects, tasks), [projects, tasks]);
  return (
    <TaskMentionsContext.Provider value={resolve}>
      <TaskBlockersContext.Provider value={blockers}>{children}</TaskBlockersContext.Provider>
    </TaskMentionsContext.Provider>
  );
}
