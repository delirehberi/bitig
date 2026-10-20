/**
 * Pure time-tracking, aggregation, and CSV export helpers for tasks and subtasks.
 */
import type { Project, Task } from "./types";

const MS_PER_SECOND = 1_000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

const MS_PER_MINUTE = MS_PER_SECOND * SECONDS_PER_MINUTE;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
const MS_PER_DAY = MS_PER_HOUR * HOURS_PER_DAY;

const ISO_THURSDAY_OFFSET = 4;
const ISO_SUNDAY_DAY = 7;
const DECIMAL_PLACES = 100;

const FORMULA_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r"]);

export interface TaskTiming {
  readonly createdAt: string;
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;
  /** Milliseconds between `createdAt` and `startedAt` when `startedAt` is recorded. */
  readonly leadTimeMs: number | undefined;
  /** Active work duration in milliseconds (`completedAt - (startedAt ?? createdAt)`, or elapsed since `startedAt`). */
  readonly spentMs: number | undefined;
  /** Total elapsed milliseconds from `createdAt` to `completedAt` when completed. */
  readonly totalTurnaroundMs: number | undefined;
}

export interface SubtaskTiming {
  readonly index: number;
  readonly text: string;
  readonly done: boolean;
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;
  readonly spentMs: number | undefined;
}

export interface ProjectTimeSummary {
  readonly projectId: string;
  readonly projectName: string;
  readonly projectKey: string | undefined;
  readonly completedTasks: number;
  readonly inProgressTasks: number;
  readonly totalTasks: number;
  readonly totalSpentMs: number;
  readonly averageSpentMs: number;
}

export interface WeeklyProjectTimeRow {
  readonly week: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly projectKey: string | undefined;
  readonly completedTasks: number;
  readonly totalSpentMs: number;
}

export type TimeCsvExportMode = "by_week" | "by_project";

function clampNonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Computes lifecycle timestamps and durations for a task.
 * Pass `nowMs` when you want live elapsed time for an `in_progress` task.
 */
export function getTaskTiming(task: Task, nowMs?: number): TaskTiming {
  const createdMs = Date.parse(task.createdAt);
  const startedMs = task.startedAt !== undefined ? Date.parse(task.startedAt) : undefined;
  const completedMs = task.completedAt !== undefined ? Date.parse(task.completedAt) : undefined;

  const leadTimeMs =
    startedMs !== undefined && Number.isFinite(startedMs) && Number.isFinite(createdMs)
      ? clampNonNegative(startedMs - createdMs)
      : undefined;

  let spentMs: number | undefined;
  if (completedMs !== undefined && Number.isFinite(completedMs)) {
    const anchorMs = startedMs !== undefined && Number.isFinite(startedMs) ? startedMs : createdMs;
    spentMs = clampNonNegative(completedMs - anchorMs);
  } else if (task.status === "done") {
    const updatedMs = Date.parse(task.updatedAt);
    const anchorMs = startedMs !== undefined && Number.isFinite(startedMs) ? startedMs : createdMs;
    if (Number.isFinite(updatedMs) && Number.isFinite(anchorMs)) {
      spentMs = clampNonNegative(updatedMs - anchorMs);
    }
  } else if (task.status === "in_progress" && startedMs !== undefined) {
    const endMs = nowMs ?? Date.parse(task.updatedAt);
    if (Number.isFinite(endMs) && Number.isFinite(startedMs)) {
      spentMs = clampNonNegative(endMs - startedMs);
    }
  }

  const totalTurnaroundMs =
    completedMs !== undefined && Number.isFinite(completedMs) && Number.isFinite(createdMs)
      ? clampNonNegative(completedMs - createdMs)
      : undefined;

  return {
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    leadTimeMs,
    spentMs,
    totalTurnaroundMs,
  };
}

/**
 * Computes timestamps and durations for each subtask in `task.checklist`.
 * When a completed subtask has no explicit `startedAt`, its duration is anchored
 * to the previous completed subtask's `completedAt` (or `task.startedAt ?? task.createdAt`).
 */
export function getSubtaskTimings(task: Task, nowMs?: number): SubtaskTiming[] {
  const items = task.checklist ?? [];
  const taskAnchorIso = task.startedAt ?? task.createdAt;
  let previousCompletedMs = Date.parse(taskAnchorIso);

  return items.map((item, index) => {
    const explicitStartMs = item.startedAt !== undefined ? Date.parse(item.startedAt) : undefined;
    const completedMs = item.completedAt !== undefined ? Date.parse(item.completedAt) : undefined;

    let spentMs: number | undefined;
    if (completedMs !== undefined && Number.isFinite(completedMs)) {
      const anchorMs =
        explicitStartMs !== undefined && Number.isFinite(explicitStartMs)
          ? explicitStartMs
          : previousCompletedMs <= completedMs
            ? previousCompletedMs
            : Date.parse(taskAnchorIso);
      spentMs = clampNonNegative(completedMs - anchorMs);
      if (completedMs >= previousCompletedMs) {
        previousCompletedMs = completedMs;
      }
    } else if (!item.done && explicitStartMs !== undefined && nowMs !== undefined) {
      spentMs = clampNonNegative(nowMs - explicitStartMs);
    }

    return {
      index,
      text: item.text,
      done: item.done,
      startedAt: item.startedAt,
      completedAt: item.completedAt,
      spentMs,
    };
  });
}

/**
 * Formats a duration in milliseconds into a compact human-readable string (e.g. `20m`, `3h 20m`, `2d 4h`).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  if (ms < MS_PER_MINUTE) return "< 1m";

  const totalMinutes = Math.floor(ms / MS_PER_MINUTE);
  if (totalMinutes < MINUTES_PER_HOUR) {
    return `${String(totalMinutes)}m`;
  }

  const totalHours = Math.floor(ms / MS_PER_HOUR);
  const remainingMinutes = totalMinutes % MINUTES_PER_HOUR;
  if (totalHours < HOURS_PER_DAY) {
    return remainingMinutes > 0
      ? `${String(totalHours)}h ${String(remainingMinutes)}m`
      : `${String(totalHours)}h`;
  }

  const days = Math.floor(totalHours / HOURS_PER_DAY);
  const remainingHours = totalHours % HOURS_PER_DAY;
  return remainingHours > 0 ? `${String(days)}d ${String(remainingHours)}h` : `${String(days)}d`;
}

/**
 * Returns the ISO 8601 week key (`YYYY-Www`, UTC) for an ISO timestamp.
 */
export function isoWeekKey(isoTimestamp: string): string {
  const parsed = new Date(isoTimestamp);
  if (Number.isNaN(parsed.getTime())) return "unknown";

  const utcDate = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
  const dayNum = utcDate.getUTCDay() || ISO_SUNDAY_DAY;
  utcDate.setUTCDate(utcDate.getUTCDate() + ISO_THURSDAY_OFFSET - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utcDate.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / DAYS_PER_WEEK);
  return `${String(utcDate.getUTCFullYear())}-W${String(weekNo).padStart(2, "0")}`;
}

function isCompletedTaskStatus(task: Task): boolean {
  return task.status === "done" || (task.status === "archived" && task.completedAt !== undefined);
}

/**
 * Aggregates spent time and task counts grouped by project.
 */
export function aggregateTimeByProject(
  projects: readonly Project[],
  tasks: readonly Task[],
  nowMs?: number,
): ProjectTimeSummary[] {
  const tasksByProject = new Map<string, Task[]>();
  for (const task of tasks) {
    const group = tasksByProject.get(task.projectId);
    if (group) {
      group.push(task);
    } else {
      tasksByProject.set(task.projectId, [task]);
    }
  }

  const summaries: ProjectTimeSummary[] = projects.map((project) => {
    const projectTasks = tasksByProject.get(project.id) ?? [];
    let completedTasks = 0;
    let inProgressTasks = 0;
    let totalSpentMs = 0;

    for (const task of projectTasks) {
      const timing = getTaskTiming(task, nowMs);
      if (isCompletedTaskStatus(task)) {
        completedTasks += 1;
      } else if (task.status === "in_progress") {
        inProgressTasks += 1;
      }
      if (timing.spentMs !== undefined) {
        totalSpentMs += timing.spentMs;
      }
    }

    const averageSpentMs = completedTasks > 0 ? Math.round(totalSpentMs / completedTasks) : 0;

    return {
      projectId: project.id,
      projectName: project.name,
      projectKey: project.key,
      completedTasks,
      inProgressTasks,
      totalTasks: projectTasks.length,
      totalSpentMs,
      averageSpentMs,
    };
  });

  return summaries.sort(
    (a, b) =>
      b.totalSpentMs - a.totalSpentMs ||
      b.completedTasks - a.completedTasks ||
      a.projectName.localeCompare(b.projectName),
  );
}

/**
 * Aggregates spent time grouped by ISO week and project, newest week first.
 */
export function aggregateTimeByProjectAndWeek(
  projects: readonly Project[],
  tasks: readonly Task[],
  nowMs?: number,
): WeeklyProjectTimeRow[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const buckets = new Map<
    string,
    {
      week: string;
      projectId: string;
      projectName: string;
      projectKey: string | undefined;
      completedTasks: number;
      totalSpentMs: number;
    }
  >();

  for (const task of tasks) {
    const project = projectsById.get(task.projectId);
    if (!project) continue;

    const timing = getTaskTiming(task, nowMs);
    const completed = isCompletedTaskStatus(task);
    if (!completed && (timing.spentMs === undefined || timing.spentMs === 0)) continue;

    const timestampForWeek = task.completedAt ?? task.startedAt ?? task.updatedAt;
    const week = isoWeekKey(timestampForWeek);
    const bucketKey = `${week}::${project.id}`;
    const existing = buckets.get(bucketKey);

    if (existing) {
      if (completed) existing.completedTasks += 1;
      existing.totalSpentMs += timing.spentMs ?? 0;
    } else {
      buckets.set(bucketKey, {
        week,
        projectId: project.id,
        projectName: project.name,
        projectKey: project.key,
        completedTasks: completed ? 1 : 0,
        totalSpentMs: timing.spentMs ?? 0,
      });
    }
  }

  return [...buckets.values()].sort(
    (a, b) =>
      b.week.localeCompare(a.week) ||
      b.totalSpentMs - a.totalSpentMs ||
      a.projectName.localeCompare(b.projectName),
  );
}

function roundToTwoDecimals(value: number): number {
  return Math.round(value * DECIMAL_PLACES) / DECIMAL_PLACES;
}

function escapeCsvCell(raw: string | number): string {
  const text = String(raw);
  const firstChar = text[0];
  const safeText = firstChar !== undefined && FORMULA_PREFIXES.has(firstChar) ? `'${text}` : text;
  if (safeText.includes(",") || safeText.includes('"') || safeText.includes("\n") || safeText.includes("\r")) {
    return `"${safeText.replaceAll('"', '""')}"`;
  }
  return safeText;
}

/**
 * Exports spent time as an RFC 4180 CSV string, either grouped by project & ISO week (`by_week`)
 * or summarized by project (`by_project`).
 */
export function exportTimeSpentCsv(
  projects: readonly Project[],
  tasks: readonly Task[],
  mode: TimeCsvExportMode,
  nowMs?: number,
): string {
  if (mode === "by_week") {
    const rows = aggregateTimeByProjectAndWeek(projects, tasks, nowMs);
    const header = [
      "Week",
      "Project Key",
      "Project Name",
      "Completed Tasks",
      "Total Spent (Minutes)",
      "Total Spent (Hours)",
      "Formatted Duration",
    ].join(",");

    const lines = rows.map((row) =>
      [
        row.week,
        row.projectKey ?? "",
        row.projectName,
        row.completedTasks,
        roundToTwoDecimals(row.totalSpentMs / MS_PER_MINUTE),
        roundToTwoDecimals(row.totalSpentMs / MS_PER_HOUR),
        formatDuration(row.totalSpentMs),
      ]
        .map(escapeCsvCell)
        .join(","),
    );
    return [header, ...lines].join("\n");
  }

  const summaries = aggregateTimeByProject(projects, tasks, nowMs);
  const header = [
    "Project Key",
    "Project Name",
    "Completed Tasks",
    "In Progress Tasks",
    "Total Tasks",
    "Total Spent (Minutes)",
    "Total Spent (Hours)",
    "Average per Completed Task (Minutes)",
    "Formatted Duration",
  ].join(",");

  const lines = summaries.map((summary) =>
    [
      summary.projectKey ?? "",
      summary.projectName,
      summary.completedTasks,
      summary.inProgressTasks,
      summary.totalTasks,
      roundToTwoDecimals(summary.totalSpentMs / MS_PER_MINUTE),
      roundToTwoDecimals(summary.totalSpentMs / MS_PER_HOUR),
      roundToTwoDecimals(summary.averageSpentMs / MS_PER_MINUTE),
      formatDuration(summary.totalSpentMs),
    ]
      .map(escapeCsvCell)
      .join(","),
  );
  return [header, ...lines].join("\n");
}

