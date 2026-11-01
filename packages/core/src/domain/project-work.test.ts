import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../testing/fixtures";
import { buildCheckpoint } from "./checkpoints";
import { buildProject, buildTask } from "./entities";
import { buildProjectWorkContext, PROJECT_WORK_LIMITS, selectProjectWork } from "./project-work";
import type { Comment, Task } from "./types";

function setup() {
  const runtime = createTestRuntime();
  const project = buildProject({ name: "Bitig", key: "BIT" }, runtime, []);
  const task = (overrides: Partial<Task> = {}): Task => ({
    ...buildTask({ projectId: project.id, title: "Work" }, runtime, 1), ...overrides,
  });
  return { runtime, project, task };
}

describe("selectProjectWork", () => {
  it("returns empty states for empty and archived projects", () => {
    const { project, task } = setup();
    for (const summary of [selectProjectWork(project, []), selectProjectWork({ ...project, archived: true }, [task()])]) {
      expect(summary.primary).toBeNull();
      expect(summary.inProgress).toEqual([]);
      expect(summary.next).toEqual([]);
      expect(Object.values(summary.counts)).toEqual([0, 0, 0, 0, 0]);
    }
  });

  it("resumes most recently touched ungated work and preserves canonical todo ordering", () => {
    const { project, task } = setup();
    const older = task({ status: "in_progress" });
    const newer = task({ status: "in_progress", checklist: [{ text: "Finished", done: true }, { text: "Next", done: false }] });
    const urgent = task({ priority: "urgent", order: 2 });
    const ordered = task({ priority: "low", order: 1 });
    const unordered = task();
    const tasks = [unordered, newer, urgent, older, ordered];
    const before = JSON.stringify(tasks);
    const result = selectProjectWork(project, tasks);
    expect(result.inProgress.map((entry) => entry.id)).toEqual([newer.id, older.id]);
    expect(result.primary).toMatchObject({ id: newer.id, code: "BIT-1", nextSubtask: "Next" });
    expect(result.next.map((entry) => entry.id)).toEqual([ordered.id, urgent.id, unordered.id]);
    expect(JSON.stringify(tasks)).toBe(before);
  });

  it("counts overlapping gates, handles cross-project dependencies, and excludes closed work", () => {
    const { project, task } = setup();
    const dependency = task({ projectId: "other", status: "todo" });
    const gated = task({ status: "in_progress", pendingApproval: true, needsHuman: "Decision", dependsOn: [dependency.id] });
    const waiting = task({ needsHuman: "Access" });
    const finished = task({ status: "archived" });
    const ready = task({ dependsOn: [finished.id, "deleted"] });
    const result = selectProjectWork(project, [dependency, gated, waiting, finished, ready, task({ status: "done" })]);
    expect(result.counts).toEqual({ inProgress: 1, actionableTodo: 1, pendingApproval: 1, blocked: 1, needsHuman: 2 });
    expect(result.inProgress[0]?.gates).toEqual({ pendingApproval: true, blocked: true, needsHuman: true });
    expect(result.primary?.id).toBe(ready.id);
    expect(selectProjectWork(project, [dependency, gated, waiting]).primary).toBeNull();
    expect(selectProjectWork(project, [ready, { ...finished, status: "done" }]).primary?.id).toBe(ready.id);
  });

  it("uses stable canonical tie breaks and bounds all task lists", () => {
    const { project, task } = setup();
    const total = PROJECT_WORK_LIMITS.tasks + 2;
    const tasks = Array.from({ length: total }, () => task({ status: "in_progress", updatedAt: project.updatedAt }));
    const todos = Array.from({ length: total }, () => task());
    const result = selectProjectWork(project, [...tasks, ...todos].reverse());
    expect(result.inProgress.map((entry) => entry.id)).toEqual(tasks.slice(0, PROJECT_WORK_LIMITS.tasks).map((entry) => entry.id));
    expect(result.next).toHaveLength(PROJECT_WORK_LIMITS.tasks);
    expect(result.omittedInProgressCount).toBe(2);
    expect(result.omittedNextCount).toBe(2);
  });

  it("finds ungated in-progress work beyond the visible list and bounds its next subtask", () => {
    const { project, task } = setup();
    const longText = "x".repeat(PROJECT_WORK_LIMITS.text + 1);
    const ready = task({
      status: "in_progress", title: "x".repeat(PROJECT_WORK_LIMITS.title + 1),
      checklist: [
        ...Array.from({ length: PROJECT_WORK_LIMITS.checklist }, () => ({ text: "Done", done: true })),
        { text: longText, done: false },
      ],
    });
    const gated = Array.from({ length: PROJECT_WORK_LIMITS.tasks }, () => task({ status: "in_progress", needsHuman: "Waiting" }));
    const summary = selectProjectWork(project, [ready, ...gated, task()]);
    expect(summary.inProgress.every((entry) => entry.gates.needsHuman)).toBe(true);
    expect(summary.primary?.id).toBe(ready.id);
    expect(summary.primary?.title).toHaveLength(PROJECT_WORK_LIMITS.title);
    expect(summary.primary?.nextSubtask).toHaveLength(PROJECT_WORK_LIMITS.text);
    expect(summary.primary?.nextSubtask?.endsWith("…")).toBe(true);
  });
});

describe("buildProjectWorkContext", () => {
  it("has explicit missing-context states", () => {
    const { task } = setup();
    expect(buildProjectWorkContext(task(), [], [])).toEqual({
      description: "", descriptionTruncated: false, checklist: [], omittedChecklistCount: 0,
      comments: [], omittedCommentCount: 0, checkpoint: null,
    });
  });

  it("breaks equal comment timestamps in reverse canonical order", () => {
    const { runtime, task } = setup();
    const target = task();
    const comments: Comment[] = Array.from({ length: 3 }, () => ({
      id: runtime.generateId(), taskId: target.id, body: "Context", authorType: "agent", createdAt: target.createdAt,
    }));
    const context = buildProjectWorkContext(target, [], comments);
    expect(context.comments.map((entry) => entry.id)).toEqual(comments.slice(-2).reverse().map((entry) => entry.id));
  });

  it("bounds context, keeps the highest checkpoint step and most recent own comments", () => {
    const { runtime, task } = setup();
    const long = "x".repeat(4000);
    const target = task({ description: long, checklist: Array.from({ length: 20 }, () => ({ text: long, done: true })) });
    const snapshot = {
      summary: "Progress", modifiedArtifacts: Array.from({ length: 10 }, () => "file".repeat(200)),
      decisionsMade: Array.from({ length: 10 }, () => "decision".repeat(50)),
      blockersOrErrors: { detail: "x".repeat(500) }, nextStepInstructions: long,
      metadata: { privateDetail: "not included" },
    };
    const latest = buildCheckpoint({ taskId: target.id, stepIndex: 2, status: "IN_PROGRESS", stateSnapshot: snapshot }, runtime);
    const lower = buildCheckpoint({ taskId: target.id, stepIndex: 1, status: "FAILED", stateSnapshot: snapshot }, runtime);
    const foreign = buildCheckpoint({ taskId: task().id, stepIndex: 3, status: "COMPLETED", stateSnapshot: snapshot }, runtime);
    const comments: Comment[] = Array.from({ length: 5 }, () => ({
      id: runtime.generateId(), taskId: target.id, body: long, authorType: "human", createdAt: runtime.clock().toISOString(),
    }));
    const result = buildProjectWorkContext(target, [latest, lower, foreign], [
      ...comments, {
        id: runtime.generateId(), taskId: foreign.taskId, body: "Foreign", authorType: "human",
        createdAt: runtime.clock().toISOString(),
      },
    ]);
    expect(result.description).toHaveLength(PROJECT_WORK_LIMITS.description);
    expect(result.descriptionTruncated).toBe(true);
    expect(result.checklist).toHaveLength(PROJECT_WORK_LIMITS.checklist);
    expect(result.omittedChecklistCount).toBe(12);
    expect(result.comments.map((entry) => entry.id)).toEqual(comments.slice(-2).reverse().map((entry) => entry.id));
    expect(result.comments[0]?.body).toHaveLength(PROJECT_WORK_LIMITS.comment);
    expect(result.omittedCommentCount).toBe(3);
    expect(result.checkpoint).toMatchObject({ stepIndex: 2, status: "IN_PROGRESS", omittedArtifactCount: 6, omittedDecisionCount: 6 });
    expect(result.checkpoint?.nextStepInstructions).toHaveLength(PROJECT_WORK_LIMITS.instructions);
    expect(result.checkpoint?.modifiedArtifacts[0]).toHaveLength(PROJECT_WORK_LIMITS.text);
    expect(result.checkpoint).not.toHaveProperty("metadata");
    expect(JSON.stringify(result).length).toBeLessThan(10_000);
    expect(buildProjectWorkContext(target, [{ ...latest, stateSnapshot: { ...snapshot, blockersOrErrors: long } }], []).checkpoint?.blockersOrErrors)
      .toHaveLength(PROJECT_WORK_LIMITS.comment);
  });
});
