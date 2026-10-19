import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "../memory/memory-storage";
import { createTestRuntime } from "../testing/fixtures";
import { BUNDLE_VERSION } from "./schemas";
import {
  assignMissingTicketCodes,
  backfillTicketCodes,
  deriveProjectKey,
  findTaskByCode,
  nextTaskNumber,
  parseTaskCode,
  resolveProjectRef,
  resolveTaskRef,
  taskCode,
  withTaskCodes,
} from "./ticket-codes";
import { NotFoundError, ValidationError } from "./errors";
import type { Project, Task } from "./types";

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function project(id: string, name: string, key?: string): Project {
  return {
    id,
    name,
    description: "",
    kind: "hobby",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    ...(key === undefined ? {} : { key }),
  };
}

function task(id: string, projectId: string, createdAt: string, number?: number): Task {
  return {
    id,
    projectId,
    title: id,
    description: "",
    status: "todo",
    isPublic: false,
    createdAt,
    updatedAt: createdAt,
    ...(number === undefined ? {} : { number }),
  };
}

const P1 = "01940000-0000-7000-8000-000000000001";
const P2 = "01940000-0000-7000-8000-000000000002";
const T1 = "01940000-0000-7000-8000-000000000011";
const T2 = "01940000-0000-7000-8000-000000000012";
const T3 = "01940000-0000-7000-8000-000000000013";

describe("deriveProjectKey", () => {
  it.each([
    ["Bitig", "BIT"],
    ["news.emre.xyz", "NEW"],
    ["j.emre.xyz", "JEM"],
    ["GEOS WP", "GEO"],
    ["Ula", "ULA"],
    ["Çiçek Şehri", "CIC"],
    ["ılık", "ILI"],
    ["2048 game", "GAM"],
    ["x", "PRJ"],
    ["!!!", "PRJ"],
  ])("derives %s as %s", (name, key) => {
    expect(deriveProjectKey(name, [])).toBe(key);
  });

  it("appends a counter when the key is taken, ignoring case", () => {
    expect(deriveProjectKey("Bitig", ["bit"])).toBe("BIT2");
    expect(deriveProjectKey("Bitig", ["BIT", "BIT2"])).toBe("BIT3");
  });
});

describe("parseTaskCode", () => {
  it.each([
    ["BIT-12", { key: "BIT", number: 12 }],
    ["bit-12", { key: "BIT", number: 12 }],
    [" BIT-012 ", { key: "BIT", number: 12 }],
    ["BIT2-1", { key: "BIT2", number: 1 }],
  ])("parses %s", (code, parsed) => {
    expect(parseTaskCode(code)).toEqual(parsed);
  });

  it.each(["BIT-0", "BIT12", "B-1", "1BI-1", "BIT-", "-12", P1, "BIT-1.5"])("rejects %s", (code) => {
    expect(parseTaskCode(code)).toBeNull();
  });
});

describe("codes", () => {
  it("numbers after the highest existing number", () => {
    expect(nextTaskNumber([])).toBe(1);
    expect(nextTaskNumber([{ number: 3 }, {}, { number: 7 }])).toBe(8);
  });

  it("formats a code only when key and number are set", () => {
    expect(taskCode({ number: 4 }, { key: "BIT" })).toBe("BIT-4");
    expect(taskCode({}, { key: "BIT" })).toBeUndefined();
    expect(taskCode({ number: 4 }, {})).toBeUndefined();
    expect(taskCode({ number: 4 }, undefined)).toBeUndefined();
  });

  it("finds a task by code", () => {
    const projects = [project(P1, "Bitig", "BIT"), project(P2, "Other", "OTH")];
    const tasks = [task(T1, P1, TIMESTAMP, 1), task(T2, P2, TIMESTAMP, 1)];
    expect(findTaskByCode({ key: "OTH", number: 1 }, projects, tasks)?.id).toBe(T2);
    expect(findTaskByCode({ key: "OTH", number: 2 }, projects, tasks)).toBeUndefined();
    expect(findTaskByCode({ key: "NOP", number: 1 }, projects, tasks)).toBeUndefined();
  });
});

describe("assignMissingTicketCodes", () => {
  it("numbers unnumbered tasks oldest first after existing numbers in a keyed project", () => {
    const changed = assignMissingTicketCodes({
      version: BUNDLE_VERSION,
      exportedAt: TIMESTAMP,
      bundles: [
        {
          version: BUNDLE_VERSION,
          exportedAt: TIMESTAMP,
          project: project(P1, "Bitig", "BIT"),
          tasks: [
            task(T1, P1, "2026-01-03T00:00:00.000Z"),
            task(T2, P1, "2026-01-02T00:00:00.000Z"),
            task(T3, P1, "2026-01-01T00:00:00.000Z", 5),
          ],
        },
        { version: BUNDLE_VERSION, exportedAt: TIMESTAMP, project: project(P2, "Other", "OTH"), tasks: [] },
      ],
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.project.key).toBe("BIT");
    expect(changed[0]?.tasks.map((t) => [t.id, t.number])).toEqual([
      [T1, 7],
      [T2, 6],
      [T3, 5],
    ]);
  });

  it("renumbers every task oldest first when the project has no key yet", () => {
    const changed = assignMissingTicketCodes({
      version: BUNDLE_VERSION,
      exportedAt: TIMESTAMP,
      bundles: [
        {
          version: BUNDLE_VERSION,
          exportedAt: TIMESTAMP,
          project: project(P1, "Bitig"),
          tasks: [
            task(T1, P1, "2026-01-03T00:00:00.000Z", 1),
            task(T2, P1, "2026-01-01T00:00:00.000Z"),
            task(T3, P1, "2026-01-02T00:00:00.000Z"),
          ],
        },
        { version: BUNDLE_VERSION, exportedAt: TIMESTAMP, project: project(P2, "Other", "BIT"), tasks: [] },
      ],
    });
    expect(changed).toHaveLength(1);
    expect(changed[0]?.project.key).toBe("BIT2");
    expect(changed[0]?.tasks.map((t) => [t.id, t.number])).toEqual([
      [T1, 3],
      [T2, 1],
      [T3, 2],
    ]);
  });

  it("backfills stored data once and is a no-op afterwards", async () => {
    const storage = new InMemoryStorage(createTestRuntime());
    await storage.importProject({
      version: BUNDLE_VERSION,
      exportedAt: TIMESTAMP,
      project: project(P1, "Bitig"),
      tasks: [task(T1, P1, "2026-01-02T00:00:00.000Z"), task(T2, P1, "2026-01-01T00:00:00.000Z")],
    });

    expect(await backfillTicketCodes(storage)).toEqual({ projects: 1, tasks: 2 });
    expect((await storage.getProject(P1))?.key).toBe("BIT");
    expect((await storage.getTasks()).map((t) => [t.id, t.number])).toEqual([
      [T2, 1],
      [T1, 2],
    ]);
    expect(await backfillTicketCodes(storage)).toEqual({ projects: 0, tasks: 0 });

    const next = await storage.saveTask({ projectId: P1, title: "new" });
    expect(next.number).toBe(3);
  });
});

describe("references", () => {
  async function seeded() {
    const storage = new InMemoryStorage(createTestRuntime());
    const bitig = await storage.createProject({ name: "Bitig" });
    const other = await storage.createProject({ name: "Other" });
    await storage.saveTask({ projectId: bitig.id, title: "first" });
    const second = await storage.saveTask({ projectId: bitig.id, title: "second" });
    const elsewhere = await storage.saveTask({ projectId: other.id, title: "elsewhere" });
    return { storage, bitig, other, second, elsewhere };
  }

  it("resolves task IDs and codes", async () => {
    const { storage, second, elsewhere } = await seeded();
    expect(await resolveTaskRef(storage, second.id)).toBe(second.id);
    expect(await resolveTaskRef(storage, "bit-2")).toBe(second.id);
    expect(await resolveTaskRef(storage, "OTH-1")).toBe(elsewhere.id);
    await expect(resolveTaskRef(storage, "BIT-9")).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveTaskRef(storage, "NOP-1")).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveTaskRef(storage, "nonsense")).rejects.toBeInstanceOf(ValidationError);
  });

  it("resolves project IDs and keys", async () => {
    const { storage, other } = await seeded();
    expect(await resolveProjectRef(storage, other.id)).toBe(other.id);
    expect(await resolveProjectRef(storage, " oth ")).toBe(other.id);
    await expect(resolveProjectRef(storage, "NOP")).rejects.toBeInstanceOf(NotFoundError);
    await expect(resolveProjectRef(storage, "x")).rejects.toBeInstanceOf(ValidationError);
  });

  it("adds codes to tasks that have them", async () => {
    const { storage } = await seeded();
    const tasks = await storage.getTasks();
    const legacy = { ...task(T1, P1, TIMESTAMP) };
    expect(withTaskCodes([...tasks, legacy], await storage.getProjects()).map((t) => t.code)).toEqual([
      "BIT-1",
      "BIT-2",
      "OTH-1",
      undefined,
    ]);
  });
});
