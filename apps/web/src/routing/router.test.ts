import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute } from "./router";

describe("task links", () => {
  it("reads the open task from ?task= alongside the list filters", () => {
    expect(parseRoute("/tasks", "?task=BIT-64")).toEqual({ name: "tasks", taskRef: "BIT-64" });
    expect(parseRoute("/tasks", "?project=p1&needs=human&task=BIT-64")).toEqual({
      name: "tasks",
      projectId: "p1",
      needsHuman: true,
      taskRef: "BIT-64",
    });
  });

  it("ignores an empty task parameter", () => {
    expect(parseRoute("/tasks", "?task=")).toEqual({ name: "tasks" });
    expect(parseRoute("/tasks", "?task=%20")).toEqual({ name: "tasks" });
  });

  it("writes the open task into the URL and round-trips it", () => {
    const route = { name: "tasks", projectId: "p1", taskRef: "BIT-64" } as const;
    expect(hrefFor({ name: "tasks", taskRef: "BIT-64" })).toBe("/tasks?task=BIT-64");
    expect(hrefFor(route)).toBe("/tasks?project=p1&task=BIT-64");
    const url = new URL(hrefFor(route), "https://bitig.test");
    expect(parseRoute(url.pathname, url.search)).toEqual(route);
  });

  it("round-trips the blocked filter", () => {
    expect(parseRoute("/tasks", "?blocked=true")).toEqual({ name: "tasks", blocked: true });
    expect(parseRoute("/tasks", "?blocked=yes")).toEqual({ name: "tasks" });
    expect(hrefFor({ name: "tasks", projectId: "p1", blocked: true })).toBe("/tasks?project=p1&blocked=true");
  });
});
