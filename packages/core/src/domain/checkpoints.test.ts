import { describe, expect, it } from "vitest";
import { buildCheckpoint, buildExecutionContext } from "./checkpoints";
import { buildProject, buildTask } from "./entities";
import { SaveCheckpointInputSchema } from "./schemas";
import { createTestRuntime } from "../testing/fixtures";

function setup() {
  const runtime = createTestRuntime();
  const project = buildProject({ name: "Bitig" }, runtime, []);
  const task = buildTask({ projectId: project.id, title: "Durable execution" }, runtime, 1);
  const input = {
    taskId: task.id, stepIndex: 0, status: "COMPLETED" as const,
    stateSnapshot: { summary: "Saved progress", modifiedArtifacts: [], decisionsMade: [], nextStepInstructions: "Run validation" },
  };
  return { runtime, task, input };
}

describe("checkpoint validation", () => {
  it("rejects unknown fields and invalid steps and statuses", () => {
    const { input } = setup();
    for (const value of [
      { ...input, extra: true }, { ...input, stepIndex: -1 },
      { ...input, stepIndex: 0.5 }, { ...input, stepIndex: Number.MAX_SAFE_INTEGER + 1 },
      { ...input, status: "done" },
      { ...input, stateSnapshot: { ...input.stateSnapshot, extra: true } },
    ]) expect(SaveCheckpointInputSchema.safeParse(value).success).toBe(false);
  });

  it("bounds snapshot text, lists, and telemetry", () => {
    const { input } = setup();
    for (const patch of [
      { summary: "x".repeat(501) }, { summary: " " },
      { nextStepInstructions: "x".repeat(4001) },
      { modifiedArtifacts: Array.from({ length: 21 }, () => "file") },
      { decisionsMade: ["x".repeat(501)] },
      { metadata: { nested: { unsafe: true } } },
      { metadata: { tokens: Number.POSITIVE_INFINITY } },
      { blockersOrErrors: "x".repeat(4001) },
    ]) expect(SaveCheckpointInputSchema.safeParse({ ...input, stateSnapshot: { ...input.stateSnapshot, ...patch } }).success).toBe(false);
    expect(SaveCheckpointInputSchema.parse({ ...input, stateSnapshot: { ...input.stateSnapshot, metadata: { tokens: 10, role: "builder" } } }).stateSnapshot.metadata).toEqual({ tokens: 10, role: "builder" });
  });
});

describe("checkpoint semantics", () => {
  it("overwrites a step without changing identity or original timestamp", () => {
    const { runtime, input } = setup();
    const first = buildCheckpoint(input, runtime);
    const replacement = buildCheckpoint({ ...input, status: "FAILED" }, runtime, first);
    expect(replacement).toEqual({ ...first, status: "FAILED" });
    expect(buildCheckpoint({ ...input, stepIndex: 1 }, runtime, first).id).not.toBe(first.id);
  });

  it("records the saving actor and keeps the original author on overwrite", () => {
    const { runtime, input } = setup();
    const first = buildCheckpoint(input, runtime, undefined, "claude");
    expect(first.createdBy).toBe("claude");
    expect(buildCheckpoint({ ...input, status: "FAILED" }, runtime, first, "codex").createdBy).toBe("claude");
    expect(buildCheckpoint(input, runtime).createdBy).toBeUndefined();
    const legacy = buildCheckpoint(input, runtime);
    expect(buildCheckpoint(input, runtime, legacy, "codex").createdBy).toBe("codex");
  });

  it("selects the highest step, bounds history, and ignores other tasks", () => {
    const { runtime, task, input } = setup();
    const checkpoints = Array.from({ length: 15 }, (_, stepIndex) => buildCheckpoint({ ...input, stepIndex }, runtime));
    const context = buildExecutionContext(task, [...checkpoints].reverse(), []);
    expect(context.checkpoint?.stepIndex).toBe(14);
    expect(context.history.map((step) => step.stepIndex)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(context.omittedHistoryCount).toBe(4);
    expect(buildExecutionContext(task, checkpoints, [], 2).history).toHaveLength(2);
    expect(buildExecutionContext(task, [], []).checkpoint).toBeNull();
    expect(buildExecutionContext(task, checkpoints, [], 99).checkpoint).toBeNull();
    expect(buildExecutionContext({ ...task, id: runtime.generateId() }, checkpoints, []).checkpoint).toBeNull();
  });

  it("reports live approval and dependency gates independently of snapshot status", () => {
    const { runtime, task, input } = setup();
    const missingId = runtime.generateId();
    const todoDep = { ...task, id: runtime.generateId(), status: "todo" as const };
    const inProgressDep = { ...task, id: runtime.generateId(), status: "in_progress" as const };
    const doneDep = { ...task, id: runtime.generateId(), status: "done" as const };
    const archivedDep = { ...task, id: runtime.generateId(), status: "archived" as const };
    const guarded = {
      ...task,
      pendingApproval: true as const,
      needsHuman: "Confirm partner ID",
      dependsOn: [todoDep.id, inProgressDep.id, doneDep.id, archivedDep.id, missingId],
    };
    const context = buildExecutionContext(
      guarded,
      [buildCheckpoint(input, runtime)],
      [todoDep, inProgressDep, doneDep, archivedDep],
    );
    expect(context.gates).toEqual({
      pendingApproval: true,
      needsHuman: "Confirm partner ID",
      dependencies: [
        { id: todoDep.id, status: "todo", blocked: true },
        { id: inProgressDep.id, status: "in_progress", blocked: true },
        { id: doneDep.id, status: "done", blocked: false },
        { id: archivedDep.id, status: "archived", blocked: false },
        { id: missingId, status: null, blocked: true },
      ],
    });
    expect(context.task.status).toBe("todo");
  });
});
