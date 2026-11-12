import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PARALLEL_CHILDREN,
  DEFAULT_RUN_LEVELS,
  RunLevelMapSchema,
  RunLevelSchema,
  TaskRunProfileSchema,
  UpsertTaskRunProfileInputSchema,
   ValidationError,
  canOverwriteRunProfile,
  findOverlappingPaths,
  nextLevelUp,
  normalizePathGlob,
  parseRunLevel,
  parseRunLevelMap,
  parseTaskRunProfile,
  pathsOverlap,
  pickParallelBatch,
  resolveRunSelection,
  sortRunLevels,
  type ParallelBatchCandidate,
  type RunLevel,
  type T3ModelSelection,
} from "../index";

const CHEAP_MODEL: T3ModelSelection = {
  providerInstanceId: "prov-claude",
  model: "claude-haiku-4-5",
  options: [{ id: "effort", value: "low" }],
};

const STANDARD_MODEL: T3ModelSelection = {
  providerInstanceId: "prov-claude",
  model: "claude-sonnet-4-6",
  options: [{ id: "effort", value: "medium" }],
};

const STRONG_MODEL: T3ModelSelection = {
  providerInstanceId: "prov-claude",
  model: "claude-opus-4-7",
  options: [{ id: "effort", value: "high" }],
};

const MAPPED_LEVELS: readonly RunLevel[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Small copy or config tweaks",
    order: 0,
    selection: CHEAP_MODEL,
  },
  {
    key: "standard",
    label: "Standard",
    description: "Standard feature work",
    order: 1,
    selection: STANDARD_MODEL,
  },
  {
    key: "strong",
    label: "Strong",
    description: "Complex architecture and UI",
    order: 2,
    selection: STRONG_MODEL,
  },
];

describe("RunLevel, RunLevelMap and DEFAULT_RUN_LEVELS", () => {
  it("validates DEFAULT_RUN_LEVELS against RunLevelMapSchema", () => {
    const parsed = RunLevelMapSchema.parse(DEFAULT_RUN_LEVELS);
    expect(parsed.map((l) => l.key)).toEqual(["cheap", "standard", "strong"]);
    expect(parsed.map((l) => l.order)).toEqual([0, 1, 2]);
    expect(parsed.every((l) => l.description.length > 0)).toBe(true);
    expect(parsed.every((l) => l.selection === undefined)).toBe(true);
  });

  it("normalizes level keys and accepts custom organisation levels", () => {
    const custom = parseRunLevel({
      key: "  UI-Specialist_2 ",
      label: " UI Specialist ",
      description: " Use for frontend tasks ",
      order: 5,
      selection: STRONG_MODEL,
    });
    expect(custom).toEqual({
      key: "ui-specialist_2",
      label: "UI Specialist",
      description: "Use for frontend tasks",
      order: 5,
      selection: STRONG_MODEL,
    });
  });

  it("rejects invalid level keys and duplicate keys in RunLevelMap", () => {
    expect(() =>
      parseRunLevel({
        key: "-bad-key-",
        label: "Bad",
        description: "Desc",
        order: 0,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      RunLevelSchema.parse({
        key: "bad spaces",
        label: "Bad",
        description: "Desc",
        order: 0,
      }),
    ).toThrow();

    expect(() =>
      parseRunLevelMap([
        { key: "cheap", label: "Cheap 1", description: "One", order: 0 },
        { key: "CHEAP", label: "Cheap 2", description: "Two", order: 1 },
      ]),
    ).toThrow(ValidationError);
  });

  it("sorts levels by order and finds nextLevelUp across reordered levels", () => {
    const reordered: RunLevel[] = [
      { key: "ultra", label: "Ultra", description: "Highest", order: 30, selection: STRONG_MODEL },
      { key: "fast", label: "Fast", description: "Lowest", order: 5, selection: CHEAP_MODEL },
      { key: "balanced", label: "Balanced", description: "Middle", order: 15, selection: STANDARD_MODEL },
    ];

    expect(sortRunLevels(reordered).map((l) => l.key)).toEqual(["fast", "balanced", "ultra"]);
    expect(nextLevelUp(reordered, "fast")?.key).toBe("balanced");
    expect(nextLevelUp(reordered, "BALANCED")?.key).toBe("ultra");
    expect(nextLevelUp(reordered, "ultra")).toBeUndefined();
    expect(nextLevelUp(reordered, "nonexistent")).toBeUndefined();
    expect(nextLevelUp(reordered, "")).toBeUndefined();
  });
});

describe("TaskRunProfile schemas and overwrite rules", () => {
  it("parses TaskRunProfile and normalizes/deduplicates path globs", () => {
    const profile = parseTaskRunProfile({
      level: " Standard ",
      selection: STANDARD_MODEL,
      touches: ["./packages/core/src/**", "/packages/core/src/", "packages\\core\\src\\**", "apps/worker/src/index.ts"],
      parallelSafe: true,
      source: "manual",
      reason: "  Picked by Emre ",
      confidence: 0.92,
    });

    expect(profile).toEqual({
      level: "standard",
      selection: STANDARD_MODEL,
      touches: ["packages/core/src/**", "packages/core/src", "apps/worker/src/index.ts"],
      parallelSafe: true,
      source: "manual",
      reason: "Picked by Emre",
      confidence: 0.92,
    });
  });

  it("defaults source to agent in UpsertTaskRunProfileInputSchema and rejects '..' segments or invalid confidence", () => {
    const parsed = UpsertTaskRunProfileInputSchema.parse({
      level: "cheap",
      touches: ["packages/core/**"],
      parallelSafe: true,
    });
    expect(parsed.source).toBe("agent");

    expect(() =>
      TaskRunProfileSchema.parse({
        source: "agent",
        touches: ["packages/../secret/**"],
      }),
    ).toThrow();

    expect(() =>
      TaskRunProfileSchema.parse({
        source: "router",
        confidence: 1.5,
      }),
    ).toThrow();
  });

  it("enforces manual > agent > router overwrite precedence", () => {
    expect(canOverwriteRunProfile(null, "router")).toBe(true);
    expect(canOverwriteRunProfile({ source: "router" }, "router")).toBe(true);
    expect(canOverwriteRunProfile({ source: "router" }, "agent")).toBe(true);
    expect(canOverwriteRunProfile({ source: "router" }, "manual")).toBe(true);
    expect(canOverwriteRunProfile({ source: "agent" }, "router")).toBe(false);
    expect(canOverwriteRunProfile({ source: "agent" }, "agent")).toBe(true);
    expect(canOverwriteRunProfile({ source: "agent" }, "manual")).toBe(true);
    expect(canOverwriteRunProfile({ source: "manual" }, "router")).toBe(false);
    expect(canOverwriteRunProfile({ source: "manual" }, "agent")).toBe(false);
    expect(canOverwriteRunProfile({ source: "manual" }, "manual")).toBe(true);
  });
});

describe("resolveRunSelection", () => {
  const EXPLICIT_CALL_MODEL: T3ModelSelection = {
    providerInstanceId: "prov-codex",
    model: "gpt-5.4",
    options: [{ id: "effort", value: "high" }],
  };

  const PROFILE_OVERRIDE_MODEL: T3ModelSelection = {
    providerInstanceId: "prov-claude",
    model: "claude-opus-4-7",
  };

  it("follows strict precedence: explicit > explicitLevel > profile.selection > profile.level > projectDefaultLevel > default", () => {
    // 1. Explicit wins over everything
    const r1 = resolveRunSelection({
      explicit: EXPLICIT_CALL_MODEL,
      explicitLevel: "strong",
      profile: {
        level: "cheap",
        selection: PROFILE_OVERRIDE_MODEL,
        source: "manual",
      },
      projectDefaultLevel: "standard",
      levels: MAPPED_LEVELS,
    });
    expect(r1).toEqual({
      selection: EXPLICIT_CALL_MODEL,
      source: "explicit",
      skipped: [],
    });

    // 2. Explicit level in call wins over profile
    const r2 = resolveRunSelection({
      explicitLevel: "strong",
      profile: {
        level: "cheap",
        selection: PROFILE_OVERRIDE_MODEL,
        source: "manual",
      },
      projectDefaultLevel: "standard",
      levels: MAPPED_LEVELS,
    });
    expect(r2).toEqual({
      selection: STRONG_MODEL,
      source: "explicit_level",
      levelKey: "strong",
      skipped: [],
    });

    // 3. Profile explicit model override wins over profile level and project default
    const r3 = resolveRunSelection({
      profile: {
        level: "cheap",
        selection: PROFILE_OVERRIDE_MODEL,
        source: "manual",
      },
      projectDefaultLevel: "standard",
      levels: MAPPED_LEVELS,
    });
    expect(r3).toEqual({
      selection: PROFILE_OVERRIDE_MODEL,
      source: "profile_override",
      profileSource: "manual",
      skipped: [],
    });

    // 4. Profile level wins over project default level
    const r4 = resolveRunSelection({
      profile: {
        level: "cheap",
        source: "agent",
      },
      projectDefaultLevel: "standard",
      levels: MAPPED_LEVELS,
    });
    expect(r4).toEqual({
      selection: CHEAP_MODEL,
      source: "profile_level",
      levelKey: "cheap",
      profileSource: "agent",
      skipped: [],
    });

    // 5. Project default level applies when task has no profile
    const r5 = resolveRunSelection({
      projectDefaultLevel: "standard",
      levels: MAPPED_LEVELS,
    });
    expect(r5).toEqual({
      selection: STANDARD_MODEL,
      source: "project_default_level",
      levelKey: "standard",
      skipped: [],
    });

    // 6. Falls back to default (undefined selection) when nothing is set
    const r6 = resolveRunSelection({
      levels: MAPPED_LEVELS,
    });
    expect(r6).toEqual({
      selection: undefined,
      source: "default",
      skipped: [],
    });
  });

  it("falls through unknown level keys and unmapped levels while recording skip reasons", () => {
    const partiallyMapped: RunLevel[] = [
      { key: "cheap", label: "Cheap", description: "Cheap", order: 0 }, // unmapped
      { key: "standard", label: "Standard", description: "Standard", order: 1, selection: STANDARD_MODEL },
    ];

    // Unknown profile level -> falls through to projectDefaultLevel
    const rUnknown = resolveRunSelection({
      profile: { level: "removed-tier", source: "router" },
      projectDefaultLevel: "standard",
      levels: partiallyMapped,
    });
    expect(rUnknown.selection).toEqual(STANDARD_MODEL);
    expect(rUnknown.source).toBe("project_default_level");
    expect(rUnknown.levelKey).toBe("standard");
    expect(rUnknown.skipped).toEqual([
      {
        rule: "profile_level",
        levelKey: "removed-tier",
        reason: "unknown_level",
        message: 'Level "removed-tier" (profile_level) does not exist in the organisation\'s run levels',
      },
    ]);
    expect(rUnknown.skippedReason).toContain("removed-tier");

    // Unmapped profile level + unknown project default -> falls through to T3 default
    const rUnmapped = resolveRunSelection({
      profile: { level: "cheap", source: "agent" },
      projectDefaultLevel: "missing-default",
      levels: partiallyMapped,
    });
    expect(rUnmapped.selection).toBeUndefined();
    expect(rUnmapped.source).toBe("default");
    expect(rUnmapped.skipped.map((s) => ({ rule: s.rule, reason: s.reason }))).toEqual([
      { rule: "profile_level", reason: "unmapped_level" },
      { rule: "project_default_level", reason: "unknown_level" },
    ]);
  });
});

describe("pathsOverlap and glob matching", () => {
  it("normalizes path globs consistently", () => {
    expect(normalizePathGlob(" ./packages/core/src/ ")).toBe("packages/core/src");
    expect(normalizePathGlob("/apps\\worker//src/**")).toBe("apps/worker/src/**");
  });

  it("detects exact, directory-prefix, wildcard, and recursive glob overlaps", () => {
    // Exact match
    expect(pathsOverlap(["packages/core/src/index.ts"], ["packages/core/src/index.ts"])).toBe(true);
    // Disjoint sibling files
    expect(pathsOverlap(["packages/core/src/a.ts"], ["packages/core/src/b.ts"])).toBe(false);
    // Recursive ** glob vs nested file
    expect(pathsOverlap(["packages/core/**"], ["packages/core/src/domain/run-profile.ts"])).toBe(true);
    // Directory prefix without ** vs nested file
    expect(pathsOverlap(["packages/core/src"], ["packages/core/src/domain/run-profile.ts"])).toBe(true);
    // Disjoint package directories
    expect(pathsOverlap(["packages/core/**"], ["packages/storage-d1/**"])).toBe(false);
    // Single-segment wildcard intersection (`*.test.ts` vs `run-profile.*`)
    expect(
      pathsOverlap(["packages/core/src/domain/*.test.ts"], ["packages/core/src/domain/run-profile.*"]),
    ).toBe(true);
    // Non-overlapping extensions in same folder
    expect(
      pathsOverlap(["packages/core/src/domain/*.test.ts"], ["packages/core/src/domain/*.schema.json"]),
    ).toBe(false);
    // Mid-path ** intersection (`**/migrations/*.sql` vs `packages/storage-d1/migrations/0012_init.sql`)
    expect(
      pathsOverlap(["**/migrations/*.sql"], ["packages/storage-d1/migrations/0012_init.sql"]),
    ).toBe(true);
    // Brace expansion
    expect(
      pathsOverlap(["packages/{core,cli}/src/**"], ["packages/cli/src/commands/run.ts"]),
    ).toBe(true);
    expect(
      pathsOverlap(["packages/{core,cli}/src/**"], ["apps/worker/src/index.ts"]),
    ).toBe(false);
  });

  it("returns false for empty or nullish glob lists and exposes overlapping pair via findOverlappingPaths", () => {
    expect(pathsOverlap([], ["packages/core/**"])).toBe(false);
    expect(pathsOverlap(undefined, ["packages/core/**"])).toBe(false);
    expect(findOverlappingPaths(["apps/web/**"], ["packages/core/**", "apps/web/src/App.tsx"])).toEqual([
      "apps/web/**",
      "apps/web/src/App.tsx",
    ]);
  });
});

describe("pickParallelBatch", () => {
  const SERIAL_PATHS = [
    "packages/storage-d1/migrations/**",
    "packages/storage-d1/src/test-schema.sql",
    "pnpm-lock.yaml",
  ];

  it("picks independent, approved, unblocked tasks up to cap and skips overlapping or gated tasks", () => {
    const candidates: ParallelBatchCandidate[] = [
      {
        id: "t1",
        code: "BIT-201",
        touches: ["packages/core/src/domain/run-profile.ts"],
      },
      {
        id: "t2",
        code: "BIT-202",
        pendingApproval: true,
        touches: ["apps/cli/src/**"],
      },
      {
        id: "t3",
        code: "BIT-203",
        blockedBy: ["BIT-200"],
        touches: ["apps/mcp/src/**"],
      },
      {
        id: "t4",
        code: "BIT-204",
        // Overlaps t1
        touches: ["packages/core/src/**"],
      },
      {
        id: "t5",
        code: "BIT-205",
        touches: ["apps/worker/src/router.ts"],
      },
      {
        id: "t6",
        code: "BIT-206",
        touches: ["apps/web/src/components/**"],
      },
      {
        id: "t7",
        code: "BIT-207",
        touches: ["docs/**"],
      },
    ];

    const result = pickParallelBatch(candidates, {
      cap: DEFAULT_MAX_PARALLEL_CHILDREN,
      serialPaths: SERIAL_PATHS,
    });

    expect(result.picked.map((t) => t.code)).toEqual(["BIT-201", "BIT-205", "BIT-206"]);
    expect(result.skipped.map((s) => ({ code: s.code, reason: s.reason, blockingTask: s.blockingTask }))).toEqual([
      { code: "BIT-202", reason: "unapproved", blockingTask: undefined },
      { code: "BIT-203", reason: "blocked", blockingTask: "BIT-200" },
      { code: "BIT-204", reason: "overlaps_picked", blockingTask: "BIT-201" },
      { code: "BIT-207", reason: "cap_reached", blockingTask: undefined },
    ]);
  });

  it("does not pick tasks with no touches, serial paths, or parallelSafe=false alongside others", () => {
    const candidates: ParallelBatchCandidate[] = [
      { id: "t1", code: "BIT-301", touches: ["packages/core/**"] },
      { id: "t2", code: "BIT-302", touches: [] }, // no touches
      { id: "t3", code: "BIT-303", touches: ["packages/storage-d1/migrations/0015_levels.sql"] }, // serial path
      { id: "t4", code: "BIT-304", touches: ["apps/web/**"], parallelSafe: false }, // not parallelSafe
      { id: "t5", code: "BIT-305", touches: ["apps/worker/**"] },
    ];

    const result = pickParallelBatch(candidates, {
      cap: 3,
      serialPaths: SERIAL_PATHS,
    });

    expect(result.picked.map((t) => t.code)).toEqual(["BIT-301", "BIT-305"]);
    expect(result.skipped.map((s) => ({ code: s.code, reason: s.reason }))).toEqual([
      { code: "BIT-302", reason: "no_touches" },
      { code: "BIT-303", reason: "touches_serial_path" },
      { code: "BIT-304", reason: "not_parallel_safe" },
    ]);
  });

  it("allows a task with no touches or a serial path to run alone when nothing else is running or picked", () => {
    const noTouchesFirst: ParallelBatchCandidate[] = [
      { id: "t1", code: "BIT-401" }, // no touches -> picked alone
      { id: "t2", code: "BIT-402", touches: ["packages/core/**"] },
    ];

    const r1 = pickParallelBatch(noTouchesFirst, { serialPaths: SERIAL_PATHS });
    expect(r1.picked.map((t) => t.code)).toEqual(["BIT-401"]);
    expect(r1.skipped).toEqual([
      expect.objectContaining({
        code: "BIT-402",
        reason: "no_touches",
        blockingTask: "BIT-401",
      }),
    ]);

    const serialFirst: ParallelBatchCandidate[] = [
      { id: "t1", code: "BIT-403", touches: ["packages/storage-d1/migrations/0015.sql"] },
      { id: "t2", code: "BIT-404", touches: ["packages/core/**"] },
    ];

    const r2 = pickParallelBatch(serialFirst, { serialPaths: SERIAL_PATHS });
    expect(r2.picked.map((t) => t.code)).toEqual(["BIT-403"]);
    expect(r2.skipped).toEqual([
      expect.objectContaining({
        code: "BIT-404",
        reason: "touches_serial_path",
        blockingTask: "BIT-403",
        blockingPath: "packages/storage-d1/migrations/**",
      }),
    ]);
  });

  it("accounts for currently running tasks (cap, path overlaps, and running solo tasks)", () => {
    const candidates: ParallelBatchCandidate[] = [
      { id: "t1", code: "BIT-501", touches: ["packages/core/src/**"] }, // overlaps running BIT-500
      { id: "t2", code: "BIT-502", touches: ["apps/web/src/**"] }, // ok
      { id: "t3", code: "BIT-503", touches: ["apps/cli/src/**"] }, // hits cap (1 running + 1 picked = 2)
    ];

    const withRunning = pickParallelBatch(candidates, {
      running: [{ id: "r1", code: "BIT-500", touches: ["packages/core/**"] }],
      cap: 2,
      serialPaths: SERIAL_PATHS,
    });

    expect(withRunning.picked.map((t) => t.code)).toEqual(["BIT-502"]);
    expect(withRunning.skipped.map((s) => ({ code: s.code, reason: s.reason, blockingTask: s.blockingTask }))).toEqual([
      { code: "BIT-501", reason: "overlaps_running", blockingTask: "BIT-500" },
      { code: "BIT-503", reason: "cap_reached", blockingTask: undefined },
    ]);

    // If a currently running task has no touches, nothing else can start alongside it
    const withSoloRunning = pickParallelBatch(candidates, {
      running: [{ id: "r-solo", code: "BIT-SOLO", touches: [] }],
      cap: 3,
      serialPaths: SERIAL_PATHS,
    });
    expect(withSoloRunning.picked).toEqual([]);
    expect(withSoloRunning.skipped.every((s) => s.reason === "running_solo_sibling" && s.blockingTask === "BIT-SOLO")).toBe(
      true,
    );
  });
});
