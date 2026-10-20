import type { StorageMode } from "@bitig/core";
import { FolderKanban, Hand, ListTodo } from "lucide-react";
import type { ReactNode } from "react";
import { MODE_COPY } from "../domain/modes";
import type { HealthState } from "../hooks/useHealth";

interface OverviewProps {
  readonly mode: StorageMode;
  readonly health: HealthState;
  readonly projectsCount?: number;
  readonly tasksCount?: number;
  /** Tasks waiting on a person. */
  readonly needsHumanCount?: number;
  readonly onNavigate?: (tab: "projects" | "tasks" | "needs_human") => void;
}

const DOT_CLASS: Record<HealthState["kind"], string> = {
  checking: "bg-rule-strong",
  online: "bg-ok",
  unreachable: "bg-danger",
};

function WorkerStatus({ health }: { readonly health: HealthState }) {
  const label =
    health.kind === "checking" ? "Checking…" : health.kind === "online" ? "Online" : "Unreachable";

  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1" role="status">
      <span className="inline-flex items-center gap-2 font-semibold text-ink">
        <span aria-hidden="true" className={`size-2 rounded-pill ${DOT_CLASS[health.kind]}`} />
        {label}
      </span>
      {health.kind === "online" && (
        <code className="tabular-nums text-ink-3">v{health.version}</code>
      )}
      {health.kind === "unreachable" && <span className="text-sm text-ink-2">{health.reason}</span>}
    </span>
  );
}

function StatusRow({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-1 border-t border-rule py-4 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-sm text-ink-3">{term}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </div>
  );
}

export function Overview({
  mode,
  health,
  projectsCount = 0,
  tasksCount = 0,
  needsHumanCount = 0,
  onNavigate,
}: OverviewProps) {
  const modeCopy = MODE_COPY[mode];

  return (
    <div className="flex max-w-(--measure) flex-col gap-12">
      <section className="flex flex-col gap-4">
        <h1 className="m-0 font-display text-display font-bold tracking-tight text-ink leading-tight">
          Your agents keep the record.
        </h1>
        <p className="m-0 text-lg text-ink-2">
          Bitig is meant to be driven over MCP. Open this page now and then to check what your
          agents have written down.
        </p>
      </section>

      <section aria-labelledby="status-heading" className="flex flex-col gap-2">
        <h2 id="status-heading" className="m-0 font-display text-xl font-semibold">
          Status
        </h2>
        <dl className="m-0 border-b border-rule">
          <StatusRow term="Worker">
            <WorkerStatus health={health} />
          </StatusRow>
          <StatusRow term="Storage">
            <span className="font-semibold text-ink">{modeCopy.label}</span>
            <p className="m-0 mt-1 text-sm text-ink-2">{modeCopy.summary}</p>
          </StatusRow>
          <StatusRow term="Remote MCP">
            <span className="text-ink-2">Not connected yet</span>
          </StatusRow>
        </dl>
      </section>

      {projectsCount > 0 ? (
        <section
          aria-labelledby="summary-heading"
          className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
        >
          <h2 id="summary-heading" className="m-0 font-display text-lg font-semibold text-ink">
            Current Workspace
          </h2>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => onNavigate?.("projects")}
              className="flex flex-col items-start rounded-md border border-rule bg-paper-2 p-4 text-left transition-colors hover:border-rule-strong"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-ink-3">
                <FolderKanban size={14} />
                <span>Projects</span>
              </div>
              <span className="mt-2 font-display text-2xl font-bold text-ink">
                {projectsCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate?.("tasks")}
              className="flex flex-col items-start rounded-md border border-rule bg-paper-2 p-4 text-left transition-colors hover:border-rule-strong"
            >
              <div className="flex items-center gap-2 text-xs font-semibold text-ink-3">
                <ListTodo size={14} />
                <span>Tasks</span>
              </div>
              <span className="mt-2 font-display text-2xl font-bold text-ink">
                {tasksCount}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onNavigate?.("needs_human")}
              className={`flex flex-col items-start rounded-md border p-4 text-left transition-colors ${
                needsHumanCount > 0
                  ? "border-accent/30 bg-accent-soft hover:border-accent"
                  : "border-rule bg-paper-2 hover:border-rule-strong"
              }`}
            >
              <div
                className={`flex items-center gap-2 text-xs font-semibold ${
                  needsHumanCount > 0 ? "text-accent-ink" : "text-ink-3"
                }`}
              >
                <Hand size={14} />
                <span>Needs you</span>
              </div>
              <span className="mt-2 font-display text-2xl font-bold text-ink">
                {needsHumanCount}
              </span>
            </button>
          </div>
        </section>
      ) : (
        <section
          aria-labelledby="projects-heading"
          className="flex flex-col gap-3 rounded-lg bg-accent-soft px-6 py-6"
        >
          <h2 id="projects-heading" className="m-0 font-display text-xl font-semibold text-ink">
            No projects yet
          </h2>
          <p className="m-0 text-ink-2">
            Once remote MCP is connected, ask your agent to run <code>create_project</code> or click{" "}
            <button
              type="button"
              onClick={() => onNavigate?.("projects")}
              aria-label="Go to projects"
              className="font-semibold text-accent-ink hover:underline"
            >
              Projects
            </button>{" "}
            to create one manually.
          </p>
        </section>
      )}
    </div>
  );
}
