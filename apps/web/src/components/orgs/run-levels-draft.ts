import {
  RUN_LEVEL_KEY_MAX,
  type RunLevel,
  type RunLevelModelBinding,
  type T3ModelSelection,
} from "@bitig/core";
import type { SaveRunLevelsInput } from "../../services/run-orchestration";

/** One level row in the Task levels editor (#BIT-188). `key` is fixed once saved; renaming changes `label`. */
export interface LevelDraft {
  /** Stable React key and identity of rows that were never saved. */
  readonly rowId: string;
  /** The saved key, or `undefined` for a new level (derived from its label on save). */
  readonly key: string | undefined;
  readonly label: string;
  readonly description: string;
  /** The model for every host, or `null` for T3's default. */
  readonly selection: T3ModelSelection | null;
  /** Host ID → the model used on that host instead of `selection`. */
  readonly hostOverrides: Readonly<Record<string, T3ModelSelection>>;
}

const FALLBACK_KEY = "level";
const NON_KEY_CHARS = /[^a-z0-9]+/g;
const EDGE_DASHES = /^-+|-+$/g;

/** Turns a label into a run level key (`^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$`) not in `taken`. */
export function levelKeyFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base =
    label.toLowerCase().replace(NON_KEY_CHARS, "-").replace(EDGE_DASHES, "").slice(0, RUN_LEVEL_KEY_MAX).replace(EDGE_DASHES, "") ||
    FALLBACK_KEY;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const candidate = `${base.slice(0, RUN_LEVEL_KEY_MAX - suffix.length).replace(EDGE_DASHES, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Builds editor rows from `GET /api/orgs/:id/run-levels`. */
export function draftsFromServer(levels: readonly RunLevel[], models: readonly RunLevelModelBinding[]): LevelDraft[] {
  return [...levels]
    .sort((a, b) => a.order - b.order)
    .map((level) => {
      const bindings = models.filter((m) => m.levelKey === level.key);
      const defaultBinding = bindings.find((m) => !m.hostId);
      const hostOverrides: Record<string, T3ModelSelection> = {};
      for (const binding of bindings) {
        if (binding.hostId) hostOverrides[binding.hostId] = binding.selection;
      }
      return {
        rowId: `saved:${level.key}`,
        key: level.key,
        label: level.label,
        description: level.description,
        selection: defaultBinding?.selection ?? level.selection ?? null,
        hostOverrides,
      };
    });
}

/** The first problem that stops a save, or `undefined` when the drafts can be saved. */
export function validateDrafts(drafts: readonly LevelDraft[]): string | undefined {
  if (drafts.length === 0) return "Keep at least one level.";
  const blankLabel = drafts.find((d) => d.label.trim().length === 0);
  if (blankLabel) return "Every level needs a name.";
  const blankDescription = drafts.find((d) => d.description.trim().length === 0);
  if (blankDescription) return `Describe when to use "${blankDescription.label.trim()}"; the router reads it.`;
  return undefined;
}

/** The `PUT /api/orgs/:id/run-levels` body: order follows the rows, and the model map is sent in full. */
export function toSaveInput(
  drafts: readonly LevelDraft[],
  replacementKeys?: Readonly<Record<string, string>>,
): { input: SaveRunLevelsInput; keys: string[] } {
  const taken = new Set(drafts.flatMap((d) => (d.key ? [d.key] : [])));
  const keys = drafts.map((d) => {
    if (d.key) return d.key;
    const key = levelKeyFromLabel(d.label, taken);
    taken.add(key);
    return key;
  });
  const models: SaveRunLevelsInput["models"][number][] = [];
  drafts.forEach((d, index) => {
    const levelKey = keys[index] ?? "";
    if (d.selection) models.push({ levelKey, hostId: null, selection: d.selection });
    for (const [hostId, selection] of Object.entries(d.hostOverrides)) {
      models.push({ levelKey, hostId, selection });
    }
  });
  return {
    keys,
    input: {
      levels: drafts.map((d, index) => ({
        key: keys[index] ?? "",
        label: d.label.trim(),
        description: d.description.trim(),
        order: index,
      })),
      models,
      ...(replacementKeys && Object.keys(replacementKeys).length > 0 ? { replacementKeys } : {}),
    },
  };
}

/** Saved keys no longer in the drafts. */
export function removedKeys(savedKeys: readonly string[], drafts: readonly LevelDraft[]): string[] {
  const kept = new Set(drafts.flatMap((d) => (d.key ? [d.key] : [])));
  return savedKeys.filter((key) => !kept.has(key));
}
