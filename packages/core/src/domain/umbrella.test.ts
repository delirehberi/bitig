import { describe, expect, it } from "vitest";
import {
  buildLegacyHierarchyInventory,
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

const OTHER_PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000002",
  name: "Other",
  key: "OTH",
  description: "",
  kind: "hobby",
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

describe("umbrella domain helpers (#BIT-191, #BIT-195)", () => {
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
    it("defaults to explicit mode: uses strictly same-project task.parentId and ignores mentions, dependsOn, or run ancestry", () => {
      const parent = makeTask(100, {
        title: "Umbrella: Explicit Parent",
        description: "Mentions #BIT-102",
        checklist: [{ text: "#BIT-103 checklist mention", done: false }],
        status: "in_progress",
      });
      const explicitChild = makeTask(101, {
        title: "Explicit child",
        parentId: parent.id,
        status: "in_progress",
      });
      const mentionedOnly = makeTask(102, {
        title: "Mentioned only",
        dependsOn: [parent.id],
      });
      const checklistMentionedOnly = makeTask(103, {
        title: "Checklist mentioned only",
      });
      const crossProjectTask = makeTask(104, {
        title: "Foreign task",
        projectId: OTHER_PROJECT.id,
        parentId: parent.id,
      });

      const runs: AgentRun[] = [
        {
          id: "01940000-0000-7000-8000-000000009100",
          taskId: parent.id,
          t3ProjectId: "t3-proj",
          threadId: "thread-100",
          state: "waiting_subagent",
          waitingForTaskId: mentionedOnly.id,
          startedAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
        {
          id: "01940000-0000-7000-8000-000000009101",
          taskId: explicitChild.id,
          parentTaskId: parent.id,
          t3ProjectId: "t3-proj",
          threadId: "thread-101",
          state: "working",
          startedAt: TIMESTAMP,
          updatedAt: TIMESTAMP,
        },
      ];
      const runChildren: AgentRunChild[] = [
        {
          parentTaskId: parent.id,
          childTaskId: checklistMentionedOnly.id,
          state: "done",
          startedAt: TIMESTAMP,
          finishedAt: TIMESTAMP,
        },
      ];

      const index = buildUmbrellaIndex({
        tasks: [parent, explicitChild, mentionedOnly, checklistMentionedOnly, crossProjectTask],
        projects: [PROJECT, OTHER_PROJECT],
        runs,
        runChildren,
      });

      expect(index.isUmbrella(parent.id)).toBe(true);
      expect(index.childrenFor(parent.id).map((t) => t.id)).toEqual([explicitChild.id]);
      expect(index.progressFor(parent.id)).toEqual({
        total: 1,
        running: 1,
        merged: 0,
        done: 0,
      });
      expect(index.isUmbrella(explicitChild.id)).toBe(false);
    });

    it("resolves legacy inferred umbrella children and progress when mode is 'legacy'", () => {
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
        mode: "legacy",
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

  describe("buildLegacyHierarchyInventory", () => {
    it("surfaces inferred edges with provenance and conflict flags without mutating tasks", () => {
      const parentA = makeTask(1, {
        title: "Umbrella A",
        checklist: [{ text: "#BIT-3", done: false }],
        description: "Also touches #BIT-4 and #OTH-1",
      });
      const parentB = makeTask(2, {
        title: "Umbrella B",
        checklist: [{ text: "#BIT-3", done: false }],
      });
      const multiChild = makeTask(3, {
        title: "Ambiguous child",
        dependsOn: [parentA.id],
      });
      const alreadyChild = makeTask(4, {
        title: "Already parented child",
        parentId: parentA.id,
      });
      const foreignChild = makeTask(1, {
        id: "01940000-0000-7000-8000-000000000201",
        projectId: OTHER_PROJECT.id,
        title: "Other project task",
      });

      const inventory = buildLegacyHierarchyInventory({
        tasks: [parentA, parentB, multiChild, alreadyChild, foreignChild],
        projects: [PROJECT, OTHER_PROJECT],
        runs: [
          {
            id: "01940000-0000-7000-8000-000000009003",
            taskId: multiChild.id,
            parentTaskId: parentA.id,
            t3ProjectId: "t3",
            threadId: "t-3",
            state: "working",
            startedAt: TIMESTAMP,
            updatedAt: TIMESTAMP,
          },
        ],
        hierarchyMode: "explicit",
      });

      expect(inventory.hierarchyMode).toBe("explicit");
      expect(inventory.alreadyParentedCount).toBe(1);

      const multiA = inventory.candidates.find(
        (c) => c.childTaskId === multiChild.id && c.proposedParentId === parentA.id,
      );
      expect(multiA).toMatchObject({
        childCode: "BIT-3",
        proposedParentCode: "BIT-1",
        alternateParentIds: [parentB.id],
        importable: true,
      });
      expect(multiA?.provenance).toContain("run_parent_task");
      expect(multiA?.provenance).toContain("checklist_mention");
      expect(multiA?.provenance).toContain("reverse_dependency");
      expect(multiA?.conflicts).toContain("multiple_parents");
      expect(multiA?.conflicts).toContain("parent_dependency");

      const already = inventory.candidates.find((c) => c.childTaskId === alreadyChild.id);
      expect(already).toMatchObject({
        conflicts: ["already_parented"],
        importable: false,
      });

      const crossProject = inventory.candidates.find((c) => c.childTaskId === foreignChild.id);
      expect(crossProject).toMatchObject({
        conflicts: ["cross_project"],
        importable: false,
      });
    });
  });
});
