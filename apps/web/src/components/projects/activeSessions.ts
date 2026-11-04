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
  /** When the run started; only known for task runs Bitig launched. */
  readonly startedAt?: string | undefined;
  /** The last time the run or thread changed. */
  readonly updatedAt?: string | undefined;
}

const SAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/**
 * Trims a T3 thread link and keeps it only if it is http(s), so a malformed value from the T3
 * host can never be rendered as a `javascript:` href.
 */
export function cleanT3Link(rawLink: string | undefined): string | undefined {
  if (!rawLink) return undefined;
  const trimmed = rawLink.trim().replace(/^<|>$/g, "").trim();
  if (trimmed.length === 0) return undefined;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(trimmed).protocol) ? trimmed : undefined;
  } catch {
    // Not an absolute URL, so it cannot be opened as a thread link.
    return undefined;
  }
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
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
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
      ...(session.updatedAt ? { updatedAt: session.updatedAt } : {}),
    });
  }

  return resolved;
}

/**
 * Active sessions across every given project, in project order. A thread belongs to one project,
 * so the per-project de-duplication by thread id also holds workspace-wide.
 */
export function resolveWorkspaceActiveSessions(
  projects: readonly Project[],
  tasks: readonly Task[],
  runs: readonly AgentRun[] = [],
  activeSessions: readonly T3ProjectActiveSession[] = [],
): ResolvedProjectActiveSession[] {
  return projects.flatMap((project) => resolveProjectActiveSessions(project, tasks, runs, activeSessions));
}
