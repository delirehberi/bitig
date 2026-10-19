import { StorageError, type Project, type Task } from "@bitig/core";
import { describe, expect, it } from "vitest";
import { MAX_FILE_CHARS, decodeProject, decodeTask, encodeProject, encodeTask } from "./codec";

const PROJECT_ID = "01940000-0000-7000-8000-000000000001";
const TASK_ID = "01940000-0000-7000-8000-000000000002";
const LOCATION = "some/file";
const NOW = "2026-10-08T13:00:00.000Z";

const project: Project = {
  id: PROJECT_ID,
  name: "Website",
  description: "Redesign",
  kind: "paid",
  createdAt: NOW,
  updatedAt: NOW,
};

const minimalTask: Task = {
  id: TASK_ID,
  projectId: PROJECT_ID,
  title: "Fix header",
  description: "",
  status: "todo",
  isPublic: false,
  createdAt: NOW,
  updatedAt: NOW,
};

const fullTask: Task = {
  ...minimalTask,
  description: "Line one\n\nLine two",
  dueDate: "2026-10-20",
  priority: "high",
  labels: ["ui", "bug"],
  order: 1.5,
  number: 7,
};

function decodeError(fn: () => unknown): StorageError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StorageError) return error;
    throw error;
  }
  throw new Error("expected a StorageError");
}

describe("project codec", () => {
  it("writes fields in a stable order without the id", () => {
    expect(encodeProject(project)).toBe(
      [
        "name: Website",
        "description: Redesign",
        "kind: paid",
        `createdAt: "${NOW}"`,
        `updatedAt: "${NOW}"`,
        "",
      ].join("\n"),
    );
  });

  it("round-trips, taking the id from the caller", () => {
    expect(decodeProject(PROJECT_ID, encodeProject(project), LOCATION)).toEqual(project);
  });

  it("writes the key after the name, quoted so YAML 1.1 never reads NO as false", () => {
    const keyed = { ...project, key: "NO" };
    expect(encodeProject(keyed)).toMatch(/^name: Website\nkey: "NO"\n/);
    expect(decodeProject(PROJECT_ID, encodeProject(keyed), LOCATION)).toEqual(keyed);
  });

  it("drops unknown keys", () => {
    const text = `${encodeProject(project)}color: red\n`;
    expect(decodeProject(PROJECT_ID, text, LOCATION)).toEqual(project);
  });

  it("ignores an id written in the file", () => {
    const text = `${encodeProject(project)}id: 01940000-0000-7000-8000-00000000ffff\n`;
    expect(decodeProject(PROJECT_ID, text, LOCATION).id).toBe(PROJECT_ID);
  });

  it("reports invalid known keys as corrupt with the location", () => {
    const text = encodeProject(project).replace("kind: paid", "kind: galactic");
    const error = decodeError(() => decodeProject(PROJECT_ID, text, LOCATION));
    expect(error.reason).toBe("corrupt");
    expect(error.location).toBe(LOCATION);
    expect(error.message).toMatch(/^some\/file: project file: kind/);
  });

  it("reports malformed YAML as corrupt", () => {
    expect(decodeError(() => decodeProject(PROJECT_ID, "name: [x\n", LOCATION)).reason).toBe("corrupt");
  });

  it("rejects oversized files", () => {
    const text = "x".repeat(MAX_FILE_CHARS + 1);
    expect(decodeError(() => decodeProject(PROJECT_ID, text, LOCATION)).message).toMatch(/exceeds/);
  });
});

describe("task codec", () => {
  it("omits unset optional fields, ids and the description from frontmatter", () => {
    expect(encodeTask(minimalTask)).toBe(
      [
        "---",
        "title: Fix header",
        "status: todo",
        "isPublic: false",
        `createdAt: "${NOW}"`,
        `updatedAt: "${NOW}"`,
        "---",
        "",
      ].join("\n"),
    );
  });

  it("writes the number first", () => {
    expect(encodeTask(fullTask)).toMatch(/^---\nnumber: 7\ntitle: Fix header\n/);
  });

  it("quotes the due date", () => {
    expect(encodeTask(fullTask)).toContain('dueDate: "2026-10-20"\n');
  });

  it.each([
    ["minimal", minimalTask],
    ["full", fullTask],
  ])("round-trips a %s task", (_label, task) => {
    expect(decodeTask(PROJECT_ID, TASK_ID, encodeTask(task), LOCATION)).toEqual(task);
  });

  it("takes projectId from the caller and drops unknown keys", () => {
    const text = encodeTask(minimalTask).replace("---\n", "---\nprojectId: nope\nmood: happy\n");
    const otherProject = "01940000-0000-7000-8000-000000000009";
    expect(decodeTask(otherProject, TASK_ID, text, LOCATION)).toEqual({ ...minimalTask, projectId: otherProject });
  });

  it("accepts an unquoted due date written by hand", () => {
    const text = encodeTask(fullTask).replace('dueDate: "2026-10-20"', "dueDate: 2026-10-20");
    expect(decodeTask(PROJECT_ID, TASK_ID, text, LOCATION).dueDate).toBe("2026-10-20");
  });

  it("reports missing required fields as corrupt", () => {
    const text = encodeTask(minimalTask).replace("status: todo\n", "");
    const error = decodeError(() => decodeTask(PROJECT_ID, TASK_ID, text, LOCATION));
    expect(error.reason).toBe("corrupt");
    expect(error.message).toMatch(/status/);
  });

  it("reports a missing frontmatter block as corrupt", () => {
    expect(decodeError(() => decodeTask(PROJECT_ID, TASK_ID, "just text\n", LOCATION)).reason).toBe("corrupt");
  });
});

