import type { Project, Task } from "@bitig/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatDayLabel, formatTimeAgo } from "../domain/time-ago";
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
  it("reads minutes, hours and calendar days", () => {
    expect(formatTimeAgo(NOW.toISOString(), NOW)).toBe("just now");
    expect(formatTimeAgo(localIso(22, 14, 55), NOW)).toBe("5 minutes ago");
    expect(formatTimeAgo(localIso(22, 12), NOW)).toBe("3 hours ago");
    expect(formatTimeAgo(localIso(21, 9), NOW)).toBe("yesterday");
    expect(formatTimeAgo(localIso(18, 9), NOW)).toBe("4 days ago");
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

  it("shows the last project, in-progress tasks with their next subtask, and recent activity by day", () => {
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

    const inProgress = screen.getByTestId("left-off-in-progress");
    expect(within(inProgress).getByRole("link", { name: /BET-2\s*Task 2/ })).toHaveAttribute(
      "href",
      `/tasks?project=${BETA.id}&task=BET-2`,
    );
    expect(inProgress).toHaveTextContent("Next: Write migration");
    expect(within(inProgress).getByTitle("1 of 2 subtasks done")).toBeInTheDocument();

    const recent = screen.getByTestId("left-off-recent");
    const days = within(recent).getAllByRole("heading", { level: 4 }).map((h) => h.textContent);
    expect(days).toEqual(["Today", "Yesterday", "Tue 20 Oct"]);
    expect(recent).toHaveTextContent("Created · 11:00 · Beta");
    expect(recent).toHaveTextContent("Updated by claude · 16:00 · Beta");
    expect(recent).toHaveTextContent("Completed · 10:00 · Alpha");
  });

  it("invites starting something when nothing is in progress, and counts what does not fit", () => {
    const { rerender } = render(
      <WhereYouLeftOff projects={[ALPHA]} tasks={[task(1, ALPHA, localIso(22, 9))]} now={NOW} />,
    );
    expect(screen.getByTestId("left-off-in-progress")).toHaveTextContent("Nothing in progress");

    const busy = Array.from({ length: 7 }, (_, i) => task(i + 1, ALPHA, localIso(22, 8 + i), { status: "in_progress" }));
    rerender(<WhereYouLeftOff projects={[ALPHA]} tasks={busy} now={NOW} />);
    expect(screen.getByTestId("left-off-in-progress")).toHaveTextContent("and 2 more in progress");
  });
});
