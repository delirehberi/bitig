import { describe, expect, it } from "vitest";
import {
  aggregateTimeByProject,
  aggregateTimeByProjectAndWeek,
  exportTimeSpentCsv,
  formatDuration,
  getSubtaskTimings,
  getTaskTiming,
  isoWeekKey,
} from "./time-tracking";
import type { Project, Task } from "./types";

const PROJECT_A: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig Core",
  key: "BIT",
  description: "",
  kind: "open_source",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};

const PROJECT_B: Project = {
  id: "01940000-0000-7000-8000-000000000002",
  name: "=Evil, Project",
  key: "EVL",
  description: "",
  kind: "paid",
  createdAt: "2026-10-20T09:00:00.000Z",
  updatedAt: "2026-10-20T09:00:00.000Z",
};

describe("time-tracking domain helpers", () => {
  it("calculates lead time, active spent time, and total turnaround for a completed task", () => {
    // Created at 09:00, started 3 hours later at 12:00, completed 20 minutes later at 12:20
    const task: Task = {
      id: "01940000-0000-7000-8000-000000000010",
      projectId: PROJECT_A.id,
      title: "Implement time tracking",
      description: "",
      status: "done",
      isPublic: false,
      createdAt: "2026-10-20T09:00:00.000Z",
      startedAt: "2026-10-20T12:00:00.000Z",
      completedAt: "2026-10-20T12:20:00.000Z",
      updatedAt: "2026-10-20T12:20:00.000Z",
    };

    const timing = getTaskTiming(task);
    expect(timing.leadTimeMs).toBe(3 * 60 * 60 * 1000);
    expect(timing.spentMs).toBe(20 * 60 * 1000);
    expect(timing.totalTurnaroundMs).toBe((3 * 60 + 20) * 60 * 1000);
    expect(formatDuration(timing.leadTimeMs ?? 0)).toBe("3h");
    expect(formatDuration(timing.spentMs ?? 0)).toBe("20m");
  });

  it("calculates live elapsed time for an in-progress task when nowMs is provided", () => {
    const task: Task = {
      id: "01940000-0000-7000-8000-000000000011",
      projectId: PROJECT_A.id,
      title: "Active task",
      description: "",
      status: "in_progress",
      isPublic: false,
      createdAt: "2026-10-20T09:00:00.000Z",
      startedAt: "2026-10-20T10:00:00.000Z",
      updatedAt: "2026-10-20T10:00:00.000Z",
    };

    const nowMs = Date.parse("2026-10-20T11:15:00.000Z");
    const timing = getTaskTiming(task, nowMs);
    expect(timing.leadTimeMs).toBe(60 * 60 * 1000);
    expect(timing.spentMs).toBe(75 * 60 * 1000);
    expect(formatDuration(timing.spentMs ?? 0)).toBe("1h 15m");
  });

  it("calculates sequential and explicit subtask timings", () => {
    const task: Task = {
      id: "01940000-0000-7000-8000-000000000012",
      projectId: PROJECT_A.id,
      title: "Task with subtasks",
      description: "",
      status: "done",
      isPublic: false,
      createdAt: "2026-10-20T09:00:00.000Z",
      startedAt: "2026-10-20T12:00:00.000Z",
      completedAt: "2026-10-20T12:20:00.000Z",
      updatedAt: "2026-10-20T12:20:00.000Z",
      checklist: [
        { text: "Schema", done: true, completedAt: "2026-10-20T12:08:00.000Z" },
        { text: "UI", done: true, completedAt: "2026-10-20T12:20:00.000Z" },
      ],
    };

    const timings = getSubtaskTimings(task);
    expect(timings).toHaveLength(2);
    expect(timings[0]?.spentMs).toBe(8 * 60 * 1000);
    expect(timings[1]?.spentMs).toBe(12 * 60 * 1000);
  });

  it("formats durations across seconds, minutes, hours, and days", () => {
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(30_000)).toBe("< 1m");
    expect(formatDuration(20 * 60 * 1000)).toBe("20m");
    expect(formatDuration(3 * 60 * 60 * 1000)).toBe("3h");
    expect(formatDuration((3 * 60 + 20) * 60 * 1000)).toBe("3h 20m");
    expect(formatDuration(26 * 60 * 60 * 1000)).toBe("1d 2h");
  });

  it("computes ISO week keys and aggregates by project and week, exporting safe CSV", () => {
    expect(isoWeekKey("2026-10-20T12:20:00.000Z")).toBe("2026-W43");

    const tasks: Task[] = [
      {
        id: "01940000-0000-7000-8000-000000000020",
        projectId: PROJECT_A.id,
        title: "T1",
        description: "",
        status: "done",
        isPublic: false,
        createdAt: "2026-10-20T09:00:00.000Z",
        startedAt: "2026-10-20T12:00:00.000Z",
        completedAt: "2026-10-20T12:20:00.000Z",
        updatedAt: "2026-10-20T12:20:00.000Z",
      },
      {
        id: "01940000-0000-7000-8000-000000000021",
        projectId: PROJECT_B.id,
        title: "T2",
        description: "",
        status: "done",
        isPublic: false,
        createdAt: "2026-10-13T09:00:00.000Z",
        startedAt: "2026-10-13T10:00:00.000Z",
        completedAt: "2026-10-13T11:30:00.000Z",
        updatedAt: "2026-10-13T11:30:00.000Z",
      },
    ];

    const byProject = aggregateTimeByProject([PROJECT_A, PROJECT_B], tasks);
    expect(byProject[0]?.projectId).toBe(PROJECT_B.id);
    expect(byProject[0]?.totalSpentMs).toBe(90 * 60 * 1000);
    expect(byProject[1]?.projectId).toBe(PROJECT_A.id);
    expect(byProject[1]?.totalSpentMs).toBe(20 * 60 * 1000);

    const byWeek = aggregateTimeByProjectAndWeek([PROJECT_A, PROJECT_B], tasks);
    expect(byWeek).toEqual([
      {
        week: "2026-W43",
        projectId: PROJECT_A.id,
        projectName: "Bitig Core",
        projectKey: "BIT",
        completedTasks: 1,
        totalSpentMs: 20 * 60 * 1000,
      },
      {
        week: "2026-W42",
        projectId: PROJECT_B.id,
        projectName: "=Evil, Project",
        projectKey: "EVL",
        completedTasks: 1,
        totalSpentMs: 90 * 60 * 1000,
      },
    ]);

    const weeklyCsv = exportTimeSpentCsv([PROJECT_A, PROJECT_B], tasks, "by_week");
    expect(weeklyCsv).toContain("Week,Project Key,Project Name,Completed Tasks");
    expect(weeklyCsv).toContain("2026-W43,BIT,Bitig Core,1,20,0.33,20m");
    // Formula prefix `=` is neutralized with a leading apostrophe and comma is quoted
    expect(weeklyCsv).toContain('2026-W42,EVL,"\'=Evil, Project",1,90,1.5,1h 30m');

    const projectCsv = exportTimeSpentCsv([PROJECT_A, PROJECT_B], tasks, "by_project");
    expect(projectCsv).toContain("Project Key,Project Name,Completed Tasks");
    expect(projectCsv).toContain("BIT,Bitig Core,1,0,1,20,0.33,20,20m");
  });
});

