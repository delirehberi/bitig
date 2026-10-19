import { describe, expect, it } from "vitest";
import type { Task } from "@bitig/core";
import { planMove } from "./reorder";

function task(id: string, order?: number): Task {
  const t: Task = {
    id,
    projectId: "p",
    title: id,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  if (order !== undefined) t.order = order;
  return t;
}

function summary(changes: ReturnType<typeof planMove>) {
  return changes.map((c) => [c.task.id, c.order]);
}

describe("planMove", () => {
  const a = task("a", 0);
  const b = task("b", 1);
  const c = task("c", 2);

  it("places a task between its new neighbours with one write", () => {
    expect(summary(planMove([a, b, c], c, 1))).toEqual([["c", 0.5]]);
  });

  it("moves to the top and the bottom", () => {
    expect(summary(planMove([a, b, c], c, 0))).toEqual([["c", -1]]);
    expect(summary(planMove([a, b, c], a, 2))).toEqual([["a", 3]]);
  });

  it("does nothing when dropped where it already is", () => {
    expect(planMove([a, b, c], b, 1)).toEqual([]);
  });

  it("inserts a task coming from another column", () => {
    const x = task("x");
    expect(summary(planMove([a, b], x, 1))).toEqual([["x", 0.5]]);
    expect(summary(planMove([], x, 0))).toEqual([["x", 0]]);
  });

  it("renumbers the column when neighbours have no order", () => {
    const u = task("u");
    const v = task("v");
    expect(summary(planMove([a, u, v], v, 1))).toEqual([
      ["v", 1],
      ["u", 2],
    ]);
  });

  it("renumbers when neighbours share an order", () => {
    const d = task("d", 1);
    expect(summary(planMove([a, b, d, c], c, 2))).toEqual([
      ["c", 2],
      ["d", 3],
    ]);
  });
});
