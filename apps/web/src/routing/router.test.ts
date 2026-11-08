import { describe, expect, it } from "vitest";
import { hrefFor, parseRoute, taskHref, taskPageHref } from "./router";

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

  it("parses and round-trips the full-page task route /tasks/:ref alongside ?task= modal param", () => {
    expect(parseRoute("/tasks/BIT-123", "")).toEqual({ name: "task", ref: "BIT-123" });
    expect(parseRoute("/tasks/BIT-123/", "")).toEqual({ name: "task", ref: "BIT-123" });
    expect(parseRoute("/tasks/BIT-123", "?task=BIT-64")).toEqual({
      name: "task",
      ref: "BIT-123",
      taskRef: "BIT-64",
    });
    expect(taskPageHref("BIT-123")).toBe("/tasks/BIT-123");
    expect(hrefFor({ name: "task", ref: "BIT-123", taskRef: "BIT-64" })).toBe(
      "/tasks/BIT-123?task=BIT-64",
    );
    expect(taskHref("BIT-64", "/tasks/BIT-123")).toBe("/tasks/BIT-123?task=BIT-64");
    expect(taskHref(undefined, "/tasks/BIT-123?task=BIT-64")).toBe("/tasks/BIT-123");
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

  it("round-trips the reports route and keeps an open task on it", () => {
    expect(parseRoute("/reports", "")).toEqual({ name: "reports" });
    expect(parseRoute("/reports", "?task=BIT-64")).toEqual({ name: "reports", taskRef: "BIT-64" });
    expect(hrefFor({ name: "reports" })).toBe("/reports");
    expect(taskHref("BIT-64", "/reports")).toBe("/reports?task=BIT-64");
  });

  it("round-trips multi-user account, organisation, admin, and register routes", () => {
    expect(parseRoute("/register", "?invite=inv-1&next=%2Fapp")).toEqual({
      name: "register",
      invite: "inv-1",
      next: "/app",
    });
    expect(hrefFor({ name: "register", invite: "inv-1", next: "/app" })).toBe("/register?next=%2Fapp&invite=inv-1");

    expect(parseRoute("/profile", "?task=BIT-64")).toEqual({ name: "profile", taskRef: "BIT-64" });
    expect(hrefFor({ name: "profile" })).toBe("/profile");

    expect(parseRoute("/settings/profile", "")).toEqual({ name: "settings_profile" });
    expect(hrefFor({ name: "settings_profile" })).toBe("/settings/profile");

    expect(parseRoute("/settings/security", "")).toEqual({ name: "settings_security" });
    expect(hrefFor({ name: "settings_security" })).toBe("/settings/security");

    expect(parseRoute("/orgs/acme/settings", "?task=BIT-41")).toEqual({
      name: "org_settings",
      slug: "acme",
      taskRef: "BIT-41",
    });
    expect(hrefFor({ name: "org_settings", slug: "acme" })).toBe("/orgs/acme/settings");

    expect(parseRoute("/orgs/acme/members", "")).toEqual({ name: "org_members", slug: "acme" });
    expect(hrefFor({ name: "org_members", slug: "acme" })).toBe("/orgs/acme/members");

    expect(parseRoute("/admin/users", "")).toEqual({ name: "admin_users" });
    expect(hrefFor({ name: "admin_users" })).toBe("/admin/users");
  });
});
