import type { Project, Task } from "@bitig/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Overview } from "./Overview";

const PROJECT_ALPHA: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  key: "ALP",
  description: "",
  kind: "paid",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const PROJECT_BETA: Project = {
  id: "01940000-0000-7000-8000-000000000002",
  name: "Beta",
  key: "BET",
  description: "",
  kind: "hobby",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const TASKS: readonly Task[] = [
  {
    id: "01940000-0000-7000-8000-000000000011",
    projectId: PROJECT_ALPHA.id,
    title: "Build API",
    description: "",
    status: "done",
    isPublic: false,
    createdAt: "2026-03-02T08:00:00.000Z",
    startedAt: "2026-03-02T09:00:00.000Z",
    completedAt: "2026-03-02T11:30:00.000Z",
    updatedAt: "2026-03-02T11:30:00.000Z",
  },
  {
    id: "01940000-0000-7000-8000-000000000012",
    projectId: PROJECT_BETA.id,
    title: "Write docs",
    description: "",
    status: "done",
    isPublic: false,
    createdAt: "2026-03-09T09:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T11:00:00.000Z",
    updatedAt: "2026-03-09T11:00:00.000Z",
  },
];

describe("Overview time analytics and CSV export", () => {
  it("renders by-project and by-week time charts and filters by project", async () => {
    const user = userEvent.setup();
    render(
      <Overview
        mode="cloudflare"
        health={{ kind: "online", version: "0.4.1", storageMode: "cloudflare" }}
        projects={[PROJECT_ALPHA, PROJECT_BETA]}
        tasks={TASKS}
      />,
    );

    const chartsGrid = screen.getByTestId("time-charts-grid");
    expect(chartsGrid).toHaveClass("lg:grid-cols-2");

    const byProjectChart = screen.getByTestId("chart-by-project");
    expect(within(byProjectChart).getByText("Alpha")).toBeInTheDocument();
    expect(within(byProjectChart).getByText("2h 30m")).toBeInTheDocument();
    expect(within(byProjectChart).getByText("Beta")).toBeInTheDocument();
    expect(within(byProjectChart).getByText("1h")).toBeInTheDocument();

    const byWeekChart = screen.getByTestId("chart-by-week");
    expect(within(byWeekChart).getByText("2026-W10")).toBeInTheDocument();
    expect(within(byWeekChart).getByText("2026-W11")).toBeInTheDocument();

    // Filter to Alpha only
    await user.selectOptions(
      screen.getByLabelText("Filter analytics by project"),
      PROJECT_ALPHA.id,
    );
    expect(within(byProjectChart).getByText("Alpha")).toBeInTheDocument();
    expect(within(byProjectChart).queryByText("Beta")).not.toBeInTheDocument();
    expect(within(byWeekChart).getByText("2026-W10")).toBeInTheDocument();
    expect(within(byWeekChart).queryByText("2026-W11")).not.toBeInTheDocument();
  });

  it("exports CSV by project and by week", async () => {
    const user = userEvent.setup();
    const onExportCsv = vi.fn();
    render(
      <Overview
        mode="cloudflare"
        health={{ kind: "online", version: "0.4.1", storageMode: "cloudflare" }}
        projects={[PROJECT_ALPHA, PROJECT_BETA]}
        tasks={TASKS}
        onExportCsv={onExportCsv}
      />,
    );

    await user.click(screen.getByRole("button", { name: /export by project \(csv\)/i }));
    expect(onExportCsv).toHaveBeenCalledWith(
      "bitig-time-by-project.csv",
      expect.stringContaining(
        "Project Key,Project Name,Task Code,Task Title,Status,Priority,Created At,Started At,Completed At,Lead Time (Minutes),Spent (Minutes),Spent (Hours),Formatted Duration,Subtasks",
      ),
      "by_project",
    );
    expect(onExportCsv).toHaveBeenCalledWith(
      "bitig-time-by-project.csv",
      expect.stringContaining("Build API"),
      "by_project",
    );
    expect(onExportCsv).toHaveBeenCalledWith(
      "bitig-time-by-project.csv",
      expect.stringContaining("Write docs"),
      "by_project",
    );

    await user.click(screen.getByRole("button", { name: /export by week \(csv\)/i }));
    expect(onExportCsv).toHaveBeenCalledWith(
      "bitig-time-by-week.csv",
      expect.stringContaining("Week,Project Key,Project Name,Completed Tasks"),
      "by_week",
    );
  });
});

