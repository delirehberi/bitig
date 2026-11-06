import {
  isActiveAgentRunState,
  taskCode,
  type AgentRun,
  type AgentRunState,
  type Project,
  type Task,
} from "@bitig/core";
import { cleanT3Link, type ResolvedProjectActiveSession } from "../projects/activeSessions";

/** Why a row sits in the "Needs you" inbox, most urgent first. */
export const ATTENTION_REASONS = [
  "thread_waiting",
  "needs_human",
  "agent_stopped",
  "review_done",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

const REASON_RANK: Record<AttentionReason, number> = Object.fromEntries(
  ATTENTION_REASONS.map((reason, index) => [reason, index]),
) as Record<AttentionReason, number>;

/**
 * Run states where the agent's turn ended while its task is still in progress, so a person has
 * to review the result or send the agent on. `offline` is not here: the host is unreachable and
 * nothing is waiting on the person, so those tasks show as stalled instead.
 */
const ENDED_RUN_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["finished", "failed", "stopped"]);

/** An in-progress task counts as stalled once nothing has touched it for this long. */
export const STALLED_AFTER_MS = 3_600_000;

export interface AttentionItem {
  /** Stable React key: the task id, or the thread id for a project-level thread. */
  readonly key: string;
  readonly reason: AttentionReason;
  readonly title: string;
  readonly task?: Task | undefined;
  readonly project?: Project | undefined;
  readonly code?: string | undefined;
  /** When the item started waiting; the inbox sorts oldest first within a reason. */
  readonly since: string;
  /** The question for `needs_human`, the run state for `agent_stopped`. */
  readonly detail?: string | undefined;
  /** The T3 thread, when one is known. */
  readonly threadLink?: string | undefined;
  readonly branch?: string | undefined;
  readonly headSha?: string | undefined;
  readonly diffStat?: AgentRun["diffStat"];
  readonly pullRequestUrls?: readonly string[] | undefined;
}

export interface StalledTask {
  readonly task: Task;
  readonly project: Project;
  readonly code?: string | undefined;
  /** The task's last update. */
  readonly idleSince: string;
  /** The task's last T3 run, if it ever had one (it is then `offline`). */
  readonly lastRun?: AgentRun | undefined;
}

export interface DashboardInput {
  /** Projects shown on the dashboard; tasks of other (e.g. archived) projects are ignored. */
  readonly projects: readonly Project[];
  readonly tasks: readonly Task[];
  readonly runs: readonly AgentRun[];
  /** Active sessions already resolved for the same projects. */
  readonly sessions: readonly ResolvedProjectActiveSession[];
}

/**
 * Tasks the dashboard considers: in a shown project, not archived, and not in Backlog
 * (`pendingApproval`). Backlog tasks wait for approval on the Tasks page, not here.
 */
function tasksInProjects(projects: readonly Project[], tasks: readonly Task[]): Task[] {
  const projectIds = new Set(projects.map((project) => project.id));
  return tasks.filter(
    (task) => projectIds.has(task.projectId) && task.status !== "archived" && task.pendingApproval !== true,
  );
}

function compareAttention(a: AttentionItem, b: AttentionItem): number {
  return REASON_RANK[a.reason] - REASON_RANK[b.reason] || a.since.localeCompare(b.since) || a.key.localeCompare(b.key);
}

/**
 * Everything waiting on a person, one row per task (its most urgent reason) plus one row per
 * project-level thread waiting for input. Sorted by reason, then longest waiting first.
 */
export function buildAttentionItems({ projects, tasks, runs, sessions }: DashboardInput): AttentionItem[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const visibleTasks = tasksInProjects(projects, tasks);
  const tasksById = new Map(visibleTasks.map((task) => [task.id, task]));
  const runsByTaskId = new Map(runs.map((run) => [run.taskId, run]));
  const byTask = new Map<string, AttentionItem>();
  const threadItems: AttentionItem[] = [];

  function offer(item: AttentionItem): void {
    const existing = byTask.get(item.key);
    if (existing === undefined || REASON_RANK[item.reason] < REASON_RANK[existing.reason]) byTask.set(item.key, item);
  }

  function taskItem(task: Task, reason: AttentionReason, since: string, extra: Partial<AttentionItem> = {}): AttentionItem {
    const project = projectsById.get(task.projectId);
    const run = runsByTaskId.get(task.id);
    return {
      key: task.id,
      reason,
      title: task.title,
      task,
      project,
      code: taskCode(task, project),
      since,
      ...(run?.branch ? { branch: run.branch } : {}),
      ...(run?.headSha ? { headSha: run.headSha } : {}),
      ...(run?.diffStat ? { diffStat: run.diffStat } : {}),
      ...(run?.pullRequestUrls && run.pullRequestUrls.length > 0 ? { pullRequestUrls: run.pullRequestUrls } : {}),
      ...extra,
    };
  }

  for (const session of sessions) {
    if (session.state !== "waiting_for_approval") continue;
    const since = session.updatedAt ?? session.startedAt ?? "";
    if (session.taskId !== undefined) {
      // A task thread only counts while its task is shown: not archived, not in Backlog.
      const task = tasksById.get(session.taskId);
      if (task !== undefined) offer(taskItem(task, "thread_waiting", since, { threadLink: session.link }));
      continue;
    }
    threadItems.push({
      key: session.threadId,
      reason: "thread_waiting",
      title: session.title,
      project: projectsById.get(session.projectId),
      code: session.taskCode,
      since,
      threadLink: session.link,
      ...(session.branch ? { branch: session.branch } : {}),
      ...(session.headSha ? { headSha: session.headSha } : {}),
      ...(session.diffStat ? { diffStat: session.diffStat } : {}),
      ...(session.pullRequestUrls && session.pullRequestUrls.length > 0 ? { pullRequestUrls: session.pullRequestUrls } : {}),
    });
  }

  for (const run of runs) {
    if (!ENDED_RUN_STATES.has(run.state)) continue;
    const task = tasksById.get(run.taskId);
    if (task?.status !== "in_progress") continue;
    offer(taskItem(task, "agent_stopped", run.updatedAt, { detail: run.state, threadLink: cleanT3Link(run.link) }));
  }

  for (const task of visibleTasks) {
    if (task.needsHuman !== undefined) offer(taskItem(task, "needs_human", task.updatedAt, { detail: task.needsHuman }));
    if (task.status === "done") offer(taskItem(task, "review_done", task.completedAt ?? task.updatedAt));
  }

  return [...byTask.values(), ...threadItems].sort(compareAttention);
}

/** Threads an agent is working on right now (including umbrella sessions waiting on a child task), longest running first. */
export function workingSessions(sessions: readonly ResolvedProjectActiveSession[]): ResolvedProjectActiveSession[] {
  return sessions
    .filter((session) => session.state === "working" || session.state === "waiting_subagent")
    .sort((a, b) => {
      const aSince = a.startedAt ?? a.updatedAt ?? "";
      const bSince = b.startedAt ?? b.updatedAt ?? "";
      return aSince.localeCompare(bSince) || a.threadId.localeCompare(b.threadId);
    });
}

/**
 * In-progress tasks no agent is working on: no active thread, no ended run waiting for review,
 * no open question, and idle for at least `STALLED_AFTER_MS`. Longest idle first.
 */
export function findStalledTasks({ projects, tasks, runs, sessions }: DashboardInput, now: Date): StalledTask[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const runsByTask = new Map(runs.map((run) => [run.taskId, run]));
  const activeTaskIds = new Set(
    sessions.flatMap((session) => (session.taskId === undefined ? [] : [session.taskId])),
  );
  const cutoff = now.getTime() - STALLED_AFTER_MS;
  const stalled: StalledTask[] = [];

  for (const task of tasksInProjects(projects, tasks)) {
    if (task.status !== "in_progress" || task.needsHuman !== undefined) continue;
    if (activeTaskIds.has(task.id)) continue;
    const run = runsByTask.get(task.id);
    // Active runs are working; ended runs are already in the inbox as `agent_stopped`.
    if (run !== undefined && (isActiveAgentRunState(run.state) || ENDED_RUN_STATES.has(run.state))) continue;
    const updatedAt = Date.parse(task.updatedAt);
    if (Number.isNaN(updatedAt) || updatedAt > cutoff) continue;
    const project = projectsById.get(task.projectId);
    if (project === undefined) continue;
    stalled.push({ task, project, code: taskCode(task, project), idleSince: task.updatedAt, lastRun: run });
  }

  return stalled.sort((a, b) => a.idleSince.localeCompare(b.idleSince) || a.task.id.localeCompare(b.task.id));
}
