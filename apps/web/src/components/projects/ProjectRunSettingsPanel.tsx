import { useEffect, useState } from "react";
import { Gauge, Save } from "lucide-react";
import {
  DEFAULT_MAX_PARALLEL_CHILDREN,
  MAX_PARALLEL_CHILDREN_MAX,
  MAX_PARALLEL_CHILDREN_MIN,
  type ProjectRunSettings,
  type RunLevel,
} from "@bitig/core";
import { fetchProjectRunSettings, saveProjectRunSettings } from "../../services/run-orchestration";

interface ProjectRunSettingsPanelProps {
  readonly projectId: string;
  /** The organisation's task levels, for the default level select. */
  readonly levels: readonly RunLevel[];
}

const NO_DEFAULT_LEVEL = "";

interface Draft {
  readonly defaultRunLevel: string;
  readonly serialPathsText: string;
  readonly maxParallelChildren: string;
}

function draftFrom(settings: ProjectRunSettings): Draft {
  return {
    defaultRunLevel: settings.defaultRunLevel ?? NO_DEFAULT_LEVEL,
    serialPathsText: settings.serialPaths.join("\n"),
    maxParallelChildren: String(settings.maxParallelChildren),
  };
}

function parseLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parses the max parallel children field; `undefined` when it is not a whole number in range. */
function parseMaxParallelChildren(raw: string): number | undefined {
  const value = Number(raw.trim());
  if (!Number.isInteger(value)) return undefined;
  if (value < MAX_PARALLEL_CHILDREN_MIN || value > MAX_PARALLEL_CHILDREN_MAX) return undefined;
  return value;
}

/**
 * Project run settings (#BIT-188): the default task level for tasks without one, paths whose tasks never
 * run in parallel, and how many umbrella children may run at once. Hidden when the settings cannot be
 * loaded (e.g. local mode without the worker).
 */
export function ProjectRunSettingsPanel({ projectId, levels }: ProjectRunSettingsPanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchProjectRunSettings(projectId, controller.signal)
      .then((settings) => {
        if (controller.signal.aborted) return;
        setDraft(draftFrom(settings));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Could not load project run settings", err);
      });
    return () => {
      controller.abort();
    };
  }, [projectId]);

  if (!draft) return null;

  const maxParallel = parseMaxParallelChildren(draft.maxParallelChildren);
  const fieldId = `project-run-settings-${projectId}`;

  async function handleSave() {
    if (!draft || maxParallel === undefined) return;
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await saveProjectRunSettings(projectId, {
        defaultRunLevel: draft.defaultRunLevel === NO_DEFAULT_LEVEL ? null : draft.defaultRunLevel,
        serialPaths: parseLines(draft.serialPathsText),
        maxParallelChildren: maxParallel,
      });
      setDraft(draftFrom(saved));
      setNotice("Run settings saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save project run settings.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      aria-labelledby={`${fieldId}-heading`}
      data-testid="project-run-settings"
      className="mb-5 flex flex-col gap-2.5 rounded-md border border-rule bg-paper-2 p-3.5 text-xs text-ink-2"
    >
      <h3
        id={`${fieldId}-heading`}
        className="m-0 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3"
      >
        <Gauge size={12} aria-hidden="true" />
        Run settings
      </h3>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${fieldId}-level`}>Default level</label>
        <select
          id={`${fieldId}-level`}
          value={draft.defaultRunLevel}
          disabled={isSaving}
          onChange={(e) => {
            setDraft({ ...draft, defaultRunLevel: e.target.value });
          }}
          className="rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        >
          <option value={NO_DEFAULT_LEVEL}>None (T3 default model)</option>
          {levels.map((level) => (
            <option key={level.key} value={level.key} title={level.description}>
              {level.label}
            </option>
          ))}
          {draft.defaultRunLevel !== NO_DEFAULT_LEVEL &&
            !levels.some((level) => level.key === draft.defaultRunLevel) && (
              <option value={draft.defaultRunLevel}>{draft.defaultRunLevel}</option>
            )}
        </select>
      </div>

      <label htmlFor={`${fieldId}-serial`} className="flex flex-col gap-1">
        <span>Serial paths (one glob per line): tasks touching these never run in parallel</span>
        <textarea
          id={`${fieldId}-serial`}
          rows={2}
          value={draft.serialPathsText}
          disabled={isSaving}
          placeholder="packages/storage-d1/migrations/**"
          onChange={(e) => {
            setDraft({ ...draft, serialPathsText: e.target.value });
          }}
          className="rounded-md border border-rule bg-paper px-2 py-1 font-mono text-xs text-ink disabled:opacity-50"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${fieldId}-max`}>Max parallel children</label>
        <input
          id={`${fieldId}-max`}
          type="number"
          min={MAX_PARALLEL_CHILDREN_MIN}
          max={MAX_PARALLEL_CHILDREN_MAX}
          step={1}
          value={draft.maxParallelChildren}
          disabled={isSaving}
          placeholder={String(DEFAULT_MAX_PARALLEL_CHILDREN)}
          onChange={(e) => {
            setDraft({ ...draft, maxParallelChildren: e.target.value });
          }}
          aria-invalid={maxParallel === undefined}
          className="w-20 rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        />
        {maxParallel === undefined && (
          <span className="text-2xs text-danger">
            Use a whole number from {MAX_PARALLEL_CHILDREN_MIN} to {MAX_PARALLEL_CHILDREN_MAX}.
          </span>
        )}
      </div>

      {error && (
        <p role="alert" className="m-0 text-2xs text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="m-0 text-2xs text-ink-3">
          {notice}
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => {
            void handleSave();
          }}
          disabled={isSaving || maxParallel === undefined}
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-paper px-2.5 py-1 text-2xs font-semibold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
        >
          <Save size={11} aria-hidden="true" />
          Save run settings
        </button>
      </div>
    </section>
  );
}
