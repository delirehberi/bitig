import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BitigError,
  NotFoundError,
  StorageError,
  ValidationError,
  isBitigError,
  parseOrThrow,
} from "./errors";

describe("parseOrThrow", () => {
  const schema = z.strictObject({ name: z.string().min(1) });

  it("returns parsed data on success", () => {
    expect(parseOrThrow(schema, { name: "a" }, "test")).toEqual({ name: "a" });
  });

  it("throws ValidationError with context, issues and cause", () => {
    let caught: unknown;
    try {
      parseOrThrow(schema, { name: "" }, "createProject");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toMatch(/^createProject: name: /);
    expect(error.issues).toHaveLength(1);
    expect(error.cause).toBeInstanceOf(z.ZodError);
  });
});

describe("NotFoundError", () => {
  it("carries entity, id and code", () => {
    const cause = new Error("db");
    const error = new NotFoundError("task", "abc", { cause });
    expect(error).toBeInstanceOf(BitigError);
    expect(error.code).toBe("NOT_FOUND");
    expect(error.entity).toBe("task");
    expect(error.id).toBe("abc");
    expect(error.message).toBe("task abc not found");
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("NotFoundError");
  });
});

describe("StorageError", () => {
  it("prefixes the location and carries reason, code and cause", () => {
    const cause = new Error("EACCES");
    const error = new StorageError("io", "cannot read file", { location: "a/b.md", cause });
    expect(error).toBeInstanceOf(BitigError);
    expect(error.code).toBe("STORAGE");
    expect(error.reason).toBe("io");
    expect(error.location).toBe("a/b.md");
    expect(error.message).toBe("a/b.md: cannot read file");
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("StorageError");
  });

  it("omits the prefix when no location is given", () => {
    const error = new StorageError("lock", "timed out");
    expect(error.location).toBeUndefined();
    expect(error.message).toBe("timed out");
  });
});

describe("isBitigError", () => {
  it("distinguishes domain errors", () => {
    expect(isBitigError(new NotFoundError("project", "x"))).toBe(true);
    expect(isBitigError(new StorageError("corrupt", "x"))).toBe(true);
    expect(isBitigError(new Error("x"))).toBe(false);
    expect(isBitigError("x")).toBe(false);
  });
});

