/**
 * Run orchestration: organisation-configurable run levels, task run profiles,
 * model selection resolution, path glob overlap checking, and parallel batch
 * picking (#BIT-184).
 *
 * Environment-neutral: no Node, DOM or Workers APIs.
 */
import { z } from "zod";
import { parseOrThrow } from "./errors";
import { T3ModelSelectionSchema, type T3ModelSelection } from "./t3";

// ---------------------------------------------------------------------------
// Constants & Limits
// ---------------------------------------------------------------------------

export const RUN_LEVEL_KEY_MIN = 1;
export const RUN_LEVEL_KEY_MAX = 64;
export const RUN_LEVEL_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;
export const RUN_LEVEL_LABEL_MAX = 120;
export const RUN_LEVEL_DESCRIPTION_MAX = 1000;
export const RUN_LEVELS_MAX_COUNT = 50;

export const RUN_PROFILE_SOURCES = ["manual", "agent", "router"] as const;
export type RunProfileSource = (typeof RUN_PROFILE_SOURCES)[number];

export const RUN_PROFILE_TOUCHES_MAX_COUNT = 100;
export const RUN_PROFILE_PATH_GLOB_MAX = 512;
export const RUN_PROFILE_REASON_MAX = 1000;

export const DEFAULT_MAX_PARALLEL_CHILDREN = 3;

// ---------------------------------------------------------------------------
// Run Level Types & Schemas
// ---------------------------------------------------------------------------

/**
 * A level key slug (e.g. `cheap`, `standard`, `strong`, or any custom slug).
 * Trimmed and lowercased on parse.
 */
export const RunLevelKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(RUN_LEVEL_KEY_MIN)
  .max(RUN_LEVEL_KEY_MAX)
  .regex(
    RUN_LEVEL_KEY_PATTERN,
    "Run level key must be 1-64 lowercase letters, digits, hyphens or underscores, starting and ending with a letter or digit",
  );

export type RunLevelKey = z.output<typeof RunLevelKeySchema>;

export const RunLevelLabelSchema = z.string().trim().min(1).max(RUN_LEVEL_LABEL_MAX);
export const RunLevelDescriptionSchema = z.string().trim().min(1).max(RUN_LEVEL_DESCRIPTION_MAX);
export const RunLevelOrderSchema = z.number().int().nonnegative();

/**
 * One configurable task level in an organisation's ordered list (#BIT-184).
 * Maps to an optional `T3ModelSelection` (provider instance, model, and options such as effort).
 */
export const RunLevelSchema = z.strictObject({
  key: RunLevelKeySchema,
  label: RunLevelLabelSchema,
  description: RunLevelDescriptionSchema,
  order: RunLevelOrderSchema,
  selection: T3ModelSelectionSchema.exactOptional(),
});

export type RunLevel = z.output<typeof RunLevelSchema>;

/**
 * The organisation's ordered list of run levels.
 * Keys must be unique across the list.
 */
export const RunLevelMapSchema = z
  .array(RunLevelSchema)
  .max(RUN_LEVELS_MAX_COUNT)
  .refine((levels) => new Set(levels.map((level) => level.key)).size === levels.length, {
    message: "Run level keys must be unique",
  });

export type RunLevelMap = readonly RunLevel[];

/**
 * Default run levels (`cheap`, `standard`, `strong`) with default "when to use"
 * descriptions, used to seed a new organisation (#BIT-184).
 */
export const DEFAULT_RUN_LEVELS: readonly RunLevel[] = [
  {
    key: "cheap",
    label: "Cheap",
    description:
      "Fast, low-cost tasks: small copy or config tweaks, simple renames, straightforward tests, and well-scoped single-file edits.",
    order: 0,
  },
  {
    key: "standard",
    label: "Standard",
    description:
      "Everyday feature work, bug fixes, API endpoints, database migrations, and multi-file changes with clear requirements.",
    order: 1,
  },
  {
    key: "strong",
    label: "Strong",
    description:
      "Complex architecture, tricky concurrency or state bugs, security-sensitive code, subtle refactors, UI design, and umbrella orchestration.",
    order: 2,
  },
] as const;

/** Normalize and sort a list of run levels by `order` ascending (ties broken by array position / key). */
export function sortRunLevels(levels: Iterable<RunLevel>): RunLevel[] {
  return [...levels]
    .map((level, index) => ({ level, index }))
    .sort((a, b) => a.level.order - b.level.order || a.index - b.index || a.level.key.localeCompare(b.level.key))
    .map(({ level }) => ({
      ...level,
      ...(level.selection
        ? {
            selection: {
              ...level.selection,
              ...(level.selection.options ? { options: level.selection.options.map((o) => ({ ...o })) } : {}),
            },
          }
        : {}),
    }));
}

/** Find the next higher run level after `key` when ordered by `order`. Returns `undefined` if `key` is unknown or already the highest level. */
export function nextLevelUp(levels: Iterable<RunLevel>, key: string): RunLevel | undefined {
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) return undefined;
  const sorted = sortRunLevels(levels);
  const index = sorted.findIndex((level) => level.key === normalizedKey);
  if (index < 0 || index + 1 >= sorted.length) return undefined;
  return sorted[index + 1];
}

// ---------------------------------------------------------------------------
// Task Run Profile Types & Schemas
// ---------------------------------------------------------------------------

export const RunProfileSourceSchema = z.enum(RUN_PROFILE_SOURCES);

/**
 * Normalize a relative repository path or glob pattern:
 * trims whitespace, converts backslashes to forward slashes, strips leading `./` and `/`,
 * and strips trailing `/` (unless empty).
 */
export function normalizePathGlob(glob: string): string {
  return glob
    .trim()
    .replace(/\\+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\/{2,}/g, "/");
}

export const RunProfilePathGlobSchema = z
  .string()
  .transform(normalizePathGlob)
  .pipe(
    z
      .string()
      .min(1, "Path glob must not be empty")
      .max(RUN_PROFILE_PATH_GLOB_MAX)
      .refine((glob) => !glob.split("/").includes(".."), {
        message: "Path glob must not contain '..' segments",
      }),
  );

export const RunProfileTouchesSchema = z
  .array(RunProfilePathGlobSchema)
  .max(RUN_PROFILE_TOUCHES_MAX_COUNT)
  .transform((globs) => [...new Set(globs)]);

export const RunProfileEffortSchema = z.string().trim().min(1).max(64);
export const RunProfileReasonSchema = z.string().trim().min(1).max(RUN_PROFILE_REASON_MAX);
export const RunProfileConfidenceSchema = z.number().min(0).max(1);

/**
 * Per-task run profile (#BIT-184, #BIT-187):
 * - `level`: organisation run level key
 * - `effort`: optional effort value suggested or chosen for the level's model
 * - `selection`: explicit model override
 * - `touches`: declared path globs the task modifies
 * - `parallelSafe`: whether the task is safe to run alongside siblings when paths do not overlap
 * - `source`: who set the profile (`"manual" | "agent" | "router"`)
 * - `reason`: human-readable explanation for why this level/profile was chosen
 * - `confidence`: optional router confidence in `[0, 1]`
 */
export const TaskRunProfileSchema = z.strictObject({
  level: RunLevelKeySchema.exactOptional(),
  effort: RunProfileEffortSchema.exactOptional(),
  selection: T3ModelSelectionSchema.exactOptional(),
  touches: RunProfileTouchesSchema.exactOptional(),
  parallelSafe: z.boolean().exactOptional(),
  source: RunProfileSourceSchema,
  reason: RunProfileReasonSchema.exactOptional(),
  confidence: RunProfileConfidenceSchema.exactOptional(),
});

export type TaskRunProfile = z.output<typeof TaskRunProfileSchema>;
export type TaskRunProfileInput = z.input<typeof TaskRunProfileSchema>;

/**
 * Agent-facing input schema for `runProfile` on `add_task` / `update_task`, where `source`
 * defaults to `"agent"` when omitted.
 */
export const UpsertTaskRunProfileInputSchema = z.strictObject({
  level: RunLevelKeySchema.exactOptional(),
  effort: RunProfileEffortSchema.exactOptional(),
  selection: T3ModelSelectionSchema.exactOptional(),
  touches: RunProfileTouchesSchema.exactOptional(),
  parallelSafe: z.boolean().exactOptional(),
  source: RunProfileSourceSchema.default("agent"),
  reason: RunProfileReasonSchema.exactOptional(),
  confidence: RunProfileConfidenceSchema.exactOptional(),
});

export type UpsertTaskRunProfileInput = z.input<typeof UpsertTaskRunProfileInputSchema>;

/** Whether changing a task's run profile from `existing` to `incoming` is allowed (`manual` is never overwritten by `agent` or `router`). */
export function canOverwriteRunProfile(
  existing: Pick<TaskRunProfile, "source"> | null | undefined,
  incomingSource: RunProfileSource,
): boolean {
  if (!existing) return true;
  if (incomingSource === "manual") return true;
  if (existing.source === "manual") return false;
  if (existing.source === "agent" && incomingSource === "router") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Model Selection Resolution
// ---------------------------------------------------------------------------

export const RUN_SELECTION_SOURCES = [
  "explicit",
  "explicit_level",
  "profile_override",
  "profile_level",
  "project_default_level",
  "default",
] as const;

export type RunSelectionSource = (typeof RUN_SELECTION_SOURCES)[number];
export const RunSelectionSourceSchema = z.enum(RUN_SELECTION_SOURCES);

export const RUN_SELECTION_SKIP_RULES = [
  "explicit_level",
  "profile_level",
  "project_default_level",
] as const;

export type RunSelectionSkipRule = (typeof RUN_SELECTION_SKIP_RULES)[number];

export const RUN_SELECTION_SKIP_REASONS = ["unknown_level", "unmapped_level"] as const;
export type RunSelectionSkipReason = (typeof RUN_SELECTION_SKIP_REASONS)[number];

export interface SkippedRunSelectionRule {
  readonly rule: RunSelectionSkipRule;
  readonly levelKey: string;
  readonly reason: RunSelectionSkipReason;
  readonly message: string;
}

export interface ExplicitRunModelInput {
  readonly providerInstanceId?: string | undefined;
  readonly model: string;
  readonly options?: T3ModelSelection["options"] | undefined;
}

export interface ResolveRunSelectionInput {
  /** Explicit model selection passed in the launch call or picked in the Start dialog. */
  readonly explicit?: T3ModelSelection | ExplicitRunModelInput | null | undefined;
  /** Optional explicit level key passed in the launch call (e.g. MCP `start_t3_thread({ level })`). */
  readonly explicitLevel?: string | null | undefined;
  /** The task's stored run profile, if any. */
  readonly profile?: Pick<TaskRunProfile, "level" | "effort" | "selection" | "source"> | null | undefined;
  /** The project's default run level key, if configured. */
  readonly projectDefaultLevel?: string | null | undefined;
  /** The organisation's configured run levels (with model selections mapped for the target host). */
  readonly levels?: Iterable<RunLevel> | null | undefined;
}

export interface ResolvedRunSelection {
  /** Resolved T3 model selection, or `undefined` when falling back to the T3 default. */
  readonly selection?: T3ModelSelection | undefined;
  /** Where the resolved model selection came from. */
  readonly source: RunSelectionSource;
  /** The level key that resolved the selection, when resolved through a run level. */
  readonly levelKey?: string | undefined;
  /** Who authored the task profile when resolved from `profile_override` or `profile_level`. */
  readonly profileSource?: RunProfileSource | undefined;
  /** Ordered list of rules that were evaluated and skipped before reaching `source`. */
  readonly skipped: readonly SkippedRunSelectionRule[];
  /** Convenience summary of the first skipped rule's reason, if any rule was skipped. */
  readonly skippedReason?: string | undefined;
}

function cloneSelection(selection: T3ModelSelection): T3ModelSelection {
  return {
    providerInstanceId: selection.providerInstanceId.trim(),
    model: selection.model.trim(),
    ...(selection.options && selection.options.length > 0
      ? { options: selection.options.map((opt) => ({ id: opt.id, value: opt.value })) }
      : {}),
  };
}

function isValidSelection(selection: T3ModelSelection | null | undefined): selection is T3ModelSelection {
  return Boolean(
    selection &&
      typeof selection.providerInstanceId === "string" &&
      selection.providerInstanceId.trim().length > 0 &&
      typeof selection.model === "string" &&
      selection.model.trim().length > 0,
  );
}

/**
 * Resolves the T3 model selection for a launch (#BIT-184):
 * 1. `explicit`: an explicit model selection in the call or Start dialog.
 * 2. `explicitLevel`: an explicit level key in the call (if provided).
 * 3. `profile.selection`: the task run profile's explicit model override.
 * 4. `profile.level`: the task run profile's level key.
 * 5. `projectDefaultLevel`: the project's default level key.
 * 6. Nothing (`selection: undefined`, `source: "default"`), meaning the T3 default.
 *
 * A level key that no longer exists in `levels`, or a level with no `selection` mapped,
 * records a `SkippedRunSelectionRule` and falls through to the next rule.
 */
export function resolveRunSelection(input: ResolveRunSelectionInput): ResolvedRunSelection {
  const skipped: SkippedRunSelectionRule[] = [];
  const levelsByKey = new Map<string, RunLevel>();
  if (input.levels) {
    for (const level of input.levels) {
      levelsByKey.set(level.key.trim().toLowerCase(), level);
    }
  }

  const withSkipped = (base: Omit<ResolvedRunSelection, "skipped" | "skippedReason">): ResolvedRunSelection => {
    const firstSkip = skipped[0];
    return {
      ...base,
      skipped,
      ...(firstSkip ? { skippedReason: firstSkip.message } : {}),
    };
  };

  const tryLevelRule = (
    rawKey: string | null | undefined,
    rule: RunSelectionSkipRule,
    source: RunSelectionSource,
    profileSource?: RunProfileSource,
    profileEffort?: string,
  ): ResolvedRunSelection | undefined => {
    const key = rawKey?.trim().toLowerCase();
    if (!key) return undefined;
    const level = levelsByKey.get(key);
    if (!level) {
      skipped.push({
        rule,
        levelKey: key,
        reason: "unknown_level",
        message: `Level "${key}" (${rule}) does not exist in the organisation's run levels`,
      });
      return undefined;
    }
    if (!isValidSelection(level.selection)) {
      skipped.push({
        rule,
        levelKey: level.key,
        reason: "unmapped_level",
        message: `Level "${level.key}" (${rule}) has no model mapped`,
      });
      return undefined;
    }
    const baseSelection = cloneSelection(level.selection);
    const trimmedEffort = profileEffort?.trim();
    let finalSelection = baseSelection;
    if (trimmedEffort) {
      const existingOptions = baseSelection.options ? [...baseSelection.options] : [];
      const effortIdx = existingOptions.findIndex(
        (opt) => opt.id === "effort" || opt.id === "reasoningEffort" || opt.id === "thinkingEffort",
      );
      const currentEffortOption = effortIdx >= 0 ? existingOptions[effortIdx] : undefined;
      if (currentEffortOption) {
        existingOptions[effortIdx] = { id: currentEffortOption.id, value: trimmedEffort };
      } else {
        existingOptions.push({ id: "effort", value: trimmedEffort });
      }
      finalSelection = {
        ...baseSelection,
        options: existingOptions,
      };
    }
    return withSkipped({
      selection: finalSelection,
      source,
      levelKey: level.key,
      ...(profileSource ? { profileSource } : {}),
    });
  };

  // 1. Explicit model selection in the call
  if (input.explicit && typeof input.explicit.model === "string" && input.explicit.model.trim().length > 0) {
    const trimmedModel = input.explicit.model.trim();
    let providerInstanceId =
      typeof input.explicit.providerInstanceId === "string" ? input.explicit.providerInstanceId.trim() : "";
    if (!providerInstanceId) {
      for (const level of levelsByKey.values()) {
        if (level.selection?.model.trim() === trimmedModel && level.selection.providerInstanceId.trim()) {
          providerInstanceId = level.selection.providerInstanceId.trim();
          break;
        }
      }
    }
    return withSkipped({
      selection: cloneSelection({
        providerInstanceId,
        model: trimmedModel,
        ...(input.explicit.options ? { options: input.explicit.options } : {}),
      }),
      source: "explicit",
    });
  }

  // 2. Explicit level key in the call (optional override before profile)
  const fromExplicitLevel = tryLevelRule(input.explicitLevel, "explicit_level", "explicit_level");
  if (fromExplicitLevel) return fromExplicitLevel;

  // 3. Task profile explicit model override
  if (input.profile && isValidSelection(input.profile.selection)) {
    return withSkipped({
      selection: cloneSelection(input.profile.selection),
      source: "profile_override",
      profileSource: input.profile.source,
    });
  }

  // 4. Task profile level
  const fromProfileLevel = tryLevelRule(
    input.profile?.level,
    "profile_level",
    "profile_level",
    input.profile?.source,
    input.profile?.effort,
  );
  if (fromProfileLevel) return fromProfileLevel;

  // 5. Project default level
  const fromProjectDefault = tryLevelRule(
    input.projectDefaultLevel,
    "project_default_level",
    "project_default_level",
  );
  if (fromProjectDefault) return fromProjectDefault;

  // 6. Fallback to T3 default (no model sent)
  return withSkipped({
    source: "default",
  });
}

// ---------------------------------------------------------------------------
// Glob Overlap Checking
// ---------------------------------------------------------------------------

/**
 * Checks whether two single path segments (no `/`) can match a common segment name.
 * Supports `*` (any characters within the segment) and `?` (any single character).
 * Uses exact product-automaton DP over the two segment patterns.
 */
function segmentPatternsOverlap(a: string, b: string): boolean {
  if (a === "*" || b === "*" || a === b) return true;

  const m = a.length;
  const n = b.length;
  const stride = n + 1;
  // dp[i * stride + j] = whether a[0..i-1] and b[0..j-1] can match the same string
  const dp = new Array<boolean>((m + 1) * stride).fill(false);
  dp[0] = true;

  for (let i = 1; i <= m; i++) {
    if (a.charAt(i - 1) === "*") dp[i * stride] = Boolean(dp[(i - 1) * stride]);
  }
  for (let j = 1; j <= n; j++) {
    if (b.charAt(j - 1) === "*") dp[j] = Boolean(dp[j - 1]);
  }

  for (let i = 1; i <= m; i++) {
    const ca = a.charAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cb = b.charAt(j - 1);
      let match = false;
      if (ca === "*") {
        match = Boolean(dp[(i - 1) * stride + j]) || Boolean(dp[i * stride + (j - 1)]);
      } else if (cb === "*") {
        match = Boolean(dp[i * stride + (j - 1)]) || Boolean(dp[(i - 1) * stride + j]);
      } else if (ca === "?" || cb === "?" || ca === cb) {
        match = Boolean(dp[(i - 1) * stride + (j - 1)]);
      }
      dp[i * stride + j] = match;
    }
  }

  return Boolean(dp[m * stride + n]);
}

/**
 * Expand simple brace expressions `{a,b}` in a glob pattern (bounded to prevent combinatorial blow-up).
 */
function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const prefix = pattern.slice(0, open);
  const suffix = pattern.slice(close + 1);
  const body = pattern.slice(open + 1, close);
  const alternatives = body.split(",").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length === 0 || alternatives.length > 16) return [pattern];
  const results: string[] = [];
  for (const alt of alternatives) {
    for (const expanded of expandBraces(`${prefix}${alt}${suffix}`)) {
      results.push(expanded);
      if (results.length >= 64) return results;
    }
  }
  return results;
}

function splitGlobSegments(raw: string): string[] {
  const normalized = normalizePathGlob(raw);
  if (!normalized) return [];
  const rawSegments = normalized.split("/").filter(Boolean);
  // Collapse consecutive `**` segments
  const segments: string[] = [];
  for (const seg of rawSegments) {
    const normalizedSeg = seg.includes("**") ? "**" : seg;
    if (normalizedSeg === "**" && segments[segments.length - 1] === "**") continue;
    segments.push(normalizedSeg);
  }
  return segments;
}

/**
 * Whether two normalized segment lists can match the same file path, or where one matches a
 * directory prefix of the other (since touching a directory `packages/core` overlaps any file
 * inside `packages/core/**`).
 */
function globSegmentsOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;

  const m = a.length;
  const n = b.length;
  const memo = new Map<number, boolean>();

  const check = (i: number, j: number): boolean => {
    // If both patterns are exhausted, they matched the exact same path.
    if (i === m && j === n) return true;

    // If one pattern is exhausted and did not end with a wildcard-only match, check whether
    // the exhausted pattern represents a directory prefix of the other pattern (e.g.
    // `packages/core` vs `packages/core/src/index.ts`), or whether the remaining segments of
    // the other pattern are all `**` (which can match zero segments).
    if (i === m) {
      if (b[j] === "**" && check(i, j + 1)) return true;
      const lastA = a[m - 1] ?? "";
      if (lastA === "**" || !lastA.includes(".")) return true;
      return false;
    }
    if (j === n) {
      if (a[i] === "**" && check(i + 1, j)) return true;
      const lastB = b[n - 1] ?? "";
      if (lastB === "**" || !lastB.includes(".")) return true;
      return false;
    }

    const key = i * (n + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    const segA = a[i] ?? "";
    const segB = b[j] ?? "";
    let result = false;

    if (segA === "**" && segB === "**") {
      result = check(i + 1, j) || check(i, j + 1) || check(i + 1, j + 1);
    } else if (segA === "**") {
      // `**` matches 0 segments (i + 1, j) or consumes `segB` and stays in `**` (i, j + 1)
      result = check(i + 1, j) || check(i, j + 1);
    } else if (segB === "**") {
      result = check(i, j + 1) || check(i + 1, j);
    } else if (segmentPatternsOverlap(segA, segB)) {
      result = check(i + 1, j + 1);
    }

    memo.set(key, result);
    return result;
  };

  return check(0, 0);
}

/** Whether two individual path globs can match a common file path. */
export function globPairOverlaps(patternA: string, patternB: string): boolean {
  const expandedA = expandBraces(patternA);
  const expandedB = expandBraces(patternB);
  for (const a of expandedA) {
    const segsA = splitGlobSegments(a);
    if (segsA.length === 0) continue;
    for (const b of expandedB) {
      const segsB = splitGlobSegments(b);
      if (segsB.length === 0) continue;
      if (globSegmentsOverlap(segsA, segsB)) return true;
    }
  }
  return false;
}

/**
 * Returns the first pair of overlapping globs `[globA, globB]` between `a` and `b`,
 * or `undefined` when the two glob lists are disjoint.
 */
export function findOverlappingPaths(
  a: Iterable<string> | null | undefined,
  b: Iterable<string> | null | undefined,
): readonly [string, string] | undefined {
  if (!a || !b) return undefined;
  const listA = [...a].map(normalizePathGlob).filter(Boolean);
  const listB = [...b].map(normalizePathGlob).filter(Boolean);
  if (listA.length === 0 || listB.length === 0) return undefined;

  for (const patA of listA) {
    for (const patB of listB) {
      if (globPairOverlaps(patA, patB)) {
        return [patA, patB];
      }
    }
  }
  return undefined;
}

/**
 * Whether two path glob lists `a` and `b` can match any common file (#BIT-184).
 * Empty or missing glob lists do not overlap via `pathsOverlap` (note that `pickParallelBatch`
 * separately treats a task with no `touches` as non-parallelizable alongside others).
 */
export function pathsOverlap(
  a: Iterable<string> | null | undefined,
  b: Iterable<string> | null | undefined,
): boolean {
  return findOverlappingPaths(a, b) !== undefined;
}

/**
 * Returns the unique normalized file paths from `actualPaths` that do not match any glob in
 * `declaredTouches` (#BIT-190). When `declaredTouches` is empty or missing, returns `[]`.
 */
export function findOutOfBoundsPaths(
  declaredTouches: Iterable<string> | null | undefined,
  actualPaths: Iterable<string> | null | undefined,
): string[] {
  if (!declaredTouches || !actualPaths) return [];
  const globs = [...declaredTouches].map(normalizePathGlob).filter(Boolean);
  if (globs.length === 0) return [];
  const outOfBounds: string[] = [];
  const seen = new Set<string>();
  for (const rawPath of actualPaths) {
    const filePath = normalizePathGlob(rawPath);
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    const covered = globs.some((glob) => globPairOverlaps(glob, filePath));
    if (!covered) {
      outOfBounds.push(filePath);
    }
  }
  return outOfBounds;
}

// ---------------------------------------------------------------------------
// Parallel Batch Picking
// ---------------------------------------------------------------------------

export interface RunningParallelTask {
  readonly id: string;
  readonly code?: string | undefined;
  readonly touches?: readonly string[] | null | undefined;
  readonly parallelSafe?: boolean | null | undefined;
}

export interface ParallelBatchCandidate {
  readonly id: string;
  readonly code?: string | undefined;
  /** Whether the task is approved (set to `false` or set `pendingApproval: true` when awaiting human approval). */
  readonly approved?: boolean | undefined;
  readonly pendingApproval?: boolean | undefined;
  /** Unfinished dependency IDs or codes blocking this task (`true` or non-empty array means blocked). */
  readonly blocked?: boolean | undefined;
  readonly blockedBy?: readonly string[] | null | undefined;
  /** Declared path globs on the candidate's run profile (`touches` or `profile.touches`). */
  readonly touches?: readonly string[] | null | undefined;
  /** Whether the candidate is marked parallel-safe (`false` forces solo execution). */
  readonly parallelSafe?: boolean | null | undefined;
  readonly profile?: Pick<TaskRunProfile, "touches" | "parallelSafe"> | null | undefined;
}

export interface PickParallelBatchOptions {
  /** Currently running sibling tasks under the same umbrella. */
  readonly running?: Iterable<RunningParallelTask> | null | undefined;
  /** Maximum concurrent children allowed (defaults to `DEFAULT_MAX_PARALLEL_CHILDREN` = 3). */
  readonly cap?: number | null | undefined;
  /** Project serial path globs (e.g. migrations, lockfiles) that may never run alongside other tasks. */
  readonly serialPaths?: Iterable<string> | null | undefined;
}

export const PARALLEL_SKIP_REASONS = [
  "already_running",
  "unapproved",
  "blocked",
  "cap_reached",
  "running_solo_sibling",
  "no_touches",
  "not_parallel_safe",
  "touches_serial_path",
  "overlaps_running",
  "overlaps_picked",
] as const;

export type ParallelSkipReason = (typeof PARALLEL_SKIP_REASONS)[number];

export interface SkippedParallelCandidate<T extends ParallelBatchCandidate = ParallelBatchCandidate> {
  readonly task: T;
  readonly taskId: string;
  readonly code?: string | undefined;
  readonly reason: ParallelSkipReason;
  readonly message: string;
  /** ID or code of the running or picked sibling that blocked this candidate, when applicable. */
  readonly blockingTask?: string | undefined;
  /** The serial path or overlapping path glob that blocked this candidate, when applicable. */
  readonly blockingPath?: string | undefined;
}

export interface ParallelBatchResult<T extends ParallelBatchCandidate = ParallelBatchCandidate> {
  readonly picked: readonly T[];
  readonly skipped: readonly SkippedParallelCandidate<T>[];
}

function taskLabel(task: { readonly id: string; readonly code?: string | undefined }): string {
  return task.code ?? task.id;
}

function resolveCandidateTouches(task: ParallelBatchCandidate): string[] {
  const raw = task.touches ?? task.profile?.touches ?? [];
  return raw.map(normalizePathGlob).filter(Boolean);
}

function resolveCandidateParallelSafe(task: ParallelBatchCandidate): boolean {
  if (task.parallelSafe === false || task.profile?.parallelSafe === false) return false;
  return true;
}

function isCandidateApproved(task: ParallelBatchCandidate): boolean {
  if (task.approved === false) return false;
  if (task.pendingApproval === true) return false;
  return true;
}

function candidateBlockers(task: ParallelBatchCandidate): string[] {
  const explicit = (task.blockedBy ?? []).filter(Boolean);
  if (explicit.length > 0) return [...explicit];
  if (task.blocked === true) return ["unfinished dependency"];
  return [];
}

/**
 * Picks the next batch of child tasks that may run in parallel (#BIT-184):
 * - Only approved, unblocked tasks are eligible.
 * - Respects `cap` (including `running` tasks).
 * - A task with no `touches`, with `parallelSafe === false`, or touching any `serialPaths`
 *    is a "solo" task: it may only be picked when nothing is `running` and nothing else has
 *   been picked yet, and once picked it closes the batch so no other task runs alongside it.
 * - Similarly, if a currently `running` task has no `touches`, has `parallelSafe === false`,
 *   or touches `serialPaths`, no additional tasks can start alongside it.
 * - A candidate whose `touches` overlap a `running` task or an already `picked` task is skipped.
 */
export function pickParallelBatch<T extends ParallelBatchCandidate>(
  candidates: Iterable<T>,
  options: PickParallelBatchOptions = {},
): ParallelBatchResult<T> {
  const runningList = [...(options.running ?? [])];
  const runningIds = new Set(runningList.map((r) => r.id));
  const cap = options.cap === undefined || options.cap === null ? DEFAULT_MAX_PARALLEL_CHILDREN : Math.max(0, Math.floor(options.cap));
  const serialPaths = [...(options.serialPaths ?? [])].map(normalizePathGlob).filter(Boolean);

  const picked: T[] = [];
  const pickedTouches = new Map<string, readonly string[]>();
  const skipped: SkippedParallelCandidate<T>[] = [];
  let pickedSoloTask: T | undefined;

  // Determine whether any currently running sibling forces solo execution
  let runningSoloSibling: { readonly task: RunningParallelTask; readonly reasonMessage: string; readonly path?: string } | undefined;
  const runningNormalizedTouches = new Map<string, readonly string[]>();
  for (const runningTask of runningList) {
    const touches = (runningTask.touches ?? []).map(normalizePathGlob).filter(Boolean);
    runningNormalizedTouches.set(runningTask.id, touches);
    if (!runningSoloSibling) {
      if (runningTask.parallelSafe === false) {
        runningSoloSibling = {
          task: runningTask,
          reasonMessage: `Running task ${taskLabel(runningTask)} is not parallel-safe and must run alone`,
        };
      } else if (touches.length === 0) {
        runningSoloSibling = {
          task: runningTask,
          reasonMessage: `Running task ${taskLabel(runningTask)} has no declared touched paths and must run alone`,
        };
      } else {
        const serialMatch = findOverlappingPaths(touches, serialPaths);
        if (serialMatch) {
          runningSoloSibling = {
            task: runningTask,
            reasonMessage: `Running task ${taskLabel(runningTask)} touches serial path "${serialMatch[1]}" and must run alone`,
            path: serialMatch[1],
          };
        }
      }
    }
  }

  const pushSkip = (
    task: T,
    reason: ParallelSkipReason,
    message: string,
    extra?: { readonly blockingTask?: string | undefined; readonly blockingPath?: string | undefined },
  ): void => {
    skipped.push({
      task,
      taskId: task.id,
      ...(task.code ? { code: task.code } : {}),
      reason,
      message,
      ...(extra?.blockingTask ? { blockingTask: extra.blockingTask } : {}),
      ...(extra?.blockingPath ? { blockingPath: extra.blockingPath } : {}),
    });
  };

  for (const candidate of candidates) {
    if (runningIds.has(candidate.id)) {
      pushSkip(candidate, "already_running", `Task ${taskLabel(candidate)} is already running`);
      continue;
    }

    if (!isCandidateApproved(candidate)) {
      pushSkip(
        candidate,
        "unapproved",
        `Task ${taskLabel(candidate)} is awaiting human approval`,
      );
      continue;
    }

    const blockers = candidateBlockers(candidate);
    if (blockers.length > 0) {
      pushSkip(
        candidate,
        "blocked",
        `Task ${taskLabel(candidate)} is blocked by unfinished dependencies: ${blockers.join(", ")}`,
        { blockingTask: blockers[0] },
      );
      continue;
    }

    const activeCount = runningList.length + picked.length;
    if (activeCount >= cap) {
      pushSkip(
        candidate,
        "cap_reached",
        `Parallel cap (${String(cap)}) reached`,
      );
      continue;
    }

    if (runningSoloSibling) {
      pushSkip(
        candidate,
        "running_solo_sibling",
        runningSoloSibling.reasonMessage,
        {
          blockingTask: taskLabel(runningSoloSibling.task),
          ...(runningSoloSibling.path ? { blockingPath: runningSoloSibling.path } : {}),
        },
      );
      continue;
    }

    if (pickedSoloTask) {
      const soloTouches = resolveCandidateTouches(pickedSoloTask);
      const soloSerial = findOverlappingPaths(soloTouches, serialPaths);
      if (!resolveCandidateParallelSafe(pickedSoloTask)) {
        pushSkip(
          candidate,
          "not_parallel_safe",
          `Picked task ${taskLabel(pickedSoloTask)} is not parallel-safe and must run alone`,
          { blockingTask: taskLabel(pickedSoloTask) },
        );
      } else if (soloSerial) {
        pushSkip(
          candidate,
          "touches_serial_path",
          `Picked task ${taskLabel(pickedSoloTask)} touches serial path "${soloSerial[1]}" and must run alone`,
          { blockingTask: taskLabel(pickedSoloTask), blockingPath: soloSerial[1] },
        );
      } else {
        pushSkip(
          candidate,
          "no_touches",
          `Picked task ${taskLabel(pickedSoloTask)} has no declared touched paths and must run alone`,
          { blockingTask: taskLabel(pickedSoloTask) },
        );
      }
      continue;
    }

    const touches = resolveCandidateTouches(candidate);
    const parallelSafe = resolveCandidateParallelSafe(candidate);
    const serialOverlap = findOverlappingPaths(touches, serialPaths);

    // Check if this candidate itself must run solo
    if (!parallelSafe) {
      if (activeCount === 0) {
        picked.push(candidate);
        pickedTouches.set(candidate.id, touches);
        pickedSoloTask = candidate;
      } else {
        const blocker = runningList[0] ?? picked[0];
        pushSkip(
          candidate,
          "not_parallel_safe",
          `Task ${taskLabel(candidate)} is not parallel-safe and cannot run alongside other tasks`,
          ...(blocker ? [{ blockingTask: taskLabel(blocker) }] : []),
        );
      }
      continue;
    }

    if (touches.length === 0) {
      if (activeCount === 0) {
        picked.push(candidate);
        pickedTouches.set(candidate.id, touches);
        pickedSoloTask = candidate;
      } else {
        const blocker = runningList[0] ?? picked[0];
        pushSkip(
          candidate,
          "no_touches",
          `Task ${taskLabel(candidate)} has no declared touched paths and cannot run alongside other tasks`,
          ...(blocker ? [{ blockingTask: taskLabel(blocker) }] : []),
        );
      }
      continue;
    }

    if (serialOverlap) {
      if (activeCount === 0) {
        picked.push(candidate);
        pickedTouches.set(candidate.id, touches);
        pickedSoloTask = candidate;
      } else {
        const blocker = runningList[0] ?? picked[0];
        pushSkip(
          candidate,
          "touches_serial_path",
          `Task ${taskLabel(candidate)} touches serial path "${serialOverlap[1]}" and cannot run alongside other tasks`,
          {
            ...(blocker ? { blockingTask: taskLabel(blocker) } : {}),
            blockingPath: serialOverlap[1],
          },
        );
      }
      continue;
    }

    // Check overlap against currently running tasks
    let overlappedRunning = false;
    for (const runningTask of runningList) {
      const rTouches = runningNormalizedTouches.get(runningTask.id) ?? [];
      const match = findOverlappingPaths(touches, rTouches);
      if (match) {
        pushSkip(
          candidate,
          "overlaps_running",
          `Task ${taskLabel(candidate)} path "${match[0]}" overlaps running task ${taskLabel(runningTask)} path "${match[1]}"`,
          {
            blockingTask: taskLabel(runningTask),
            blockingPath: match[0],
          },
        );
        overlappedRunning = true;
        break;
      }
    }
    if (overlappedRunning) continue;

    // Check overlap against already picked tasks in this batch
    let overlappedPicked = false;
    for (const pickedTask of picked) {
      const pTouches = pickedTouches.get(pickedTask.id) ?? [];
      const match = findOverlappingPaths(touches, pTouches);
      if (match) {
        pushSkip(
          candidate,
          "overlaps_picked",
          `Task ${taskLabel(candidate)} path "${match[0]}" overlaps picked task ${taskLabel(pickedTask)} path "${match[1]}"`,
          {
            blockingTask: taskLabel(pickedTask),
            blockingPath: match[0],
          },
        );
        overlappedPicked = true;
        break;
      }
    }
    if (overlappedPicked) continue;

    picked.push(candidate);
    pickedTouches.set(candidate.id, touches);
  }

  return { picked, skipped };
}

/** Validate and parse a `RunLevel` or throw `ValidationError`. */
export function parseRunLevel(input: unknown, context = "runLevel"): RunLevel {
  return parseOrThrow(RunLevelSchema, input, context);
}

/** Validate and parse a `RunLevelMap` or throw `ValidationError`. */
export function parseRunLevelMap(input: unknown, context = "runLevelMap"): RunLevel[] {
  return sortRunLevels(parseOrThrow(RunLevelMapSchema, input, context));
}

/** Validate and parse a `TaskRunProfile` or throw `ValidationError`. */
export function parseTaskRunProfile(input: unknown, context = "taskRunProfile"): TaskRunProfile {
  return parseOrThrow(TaskRunProfileSchema, input, context);
}

// ---------------------------------------------------------------------------
// Run Level Model Bindings, AI Router Settings, Project Run Settings & Children (#BIT-185)
// ---------------------------------------------------------------------------

export const AI_ROUTER_API_STYLES = ["cloudflare-run", "openai", "openai-chat"] as const;
export type AiRouterApiStyle = (typeof AI_ROUTER_API_STYLES)[number];
export const AiRouterApiStyleSchema = z.enum(AI_ROUTER_API_STYLES);

export const AI_ROUTER_BASE_URL_MAX = 1024;
export const AI_ROUTER_MODEL_MAX = 200;
export const AI_ROUTER_TOKEN_LAST4_LENGTH = 4;

export const OrgAiRouterSettingsSchema = z.strictObject({
  orgId: z.string().trim().min(1),
  baseUrl: z.string().trim().min(1).max(AI_ROUTER_BASE_URL_MAX),
  model: z.string().trim().min(1).max(AI_ROUTER_MODEL_MAX),
  apiStyle: AiRouterApiStyleSchema.default("cloudflare-run"),
  hasToken: z.boolean(),
  tokenLast4: z.string().trim().min(1).max(AI_ROUTER_TOKEN_LAST4_LENGTH).exactOptional(),
  enabled: z.boolean(),
  updatedBy: z.string().trim().min(1).max(200).exactOptional(),
  updatedAt: z.string().trim().min(1),
});

export type OrgAiRouterSettings = z.output<typeof OrgAiRouterSettingsSchema>;

export const MAX_PARALLEL_CHILDREN_MIN = 1;
export const MAX_PARALLEL_CHILDREN_MAX = 20;

export const ProjectRunSettingsSchema = z.strictObject({
  projectId: z.string().trim().min(1),
  defaultRunLevel: RunLevelKeySchema.exactOptional(),
  serialPaths: RunProfileTouchesSchema.default([]),
  maxParallelChildren: z
    .number()
    .int()
    .min(MAX_PARALLEL_CHILDREN_MIN)
    .max(MAX_PARALLEL_CHILDREN_MAX)
    .default(DEFAULT_MAX_PARALLEL_CHILDREN),
  updatedAt: z.string().trim().min(1).exactOptional(),
});

export type ProjectRunSettings = z.output<typeof ProjectRunSettingsSchema>;

export const UpsertProjectRunSettingsInputSchema = z.strictObject({
  defaultRunLevel: RunLevelKeySchema.nullable().exactOptional(),
  serialPaths: RunProfileTouchesSchema.exactOptional(),
  maxParallelChildren: z
    .number()
    .int()
    .min(MAX_PARALLEL_CHILDREN_MIN)
    .max(MAX_PARALLEL_CHILDREN_MAX)
    .exactOptional(),
});

export type UpsertProjectRunSettingsInput = z.input<typeof UpsertProjectRunSettingsInputSchema>;

export const AGENT_RUN_CHILD_STATES = [
  "running",
  "done",
  "failed",
  "needs_human",
  "stopped",
] as const;

export type AgentRunChildState = (typeof AGENT_RUN_CHILD_STATES)[number];
export const AgentRunChildStateSchema = z.enum(AGENT_RUN_CHILD_STATES);

export const AgentRunChildSchema = z.strictObject({
  parentTaskId: z.string().trim().min(1),
  childTaskId: z.string().trim().min(1),
  state: AgentRunChildStateSchema,
  branch: z.string().trim().min(1).max(256).exactOptional(),
  headSha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).exactOptional(),
  mergedAt: z.string().trim().min(1).exactOptional(),
  mergedSha: z.string().regex(/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/).exactOptional(),
  startedAt: z.string().trim().min(1),
  finishedAt: z.string().trim().min(1).exactOptional(),
});

export type AgentRunChild = z.output<typeof AgentRunChildSchema>;

export const RunLevelModelBindingSchema = z.strictObject({
  levelKey: RunLevelKeySchema,
  hostId: z.string().trim().min(1).max(200).nullable().exactOptional(),
  selection: T3ModelSelectionSchema,
  updatedAt: z.string().trim().min(1).exactOptional(),
});

export type RunLevelModelBinding = z.output<typeof RunLevelModelBindingSchema>;

