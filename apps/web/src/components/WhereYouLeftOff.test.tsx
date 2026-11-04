import type { Project, Task } from "@bitig/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDayLabel, formatFullTimestamp, formatTimeAgo } from "../domain/time-ago";
import { WhereYouLeftOff } from "./WhereYouLeftOff";

const NOW = new Date(2026, 9, 22, 15, 0);

function localIso(day: number, hour: number, minute = 0): string {
  return new Date(2026, 9, day, hour, minute).toISOString();
}

const ALPHA: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  key: "ALP",
  description: "",
  kind: "paid",
  createdAt: localIso(1, 9),
  updatedAt: localIso(1, 9),
};

const BETA: Project = { ...ALPHA, id: "01940000-0000-7000-8000-000000000002", name: "Beta", key: "BET" };

function task(n: number, project: Project, updatedAt: string, overrides: Partial<Task> = {}): Task {
  return {
    id: `01940000-0000-7000-8000-0000000000${String(10 + n)}`,
    projectId: project.id,
    title: `Task ${String(n)}`,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: localIso(1, 9),
    updatedAt,
    number: n,
    ...overrides,
  };
}

describe("formatTimeAgo", () => {
  it("reads minutes, hours and calendar days, and falls back for invalid dates", () => {
    expect(formatTimeAgo(NOW.toISOString(), NOW)).toBe("just now");
    expect(formatTimeAgo(localIso(22, 14, 55), NOW)).toBe("5 minutes ago");
    expect(formatTimeAgo(localIso(22, 12), NOW)).toBe("3 hours ago");
    expect(formatTimeAgo(localIso(21, 9), NOW)).toBe("yesterday");
    expect(formatTimeAgo(localIso(18, 9), NOW)).toBe("4 days ago");
    expect(formatTimeAgo( new Date().toISOString())).toBe("just now");
    expect(formatTimeAgo("not-a-date", NOW)).toBe("not-a-date");
    expect(formatFullTimestamp("not-a-date")).toBe("not-a-date");
  });
});

describe("formatDayLabel", () => {
  it("names today and yesterday, and dates older days", () => {
    expect(formatDayLabel(localIso(22, 9), NOW)).toBe("Today");
    expect(formatDayLabel(localIso(21, 23), NOW)).toBe("Yesterday");
    expect(formatDayLabel(localIso(20, 9), NOW)).toBe("Tue 20 Oct");
  });
});

describe("WhereYouLeftOff", () => {
  it("renders nothing without projects", () => {
    const { container } = render(<WhereYouLeftOff projects={[]} tasks={[]} now={NOW} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the last project and recent activity by day", () => {
    window.history.replaceState(null, "", "/app");
    const tasks = [
      task(1, ALPHA, localIso(20, 10), { status: "done", startedAt: localIso(19, 10), completedAt: localIso(20, 10) }),
      task(2, BETA, localIso(21, 16), {
        status: "in_progress",
        startedAt: localIso(21, 9),
        checklist: [
          { text: "Write schema", done: true },
          { text: "Write migration", done: false },
        ],
        activity: [{ action: "updated", actor: "claude", timestamp: localIso(21, 16) }],
      }),
      task(3, BETA, localIso(22, 11), { status: "todo", createdAt: localIso(22, 11) }),
    ];
    render(<WhereYouLeftOff projects={[ALPHA, BETA]} tasks={tasks} now={NOW} />);

    const project = screen.getByTestId("left-off-project");
    expect(within(project).getByRole("link", { name: "Beta" })).toHaveAttribute(
      "href",
      `/tasks?project=${BETA.id}`,
    );
    expect(project).toHaveTextContent("Active 4 hours ago · 1 in progress · 2 open");

    const recent = screen.getByTestId("left-off-recent");
    const days = within(recent).getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(days).toEqual(["Today", "Yesterday", "Tue 20 Oct"]);
    const recentItems = within(recent).getAllByRole("listitem");
    expect(recentItems).toHaveLength(3);
    expect(recentItems[0]).toHaveTextContent("To Do");
    expect(recentItems[0]).toHaveTextContent("Created · 11:00 · Beta");
    expect(recentItems[1]).toHaveTextContent("In Progress");
    expect(recentItems[1]).toHaveTextContent("Updated by claude · 16:00 · Beta");
    expect(recentItems[2]).toHaveTextContent("Done");
    expect(recentItems[2]).toHaveTextContent("Completed · 10:00 · Alpha");
  });

  it("leaves in-progress tasks to the dashboard's working and stalled lists", () => {
    render(
      <WhereYouLeftOff
        projects={[ALPHA]}
        tasks={[task(1, ALPHA, localIso(22, 9), { status: "in_progress" })]}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("left-off-in-progress")).not.toBeInTheDocument();
    expect(screen.getByTestId("left-off-recent")).toHaveTextContent("Task 1");
  });
});
