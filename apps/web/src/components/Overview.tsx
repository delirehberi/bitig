import type { AgentRun, Project, StorageMode, T3ProjectActiveSession, Task } from "@bitig/core";
import { useMemo } from "react";
import { dispatchRealtimeEvent } from "../hooks/useRealtime";
import { useT3Runs } from "../hooks/useT3Runs";
import { Link } from "../routing/Link";
import { hrefFor } from "../routing/router";
import { dispatchTaskT3Run, startTaskT3Run, stopTaskT3Run } from "../services/t3";
import { buildAttentionItems, findStalledTasks, workingSessions } from "./dashboard/dashboard-model";
import { NeedsYou } from "./dashboard/NeedsYou";
import { Stalled } from "./dashboard/Stalled";
import { WorkingNow } from "./dashboard/WorkingNow";
import { resolveWorkspaceActiveSessions } from "./projects/activeSessions";
import { WhereYouLeftOff } from "./WhereYouLeftOff";

interface OverviewProps {
  readonly mode: StorageMode;
  /** Projects shown on the dashboard (not archived). */
  readonly projects?: readonly Project[];
  readonly tasks?: readonly Task[];
  readonly onArchiveTask?: (task: Task) => void;
  /** Overrides the T3 launch from the Stalled list; defaults to the Worker API in `cloudflare` mode. */
  readonly onStartT3Thread?: (task: Task) => Promise<void>;
  /** Overrides dispatching a queued run from Agents working now; defaults to the Worker API in `cloudflare` mode. */
  readonly onDispatchQueuedRun?: (taskId: string) => Promise<void>;
  /** Overrides cancelling a queued run from Agents working now; defaults to the Worker API in `cloudflare` mode. */
  readonly onCancelQueuedRun?: (taskId: string) => Promise<void>;
  /** T3 runs and sessions supplied by the caller (tests); the dashboard loads them itself otherwise. */
  readonly agentRuns?: readonly AgentRun[];
  readonly activeSessions?: readonly T3ProjectActiveSession[];
  /** The current time; tests pass a fixed one. */
  readonly now?: Date;
}

/**
 * The worker reconciles thread states with the T3 host only when runs are read, so the dashboard
 * polls to notice a thread that starts waiting on the person.
 */
export const DASHBOARD_T3_POLL_INTERVAL_MS = 30_000;

async function startT3ThreadFromDashboard(task: Task): Promise<void> {
  // Default model and an isolated worktree; the task view offers the full launch options.
  const launched = await startTaskT3Run(task.id);
  // Feed the result through the same channel as server pushes so every view updates at once.
  dispatchRealtimeEvent({ type: "task.updated", task: launched.task });
  dispatchRealtimeEvent({ type: "agent_run.updated", run: launched.run });
}

async function dispatchQueuedRunFromDashboard(taskId: string): Promise<void> {
  const updated = await dispatchTaskT3Run(taskId);
  if (updated.run) {
    dispatchRealtimeEvent({ type: "agent_run.updated", run: updated.run });
  }
}

async function cancelQueuedRunFromDashboard(taskId: string): Promise<void> {
  const updated = await stopTaskT3Run(taskId);
  if (updated.run) {
    dispatchRealtimeEvent({ type: "agent_run.updated", run: updated.run });
  }
}

export function Overview({
  mode,
  projects = [],
  tasks = [],
  onArchiveTask,
  onStartT3Thread,
  onDispatchQueuedRun,
  onCancelQueuedRun,
  agentRuns,
  activeSessions,
  now = new Date(),
}: OverviewProps) {
  const t3Available = mode === "cloudflare";
  const suppliedRuns = agentRuns !== undefined || activeSessions !== undefined;
  const t3Runs = useT3Runs({
    enabled: t3Available && !suppliedRuns,
    pollIntervalMs: DASHBOARD_T3_POLL_INTERVAL_MS,
  });
  const runs = agentRuns ?? t3Runs.runs;
  const sessionsInput = activeSessions ?? t3Runs.activeSessions;

  const sessions = useMemo(
    () => resolveWorkspaceActiveSessions(projects, tasks, runs, sessionsInput),
    [projects, tasks, runs, sessionsInput],
  );
  const dashboardInput = useMemo(() => ({ projects, tasks, runs, sessions }), [projects, tasks, runs, sessions]);
  const attention = useMemo(() => buildAttentionItems(dashboardInput), [dashboardInput]);
  const working = useMemo(() => workingSessions(sessions), [sessions]);
  const nowTime = now.getTime();
  const stalled = useMemo(() => findStalledTasks(dashboardInput, new Date(nowTime)), [dashboardInput, nowTime]);

  const startT3Thread = onStartT3Thread ?? (t3Available ? startT3ThreadFromDashboard : undefined);
  const dispatchQueued = onDispatchQueuedRun ?? (t3Available ? dispatchQueuedRunFromDashboard : undefined);
  const cancelQueued = onCancelQueuedRun ?? (t3Available ? cancelQueuedRunFromDashboard : undefined);

  return (
    <div className="flex flex-col gap-8">
      <h1 className="m-0 font-display text-display font-bold tracking-tight text-ink leading-tight">Overview</h1>

      {projects.length === 0 ? (
        <section
          aria-labelledby="projects-heading"
          className="flex flex-col gap-3 rounded-lg bg-accent-soft px-6 py-6"
        >
          <h2 id="projects-heading" className="m-0 font-display text-xl font-semibold text-ink">
            No projects yet
          </h2>
          <p className="m-0 text-ink-2">
            Ask your agent over MCP to run <code>create_project</code>, or open{" "}
            <Link href={hrefFor({ name: "projects" })} className="font-semibold text-accent-ink hover:underline">
              Projects
            </Link>{" "}
            to create one manually.
          </p>
        </section>
      ) : (
        <>
          <NeedsYou items={attention} now={now} onArchiveTask={onArchiveTask} />
          {t3Available && (
            <WorkingNow
              sessions={working}
              projects={projects}
              tasks={tasks}
              now={now}
              isLoading={!suppliedRuns && t3Runs.isLoading}
              error={suppliedRuns ? null : t3Runs.error}
              onRetry={() => {
                void t3Runs.refresh();
              }}
              onDispatchQueuedRun={dispatchQueued}
              onCancelQueuedRun={cancelQueued}
            />
          )}
          <Stalled stalled={stalled} now={now} onStartT3Thread={startT3Thread} />
          <WhereYouLeftOff projects={projects} tasks={tasks} now={now} />
        </>
      )}
    </div>
  );
}
