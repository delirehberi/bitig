import type { Project, Task } from "@bitig/core";
import { useMemo, type ReactNode } from "react";
import { buildMentionResolver, TaskMentionsContext } from "./task-mentions";

interface TaskMentionsProviderProps {
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly children: ReactNode;
}

/** Lets Markdown below it turn `#BIT-64` into links to the tasks in `tasks`. */
export function TaskMentionsProvider({ projects, tasks, children }: TaskMentionsProviderProps) {
  const resolve = useMemo(() => buildMentionResolver(projects, tasks), [projects, tasks]);
  return <TaskMentionsContext.Provider value={resolve}>{children}</TaskMentionsContext.Provider>;
}
