import {
  InMemoryStorage,
  dependencyLinks,
  hierarchyLinks,
  type Project,
  type Task,
  type TaskLinks,
} from "@bitig/core";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FeatureFlagsProvider } from "../../domain/feature-context";
import { TaskMentionsProvider } from "../../domain/task-mentions-context";
import * as t3Service from "../../services/t3";
import { TaskDetailModal } from "./TaskDetailModal";
import { TaskDetailPage } from "./TaskDetailPage";

const NOW = "2026-11-15T12:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig",
  key: "BIT",
  description: "",
  kind: "paid",
  createdAt: NOW,
  updatedAt: NOW,
};

function makeTask(number: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `01940000-0000-7000-8000-${String(number).padStart(12, "0")}`,
    projectId: PROJECT.id,
    title: `Task ${String(number)}`,
    description: "",
    status: "todo",
    number,
    isPublic: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("Task hierarchy UI separation from mentions and dependencies (#BIT-195)", () => {
  it("renders distinct Hierarchy (Parent / Children), Dependencies, and Linked tasks sections in TaskDetailModal and TaskDetailPage", () => {
    const parent = makeTask(1, { title: "Parent epic" });
    const blocker = makeTask(2, { title: "Prerequisite blocker" });
    const mentioned = makeTask(3, { title: "Related mention" });
    const child = makeTask(4, { title: "Explicit child" });
    const focus = makeTask(5, {
      title: "Focus task",
      parentId: parent.id,
      dependsOn: [blocker.id],
      description: "See #BIT-3 for context",
    });
    const childUnderFocus = { ...child, parentId: focus.id };
    const allTasks = [parent, blocker, mentioned, childUnderFocus, focus];

    const links: TaskLinks = {
      mentions: [{ id: mentioned.id, code: "BIT-3", title: mentioned.title, status: mentioned.status }],
      mentionedIn: [],
    };
    const hierarchy = hierarchyLinks(focus, allTasks, [PROJECT]);
    const dependencies = dependencyLinks(focus, allTasks, [PROJECT]);

    const { unmount } = render(
      <TaskMentionsProvider projects={[PROJECT]} tasks={allTasks}>
        <TaskDetailModal
          task={focus}
          projects={[PROJECT]}
          hierarchy={hierarchy}
          hierarchyMode="explicit"
          dependencies={dependencies}
          links={links}
          onClose={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
        />
      </TaskMentionsProvider>,
    );

    const hierarchyHeading = screen.getByRole("heading", { name: "Hierarchy" });
    const hierarchySection = hierarchyHeading.closest("section");
    expect(hierarchySection).not.toBeNull();
    if (!hierarchySection) throw new Error("Expected hierarchy section");
    expect(within(hierarchySection).getByText("Parent epic")).toBeInTheDocument();
    expect(within(hierarchySection).getByText("Explicit child")).toBeInTheDocument();
    expect(within(hierarchySection).queryByText("Prerequisite blocker")).not.toBeInTheDocument();
    expect(within(hierarchySection).queryByText("Related mention")).not.toBeInTheDocument();

    const depsSection = screen.getByRole("heading", { name: "Dependencies" }).closest("section");
    expect(depsSection).not.toBeNull();
    if (!depsSection) throw new Error("Expected dependencies section");
    expect(within(depsSection).getByText("Prerequisite blocker")).toBeInTheDocument();
    expect(within(depsSection).queryByText("Parent epic")).not.toBeInTheDocument();

    const linksSection = screen.getByRole("heading", { name: "Linked tasks" }).closest("section");
    expect(linksSection).not.toBeNull();
    if (!linksSection) throw new Error("Expected links section");
    expect(within(linksSection).getByText("Related mention")).toBeInTheDocument();
    expect(within(linksSection).queryByText("Parent epic")).not.toBeInTheDocument();

    unmount();

    render(
      <TaskMentionsProvider projects={[PROJECT]} tasks={allTasks}>
        <TaskDetailPage
          task={focus}
          projects={[PROJECT]}
          hierarchy={hierarchy}
          hierarchyMode="explicit"
          dependencies={dependencies}
          links={links}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onComplete={vi.fn()}
          onStatusChange={vi.fn()}
        />
      </TaskMentionsProvider>,
    );

    const rail = screen.getByLabelText("Task details");
    expect(within(rail).getByText("Parent")).toBeInTheDocument();
    expect(within(rail).getByText("Parent epic")).toBeInTheDocument();
    expect(within(rail).getByText("Children (1)")).toBeInTheDocument();
    expect(within(rail).getByText("Explicit child")).toBeInTheDocument();
    expect(within(rail).getByText("Depends on")).toBeInTheDocument();
    expect(within(rail).getByText("Prerequisite blocker")).toBeInTheDocument();
  });

  it("does not trigger UmbrellaChildrenPanel from mentions or reverse dependencies in explicit mode", () => {
    const storage = new InMemoryStorage();
    vi.spyOn(t3Service, "fetchT3Connection").mockResolvedValue({ connected: false });
    vi.spyOn(t3Service, "fetchT3ProjectMappings").mockResolvedValue([]);
    vi.spyOn(t3Service, "fetchTaskT3Run").mockResolvedValue({ run: null, pendingQuestions: [] });
    vi.spyOn(t3Service, "fetchT3Runs").mockResolvedValue({ runs: [] });
    vi.spyOn(t3Service, "fetchT3Capabilities").mockResolvedValue([]);
    const fetchChildrenSpy = vi.spyOn(t3Service, "fetchUmbrellaChildren");

    const umbrellaLookalike = makeTask(10, {
      title: "Umbrella: Mentions only",
      checklist: [{ text: "Check #BIT-11", done: false }],
    });
    const dependentTask = makeTask(11, {
      title: "Reverse dependent only",
      dependsOn: [umbrellaLookalike.id],
    });
    const allTasks = [umbrellaLookalike, dependentTask];

    render(
      <FeatureFlagsProvider mode="cloudflare">
        <TaskMentionsProvider projects={[PROJECT]} tasks={allTasks}>
          <TaskDetailModal
            task={umbrellaLookalike}
            projects={[PROJECT]}
            storage={storage}
            hierarchy={hierarchyLinks(umbrellaLookalike, allTasks, [PROJECT])}
            hierarchyMode="explicit"
            dependencies={dependencyLinks(umbrellaLookalike, allTasks, [PROJECT])}
            links={{
              mentions: [{ id: dependentTask.id, code: "BIT-11", title: dependentTask.title, status: "todo" }],
              mentionedIn: [],
            }}
            isUmbrella={false}
            onClose={vi.fn()}
            onEdit={vi.fn()}
            onDelete={vi.fn()}
            onComplete={vi.fn()}
          />
        </TaskMentionsProvider>
      </FeatureFlagsProvider>,
    );

    expect(screen.queryByTestId("umbrella-children-panel")).not.toBeInTheDocument();
    expect(fetchChildrenSpy).not.toHaveBeenCalled();
  });
});
