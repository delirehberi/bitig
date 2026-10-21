import { describe, expect, it } from "vitest";
import type { Project, Task } from "@bitig/core";
import { findTaskByRef, taskRef } from "./task-ref";

const NOW = "2026-10-21T12:00:00.000Z";
const project: Project = { id: "p1", name: "Bitig", key: "BIT", description: "", kind: "hobby", createdAt: NOW, updatedAt: NOW };
const keyless: Project = { ...project, id: "p2", name: "Old" };
delete (keyless as { key?: string }).key;
const task: Task = {
  id: "t1",
  projectId: project.id,
  number: 64,
  title: "Signup",
  description: "",
  status: "todo",
  isPublic: false,
  createdAt: NOW,
  updatedAt: NOW,
};
const uncoded: Task = { ...task, id: "t2", projectId: keyless.id };

describe("task refs", () => {
  it("names a task by its code, or by its ID while it has none", () => {
    expect(taskRef(task, [project, keyless])).toBe("BIT-64");
    expect(taskRef(uncoded, [project, keyless])).toBe("t2");
  });

  it("finds a task by code in any case, or by ID", () => {
    const tasks = [task, uncoded];
    expect(findTaskByRef("BIT-64", [project, keyless], tasks)).toBe(task);
    expect(findTaskByRef("bit-064", [project, keyless], tasks)).toBe(task);
    expect(findTaskByRef("t2", [project, keyless], tasks)).toBe(uncoded);
    expect(findTaskByRef("BIT-65", [project, keyless], tasks)).toBeUndefined();
  });
});
