import { describe, expect, it } from "vitest";
import { isEntityId, projectDirPath, projectFilePath, taskFilePath, taskIdFromFileName } from "./layout";

const PROJECT_ID = "01940000-0000-7000-8000-000000000001";
const TASK_ID = "01940000-0000-7000-8000-000000000002";

describe("layout", () => {
  it("builds ID-based relative paths", () => {
    expect(projectDirPath(PROJECT_ID)).toBe(PROJECT_ID);
    expect(projectFilePath(PROJECT_ID)).toBe(`${PROJECT_ID}/_project.yaml`);
    expect(taskFilePath(PROJECT_ID, TASK_ID)).toBe(`${PROJECT_ID}/${TASK_ID}.md`);
  });

  it.each(["..", "../etc", "/abs", "a/b", "", "01940000-0000-4000-8000-000000000001"])(
    "refuses to build paths from %j",
    (bad) => {
      expect(isEntityId(bad)).toBe(false);
      expect(() => projectDirPath(bad)).toThrow(TypeError);
      expect(() => taskFilePath(PROJECT_ID, bad)).toThrow(TypeError);
    },
  );

  it("recognizes task file names", () => {
    expect(taskIdFromFileName(`${TASK_ID}.md`)).toBe(TASK_ID);
    expect(taskIdFromFileName(TASK_ID)).toBeNull();
    expect(taskIdFromFileName("notes.md")).toBeNull();
    expect(taskIdFromFileName(`${TASK_ID}.md.bak`)).toBeNull();
    expect(taskIdFromFileName(".md")).toBeNull();
  });
});

