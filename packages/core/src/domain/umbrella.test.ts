import { describe, expect, it } from "vitest";
import {
  buildUmbrellaIndex,
  formatUmbrellaProgress,
  hasExplicitUmbrellaMarker,
} from "./umbrella";
import type { AgentRunChild } from "./run-profile";
import type { AgentRun } from "./t3";
import type { Project, Task } from "./types";

const TIMESTAMP = "2026-11-12T10:00:00.000Z";

const PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Bitig",
  key: "BIT",
  description: "",
  kind: "paid",
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
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
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...overrides,
  };
}

describe("umbrella domain helpers (#BIT-191)", () => {
  describe("hasExplicitUmbrellaMarker", () => {
    it("matches explicit umbrella labels and title markers without false positives on leaf titles", () => {
      expect(hasExplicitUmbrellaMarker({ title: "Umbrella: Run orchestration", labels: [] })).toBe(true);
      expect(hasExplicitUmbrellaMarker({ title: "Run orchestration (umbrella)", labels: [] })).toBe(true);
      expect(hasExplicitUmbrellaMarker({ title: "Parallel Run Umbrella", labels: [] })).toBe(true);
      expect(hasExplicitUmbrellaMarker({ title: "Phase 2 rollout", labels: ["Umbrella"] })).toBe(true);

      expect(
        hasExplicitUmbrellaMarker({
          title: "Run orchestration: umbrella children panel in the web app",
          labels: ["run-orchestration"],
        }),
      ).toBe(false);
    });
  });

  describe("formatUmbrellaProgress", () => {
    it("formats running, merged, and done counts cleanly", () => {
      expect(formatUmbrellaProgress({ total: 5, running: 2, merged: 1, done: 1 })).toBe(
        "2 of 5 running, 1 merged",
      );
      expect(formatUmbrellaProgress({ total: 5, running: 2, merged: 0, done: 0 })).toBe(
        "2 of 5 running",
      );
      expect(formatUmbrellaProgress({ total: 5, running: 0, merged: 3, done: 4 })).toBe(
        "0 of 5 running, 3 merged",
      );
      expect(formatUmbrellaProgress({ total: 5, running: 0, merged: 0, done: 2 })).toBe(
        "0 of 5 running, 2 done",
      );
      expect(formatUmbrellaProgress({ total: 5, running: 0, merged: 0, done: 0 })).toBe(
        "0 of 5 running",
      );
    });
  });

  describe("buildUmbrellaIndex", () => {
    it("resolves umbrella children and progress without false positives on child back-references or sibling dependencies", () => {
      const umbrella = makeTask(183, {
        title: "Umbrella: Model routing and parallel children",
        status: "in_progress",
        checklist: [
          { text: "#BIT-189 Parallel child batches", done: true },
          { text: "#BIT-190 Child worktrees and merges", done: true },
          { text: "#BIT-191 Umbrella children panel in the web app", done: false },
          { text: "#BIT-192 End-to-end verification", done: false },
          { text: "#BIT-193 Follow-up polish", done: false },
        ],
      });

      const child189 = makeTask(189, {
        title: "Parallel child batches",
        description: "Plan attached to #BIT-183.",
        status: "done",
      });
      const child190 = makeTask(190, {
        title: "Child worktrees and merges",
        description: "Plan attached to #BIT-183.",
        status: "in_progress",
        dependsOn: [child189.id],
      });
      const child191 = makeTask(191, {
        title: "Run orchestration: umbrella children panel in the web app",
        description: "Plan attached to #BIT-183.",
        status: "in_progress",
        dependsOn: [child189.id, child190.id],
      });
      const child192 = makeTask(192, {
        title: "End-to-end verification",
        description: "Depends on #BIT-191 under #BIT-183.",
        status: "todo",
        dependsOn: [child191.id],
      });
      const child193 = makeTask(193, {
        title: "Follow-up polish",
        description: "Under #BIT-183.",
        status: "todo",
      });

      const runs: AgentRun[] = [
        {
          id: "01940000-0000-7000-8000-000000009183",
          taskId: umbrella.id,
          t3ProjectId: "t3-proj",
          threadId: "thread-183",
          state: "waiting_subagent",
          startedAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
        {
          id: "01940000-0000-7000-8000-000000009190",
          taskId: child190.id,
          parentTaskId: umbrella.id,
          t3ProjectId: "t3-proj",
          threadId: "thread-190",
          state: "working",
          startedAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
        {
          id: "01940000-0000-7000-8000-000000009191",
          taskId: child191.id,
          parentTaskId: umbrella.id,
          t3ProjectId: "t3-proj",
          threadId: "thread-191",
          state: "working",
          startedAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ];

      const runChildren: AgentRunChild[] = [
        {
          parentTaskId: umbrella.id,
          childTaskId: child189.id,
          state: "done",
          branch: "bitig/BIT-189",
          headSha: "1111111111111111111111111111111111111111",
          mergedAt: TIMESTAMP,
          mergedSha: "2222222222222222222222222222222222222222",
          startedAt: TIMESTAMP,
          finishedAt: TIMESTAMP,
        },
        {
          parentTaskId: umbrella.id,
          childTaskId: child190.id,
          state: "running",
          startedAt: TIMESTAMP,
        },
        {
          parentTaskId: umbrella.id,
          childTaskId: child191.id,
          state: "running",
          startedAt: TIMESTAMP,
        },
      ];

      const index = buildUmbrellaIndex({
        tasks: [umbrella, child189, child190, child191, child192, child193],
        projects: [PROJECT],
        runs,
        runChildren,
      });

      expect(index.isUmbrella(umbrella.id)).toBe(true);
      expect(index.childrenFor(umbrella.id).map((t) => t.id)).toEqual([
        child189.id,
        child190.id,
        child191.id,
        child192.id,
        child193.id,
      ]);
      expect(index.progressFor(umbrella.id)).toEqual({
        total: 5,
        running: 2,
        merged: 1,
        done: 1,
      });

      // None of the child tasks should be treated as umbrellas even though they mention #BIT-183
      // and have sibling tasks depending on them!
      for (const leaf of [child189, child190, child191, child192, child193]) {
        expect(index.isUmbrella(leaf.id)).toBe(false);
        expect(index.progressFor(leaf.id)).toBeUndefined();
      }
    });
  });
});
