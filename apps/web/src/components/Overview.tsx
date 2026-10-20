import {
  aggregateTimeByProject,
  aggregateTimeByProjectAndWeek,
  exportTimeSpentCsv,
  formatDuration,
  type Project,
  type StorageMode,
  type Task,
  type TimeCsvExportMode,
} from "@bitig/core";
import { Clock, Download, FolderKanban, Hand, ListTodo, ShieldQuestionMark } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { MODE_COPY } from "../domain/modes";
import type { HealthState } from "../hooks/useHealth";

interface OverviewProps {
  readonly mode: StorageMode;
  readonly health: HealthState;
  readonly projects?: readonly Project[];
  readonly tasks?: readonly Task[];
  readonly projectsCount?: number;
  readonly tasksCount?: number;
  /** Tasks waiting on a person. */
  readonly needsHumanCount?: number;
  /** Tasks an agent or webhook created that wait for a person's approval. */
  readonly awaitingApprovalCount?: number;
  readonly onNavigate?: (tab: "projects" | "tasks" | "needs_human" | "awaiting_approval") => void;
  readonly onExportCsv?: (filename: string, csvContent: string, kind: TimeCsvExportMode) => void;
}

const ALL_PROJECTS_FILTER = "all";
const FULL_BAR_PERCENT = 100;
const MIN_VISIBLE_BAR_PERCENT = 4;
const EXPORT_BY_WEEK_FILENAME = "bitig-time-by-week.csv";
const EXPORT_BY_PROJECT_FILENAME = "bitig-time-by-project.csv";

function triggerBrowserCsvDownload(filename: string, csvContent: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") {
    return;
  }
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function computeBarPercent(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.max(MIN_VISIBLE_BAR_PERCENT, Math.round((value / max) * FULL_BAR_PERCENT));
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
  projects = [],
  tasks = [],
  projectsCount,
  tasksCount,
  needsHumanCount = 0,
  awaitingApprovalCount = 0,
  onNavigate,
  onExportCsv,
}: OverviewProps) {
  const modeCopy = MODE_COPY[mode];
  const [selectedProjectId, setSelectedProjectId] = useState<string>(ALL_PROJECTS_FILTER);

  const effectiveProjectsCount = projectsCount ?? projects.length;
  const effectiveTasksCount = tasksCount ?? tasks.length;

  const filteredProjects = useMemo(
    () =>
      selectedProjectId === ALL_PROJECTS_FILTER
        ? projects
        : projects.filter((p) => p.id === selectedProjectId),
    [projects, selectedProjectId],
  );

  const filteredTasks = useMemo(
    () =>
      selectedProjectId === ALL_PROJECTS_FILTER
        ? tasks
        : tasks.filter((t) => t.projectId === selectedProjectId),
    [tasks, selectedProjectId],
  );

  const byProject = useMemo(
    () => aggregateTimeByProject(filteredProjects, filteredTasks),
    [filteredProjects, filteredTasks],
  );

  const byWeek = useMemo(
    () => aggregateTimeByProjectAndWeek(filteredProjects, filteredTasks),
    [filteredProjects, filteredTasks],
  );

  const maxProjectSpentMs = useMemo(
    () => byProject.reduce((max, row) => Math.max(max, row.totalSpentMs), 0),
    [byProject],
  );

  const maxWeekSpentMs = useMemo(
    () => byWeek.reduce((max, row) => Math.max(max, row.totalSpentMs), 0),
    [byWeek],
  );

  function handleExportCsv(kind: TimeCsvExportMode) {
    const filename =
      kind === "by_week" ? EXPORT_BY_WEEK_FILENAME : EXPORT_BY_PROJECT_FILENAME;
    const csvContent = exportTimeSpentCsv(filteredProjects, filteredTasks, kind);
    if (onExportCsv) {
      onExportCsv(filename, csvContent, kind);
      return;
    }
    triggerBrowserCsvDownload(filename, csvContent);
  }

  return (
    <div className="flex flex-col gap-12">
      <section className="flex max-w-(--measure) flex-col gap-4">
        <h1 className="m-0 font-display text-display font-bold tracking-tight text-ink leading-tight">
          Your agents keep the record.
        </h1>
        <p className="m-0 text-lg text-ink-2">
          Bitig is meant to be driven over MCP. Open this page now and then to check what your
          agents have written down.
        </p>
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:items-start">
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

        {effectiveProjectsCount > 0 ? (
          <section
            aria-labelledby="summary-heading"
            className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
          >
            <h2 id="summary-heading" className="m-0 font-display text-lg font-semibold text-ink">
              Current Workspace
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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
                  {effectiveProjectsCount}
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
                  {effectiveTasksCount}
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
              <button
                type="button"
                onClick={() => onNavigate?.("awaiting_approval")}
                className={`flex flex-col items-start rounded-md p-4 text-left transition-colors ${
                  awaitingApprovalCount > 0
                    ? "border border-dashed border-rule-strong bg-paper-3 hover:border-ink-3"
                    : "border border-rule bg-paper-2 hover:border-rule-strong"
                }`}
              >
                <div
                  className={`flex items-center gap-2 text-xs font-semibold ${
                    awaitingApprovalCount > 0 ? "text-ink" : "text-ink-3"
                  }`}
                >
                  <ShieldQuestionMark size={14} />
                  <span>Awaiting approval</span>
                </div>
                <span className="mt-2 font-display text-2xl font-bold text-ink">
                  {awaitingApprovalCount}
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

      {effectiveProjectsCount > 0 && projects.length > 0 && (
        <section
          aria-labelledby="time-analytics-heading"
          className="flex flex-col gap-6 rounded-lg border border-rule bg-paper p-6 shadow-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Clock size={18} className="text-ink-3" aria-hidden="true" />
              <h2
                id="time-analytics-heading"
                className="m-0 font-display text-lg font-semibold text-ink"
              >
                Time Spent & Completion
              </h2>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                aria-label="Filter analytics by project"
                value={selectedProjectId}
                onChange={(e) => {
                  setSelectedProjectId(e.target.value);
                }}
                className="rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs font-semibold text-ink focus-visible:outline-focus"
              >
                <option value={ALL_PROJECTS_FILTER}>All projects</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <button
                type="button"
                onClick={() => {
                  handleExportCsv("by_project");
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-rule-strong hover:bg-paper-3 focus-visible:outline-focus"
              >
                <Download size={13} aria-hidden="true" />
                <span>Export by Project (CSV)</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  handleExportCsv("by_week");
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-rule-strong hover:bg-paper-3 focus-visible:outline-focus"
              >
                <Download size={13} aria-hidden="true" />
                <span>Export by Week (CSV)</span>
              </button>
            </div>
          </div>

          <div
            className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-start"
            data-testid="time-charts-grid"
          >
            <div className="flex flex-col gap-3">
              <h3 className="m-0 font-display text-xs font-semibold uppercase tracking-wider text-ink-3">
                By Project
              </h3>
              <div className="flex flex-col gap-3" data-testid="chart-by-project">
                {byProject.map((row) => {
                  const widthPct = computeBarPercent(row.totalSpentMs, maxProjectSpentMs);
                  return (
                    <div
                      key={row.projectId}
                      className="flex flex-col gap-1.5 rounded-md border border-rule/70 bg-paper-2 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <span className="font-semibold text-ink">{row.projectName}</span>
                        <div className="flex items-center gap-3 font-mono text-2xs text-ink-2">
                          <span>{formatDuration(row.totalSpentMs)}</span>
                          <span>{row.completedTasks} done</span>
                          {row.inProgressTasks > 0 && (
                            <span>{row.inProgressTasks} in progress</span>
                          )}
                        </div>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-pill bg-paper-3">
                        <div
                          className="h-full rounded-pill bg-accent transition-all"
                          style={{ width: `${String(widthPct)}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <h3 className="m-0 font-display text-xs font-semibold uppercase tracking-wider text-ink-3">
                By Week
              </h3>
              {byWeek.length === 0 ? (
                <p className="m-0 rounded-md border border-dashed border-rule bg-paper-2 p-4 text-xs text-ink-3">
                  No recorded task time yet. Move a task to In Progress or Done to track time.
                </p>
              ) : (
                <div className="flex flex-col gap-2.5" data-testid="chart-by-week">
                  {byWeek.map((row) => {
                    const widthPct = computeBarPercent(row.totalSpentMs, maxWeekSpentMs);
                    return (
                      <div
                        key={`${row.week}-${row.projectId}`}
                        className="flex flex-col gap-1.5 rounded-md border border-rule/70 bg-paper-2 p-3"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="flex items-center gap-2">
                            <span className="rounded bg-paper-3 px-1.5 py-0.5 font-mono text-2xs font-semibold text-ink">
                              {row.week}
                            </span>
                            <span className="font-semibold text-ink">{row.projectName}</span>
                          </div>
                          <div className="flex items-center gap-3 font-mono text-2xs text-ink-2">
                            <span>{formatDuration(row.totalSpentMs)}</span>
                            <span>{row.completedTasks} done</span>
                          </div>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-pill bg-paper-3">
                          <div
                            className="h-full rounded-pill bg-ok transition-all"
                            style={{ width: `${String(widthPct)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
