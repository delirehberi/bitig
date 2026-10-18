import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "./memory-storage";
import { createTestRuntime } from "../testing/fixtures";

describe("InMemoryStorage", () => {
  it("keeps state per instance", async () => {
    const runtime = createTestRuntime();
    const a = new InMemoryStorage(runtime);
    const b = new InMemoryStorage(runtime);
    await a.createProject({ name: "only in a" });
    expect(await b.getProjects()).toEqual([]);
  });

  it("uses the injected runtime for IDs and timestamps", async () => {
    const storage = new InMemoryStorage(createTestRuntime());
    const project = await storage.createProject({ name: "p" });
    expect(project.id).toBe("01940000-0000-7000-8000-000000000001");
    expect(project.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("falls back to the default runtime", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "p" });
    expect(project.id[14]).toBe("7");
    expect(Date.parse(project.createdAt)).toBeGreaterThan(0);
  });
});

