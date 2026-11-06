import { describe, expect, it } from "vitest";
import {
  HOST_FOLDER_PATH_MAX,
  HostFolderPathSchema,
  RegisterHostFolderInputSchema,
  UnregisterHostFolderInputSchema,
  findHostFolderPathIssue,
  normalizeHostFolderPath,
  suggestHostFolderPath,
  type HostFolderPathIssue,
} from "./host-folder";

describe("findHostFolderPathIssue", () => {
  it.each([
    "/var/www/app",
    "/var/www/my.app",
    "/var/www/.hidden",
    "/srv/projekt-ç",
    "~/www/app",
    "~/www/app/",
    "/home/dev",
  ])("accepts %s", (path) => {
    expect(findHostFolderPathIssue(path)).toBeUndefined();
  });

  it.each<[string, HostFolderPathIssue]>([
    ["", "empty"],
    ["   ", "empty"],
    ["www/app", "relative"],
    ["./app", "relative"],
    ["../app", "relative"],
    ["~user/app", "relative"],
    ["--force", "relative"],
    ["-rf", "relative"],
    [" /var/www/app", "relative"],
    ["/", "root"],
    ["~", "root"],
    ["~/", "root"],
    ["/var//www", "empty_segment"],
    ["/var/www/../etc", "dot_segment"],
    ["/var/./www", "dot_segment"],
    ["~/..", "dot_segment"],
    ["/var/www/--upload-pack=x", "option_like_segment"],
    ["~/-app", "option_like_segment"],
    ["/var/www/app\n", "control_character"],
    ["/var/www/a\u0000b", "control_character"],
    ["/var/www/a\u001bb", "control_character"],
    ["/var/www/a\u007fb", "control_character"],
    ["/var/www/a\u0085b", "control_character"],
  ])("rejects %j as %s", (path, issue) => {
    expect(findHostFolderPathIssue(path)).toBe(issue);
  });

  it("rejects paths over the length limit", () => {
    expect(findHostFolderPathIssue(`/${"a".repeat(HOST_FOLDER_PATH_MAX)}`)).toBe("too_long");
    expect(findHostFolderPathIssue(`/${"a".repeat(HOST_FOLDER_PATH_MAX - 1)}`)).toBeUndefined();
  });
});

describe("normalizeHostFolderPath", () => {
  it("removes trailing slashes", () => {
    expect(normalizeHostFolderPath("/var/www/app///")).toBe("/var/www/app");
    expect(normalizeHostFolderPath("~/www/app/")).toBe("~/www/app");
    expect(normalizeHostFolderPath("/")).toBe("/");
  });
});

describe("HostFolderPathSchema", () => {
  it("normalises valid paths", () => {
    expect(HostFolderPathSchema.parse("/var/www/app/")).toBe("/var/www/app");
  });

  it("reports a readable message for invalid paths", () => {
    const result = HostFolderPathSchema.safeParse("relative/path");
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/absolute/u);
  });

  it("rejects non-string values", () => {
    expect(HostFolderPathSchema.safeParse(42).success).toBe(false);
  });
});

describe("host folder inputs", () => {
  it("rejects unknown keys such as createWorkspaceRootIfMissing", () => {
    expect(
      RegisterHostFolderInputSchema.safeParse({
        workspaceRoot: "/var/www/app",
        createWorkspaceRootIfMissing: true,
      }).success,
    ).toBe(false);
  });

  it("accepts an optional force flag on unregister", () => {
    expect(UnregisterHostFolderInputSchema.parse({})).toEqual({});
    expect(UnregisterHostFolderInputSchema.parse({ force: true })).toEqual({ force: true });
    expect(UnregisterHostFolderInputSchema.safeParse({ force: "yes" }).success).toBe(false);
  });
});

describe("suggestHostFolderPath", () => {
  it("joins the projects root and a slug of the name", () => {
    expect(suggestHostFolderPath("/var/www", "Website Redesign")).toBe("/var/www/website-redesign");
    expect(suggestHostFolderPath("~/www/", "Çay Bahçesi")).toBe("~/www/cay-bahcesi");
  });

  it("returns an empty suggestion when the name has no usable characters", () => {
    expect(suggestHostFolderPath("~/www", "!!!")).toBe("");
  });

  it("always suggests a valid path", () => {
    const suggestion = suggestHostFolderPath("~/www", "--force ../etc");
    expect(findHostFolderPathIssue(suggestion)).toBeUndefined();
  });
});
