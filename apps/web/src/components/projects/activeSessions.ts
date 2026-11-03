import {
  isActiveAgentRunState,
  taskCode,
  type ActiveAgentRunState,
  type AgentRun,
  type Project,
  type T3ProjectActiveSession,
  type Task,
} from "@bitig/core";

export interface ResolvedProjectActiveSession {
  readonly threadId: string;
  readonly projectId: string;
  readonly state: ActiveAgentRunState;
  readonly taskId?: string | undefined;
  readonly taskCode?: string | undefined;
  readonly title: string;
  readonly link?: string | undefined;
  readonly model?: string | undefined;
}

function cleanT3Link(rawLink: string | undefined): string | undefined {
  if (!rawLink) return undefined;
  const trimmed = rawLink.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveProjectActiveSessions(
  project: Project,
  tasks: readonly Task[],
  runs: readonly AgentRun[] = [],
  activeSessions: readonly T3ProjectActiveSession[] = [],
): ResolvedProjectActiveSession[] {
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const seenThreadIds = new Set<string>();
  const resolved: ResolvedProjectActiveSession[] = [];

  for (const run of runs) {
    if (!isActiveAgentRunState(run.state)) continue;
    const task = tasksById.get(run.taskId);
    if (task?.projectId !== project.id) continue;
    seenThreadIds.add(run.threadId);
    const code = taskCode(task, project);
    const link = cleanT3Link(run.link);
    resolved.push({
      threadId: run.threadId,
      projectId: project.id,
      state: run.state,
      taskId: task.id,
      ...(code ? { taskCode: code } : {}),
      title: task.title,
      ...(link ? { link } : {}),
      ...(run.model ? { model: run.model } : {}),
    });
  }

  for (const session of activeSessions) {
    if (session.projectId !== project.id) continue;
    if (!isActiveAgentRunState(session.state)) continue;
    if (seenThreadIds.has(session.threadId)) continue;
    seenThreadIds.add(session.threadId);
    const task = session.taskId ? tasksById.get(session.taskId) : undefined;
    const code = task ? taskCode(task, project) : undefined;
    const link = cleanT3Link(session.link);
    resolved.push({
      threadId: session.threadId,
      projectId: project.id,
      state: session.state,
      ...(task ? { taskId: task.id } : session.taskId ? { taskId: session.taskId } : {}),
      ...(code ? { taskCode: code } : {}),
      title: task?.title ?? session.title ?? session.threadId,
      ...(link ? { link } : {}),
      ...(session.model ? { model: session.model } : {}),
    });
  }

  return resolved;
}
