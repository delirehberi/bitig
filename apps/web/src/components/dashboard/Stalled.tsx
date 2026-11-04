import { Play, TimerOff } from "lucide-react";
import { useState } from "react";
import type { Task } from "@bitig/core";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { taskHref, useLocationHref } from "../../routing/router";
import type { StalledTask } from "./dashboard-model";

interface StalledProps {
  readonly stalled: readonly StalledTask[];
  readonly now: Date;
  /**
   * Starts a T3 thread for a task that never had one. Rejections are shown on the row, e.g. an
   * unmapped project or a missing T3 connection.
   */
  readonly onStartT3Thread?: ((task: Task) => Promise<void>) | undefined;
}

type StartState = { readonly kind: "starting" } | { readonly kind: "failed"; readonly message: string };

const UNKNOWN_START_FAILURE = "Could not start T3 thread";

const BUTTON_CLASS =
  "inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-50 focus-visible:outline-focus";

/** In-progress tasks nobody is working on. Renders nothing when there are none. */
export function Stalled({ stalled, now, onStartT3Thread }: StalledProps) {
  const locationHref = useLocationHref();
  const [startStates, setStartStates] = useState<ReadonlyMap<string, StartState>>(new Map());

  if (stalled.length === 0) return null;

  function setStartState(taskId: string, state: StartState | undefined) {
    setStartStates((prev) => {
      const next = new Map(prev);
      if (state === undefined) next.delete(taskId);
      else next.set(taskId, state);
      return next;
    });
  }

  async function handleStart(task: Task, start: (task: Task) => Promise<void>) {
    setStartState(task.id, { kind: "starting" });
    try {
      await start(task);
      setStartState(task.id, undefined);
    } catch (error: unknown) {
      setStartState(task.id, {
        kind: "failed",
        message: error instanceof Error && error.message ? error.message : UNKNOWN_START_FAILURE,
      });
    }
  }

  return (
    <section
      aria-labelledby="stalled-heading"
      className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <div className="flex items-center gap-2">
        <TimerOff size={18} className="text-ink-3" aria-hidden="true" />
        <h2 id="stalled-heading" className="m-0 font-display text-lg font-semibold text-ink">
          Stalled
        </h2>
        <span className="rounded-pill bg-paper-3 px-2 py-0.5 font-mono text-xs font-semibold text-ink-2">
          {stalled.length}
        </span>
        <span className="text-xs text-ink-3">In progress, but no agent is working on them</span>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Stalled tasks">
        {stalled.map(({ task, project, code, idleSince, lastRun }) => {
          const label = code ? `${code} ${task.title}` : task.title;
          const href = taskHref(code ?? task.id, locationHref);
          const startState = startStates.get(task.id);
          return (
            <li key={task.id} className="flex flex-col gap-1 rounded-md border border-rule bg-paper-2 p-3">
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Link
                  href={href}
                  aria-label={label}
                  className="flex min-w-0 items-baseline gap-2 text-sm font-semibold text-ink hover:text-accent-ink hover:underline"
                >
                  {code && <span className="shrink-0 font-mono text-xs text-ink-3">{code}</span>}
                  <span className="truncate">{task.title}</span>
                </Link>
                <div className="flex items-center gap-2">
                  {/* A task with an earlier run continues in its own thread from the task view. */}
                  {lastRun === undefined && onStartT3Thread && (
                    <button
                      type="button"
                      disabled={startState?.kind === "starting"}
                      onClick={() => {
                        void handleStart(task, onStartT3Thread);
                      }}
                      aria-label={`Start ${label} in T3`}
                      className={BUTTON_CLASS}
                    >
                      <Play size={12} aria-hidden="true" />
                      <span>{startState?.kind === "starting" ? "Starting…" : "Start in T3"}</span>
                    </button>
                  )}
                  <Link href={href} aria-label={`Open ${label}`} className={BUTTON_CLASS}>
                    Open
                  </Link>
                </div>
              </div>
              <span className="text-xs text-ink-3">
                {project.name}
                {" · last update "}
                <time dateTime={idleSince} title={formatFullTimestamp(idleSince)}>
                  {formatTimeAgo(idleSince, now)}
                </time>
                {lastRun !== undefined && " · T3 host offline"}
              </span>
              {startState?.kind === "failed" && (
                <p role="alert" className="m-0 text-xs text-danger">
                  {startState.message}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
