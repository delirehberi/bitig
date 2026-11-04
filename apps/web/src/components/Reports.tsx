import {
  aggregateTimeByProject,
  aggregateTimeByProjectAndWeek,
  exportTimeSpentCsv,
  formatDuration,
  type Project,
  type Task,
  type TimeCsvExportMode,
} from "@bitig/core";
import { Clock, Download } from "lucide-react";
import { useMemo, useState } from "react";

interface ReportsProps {
  readonly projects?: readonly Project[];
  readonly tasks?: readonly Task[];
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

/** Time spent and completion per project and week, with CSV export. */
export function Reports({ projects = [], tasks = [], onExportCsv }: ReportsProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string>(ALL_PROJECTS_FILTER);

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
    <div className="flex flex-col gap-8">
      <h1 className="m-0 font-display text-display font-bold tracking-tight text-ink leading-tight">Reports</h1>
      {projects.length === 0 ? (
        <p className="m-0 rounded-md border border-dashed border-rule bg-paper-2 p-4 text-sm text-ink-3">
          No projects yet. Reports appear once projects have tasks.
        </p>
      ) : (
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
