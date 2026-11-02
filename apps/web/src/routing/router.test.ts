import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute, taskHref } from "./router";

describe("task links", () => {
  it("reads the open task from ?task= on any workspace route alongside existing query parameters", () => {
    expect(parseRoute("/app", "?task=BIT-64")).toEqual({ name: "overview", taskRef: "BIT-64" });
    expect(parseRoute("/projects", "?archived=true&task=BIT-64")).toEqual({
      name: "projects",
      archived: true,
      taskRef: "BIT-64",
    });
    expect(parseRoute("/tasks", "?task=BIT-64")).toEqual({ name: "tasks", taskRef: "BIT-64" });
    expect(parseRoute("/tasks", "?project=p1&needs=human&task=BIT-64")).toEqual({
      name: "tasks",
      projectId: "p1",
      needsHuman: true,
      taskRef: "BIT-64",
    });
    expect(parseRoute("/webhooks", "?project=p1&task=BIT-64")).toEqual({
      name: "webhooks",
      projectId: "p1",
      taskRef: "BIT-64",
    });
    expect(parseRoute("/settings", "?task=BIT-64")).toEqual({
      name: "settings",
      taskRef: "BIT-64",
    });
  });

  it("ignores an empty task parameter", () => {
    expect(parseRoute("/app", "?task=")).toEqual({ name: "overview" });
    expect(parseRoute("/tasks", "?task=")).toEqual({ name: "tasks" });
    expect(parseRoute("/tasks", "?task=%20")).toEqual({ name: "tasks" });
  });

  it("writes the open task into the URL and round-trips it across workspace routes", () => {
    expect(hrefFor({ name: "overview", taskRef: "BIT-64" })).toBe("/app?task=BIT-64");
    expect(hrefFor({ name: "projects", archived: true, taskRef: "BIT-64" })).toBe("/projects?archived=true&task=BIT-64");
    const route = { name: "tasks", projectId: "p1", taskRef: "BIT-64" } as const;
    expect(hrefFor({ name: "tasks", taskRef: "BIT-64" })).toBe("/tasks?task=BIT-64");
    expect(hrefFor(route)).toBe("/tasks?project=p1&task=BIT-64");
    const url = new URL(hrefFor(route), "https://bitig.test");
    expect(parseRoute(url.pathname, url.search)).toEqual(route);
  });

  it("keeps the current workspace page and query parameters when building task links with taskHref", () => {
    expect(taskHref("BIT-64", "/app")).toBe("/app?task=BIT-64");
    expect(taskHref(undefined, "/app?task=BIT-64")).toBe("/app");
    expect(taskHref("BIT-64", "/projects?archived=true")).toBe("/projects?archived=true&task=BIT-64");
    expect(taskHref("BIT-64", "/tasks?project=p1&blocked=true")).toBe("/tasks?project=p1&blocked=true&task=BIT-64");
    expect(taskHref(undefined, "/tasks?project=p1&task=BIT-64")).toBe("/tasks?project=p1");
    expect(taskHref("BIT-64", "/")).toBe("/tasks?task=BIT-64");
  });

  it("round-trips the blocked filter", () => {
    expect(parseRoute("/tasks", "?blocked=true")).toEqual({ name: "tasks", blocked: true });
    expect(parseRoute("/tasks", "?blocked=yes")).toEqual({ name: "tasks" });
    expect(hrefFor({ name: "tasks", projectId: "p1", blocked: true })).toBe("/tasks?project=p1&blocked=true");
  });

  it("round-trips the settings route", () => {
    expect(parseRoute("/settings", "")).toEqual({ name: "settings" });
    expect(hrefFor({ name: "settings" })).toBe("/settings");
  });
});
