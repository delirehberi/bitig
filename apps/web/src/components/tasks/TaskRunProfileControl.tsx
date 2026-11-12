import { useState } from "react";
import { Save, Sparkles, X } from "lucide-react";
import type { RunLevel, T3ModelCapability, T3ModelSelection } from "@bitig/core";
import {
  clearTaskRunProfile,
  saveTaskRunProfile,
  suggestTaskRunProfile,
  type StoredRunProfile,
  type TaskRunProfileResponse,
} from "../../services/run-orchestration";
import { T3ModelPicker } from "./T3ModelPicker";
import { levelLabel } from "./run-profile-labels";

interface TaskRunProfileControlProps {
  readonly taskId: string;
  readonly levels: readonly RunLevel[];
  readonly capabilities: readonly T3ModelCapability[];
  readonly profile: StoredRunProfile | null;
  /** Shows the Suggest button; false when the organisation has no AI router configured. */
  readonly routerEnabled: boolean;
  readonly disabled?: boolean | undefined;
  readonly onChange: (response: TaskRunProfileResponse) => void;
}

const NO_LEVEL = "";

interface Draft {
  readonly level: string;
  readonly selection: T3ModelSelection | null;
  readonly touchesText: string;
  readonly parallelSafe: boolean;
}

function draftFrom(profile: StoredRunProfile | null): Draft {
  return {
    level: profile?.level ?? NO_LEVEL,
    selection: profile?.selection ?? null,
    touchesText: (profile?.touches ?? []).join("\n"),
    parallelSafe: profile?.parallelSafe ?? false,
  };
}

/** One path glob per line; blank lines are dropped and duplicates collapse on the server. */
function parseTouches(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Run profile of a task in its T3 section (#BIT-188): the level from the organisation's list, an
 * explicit model override, the paths it touches and whether it may run beside siblings. Saving records
 * the profile as set by you, which an agent or the router never overwrites.
 */
export function TaskRunProfileControl({
  taskId,
  levels,
  capabilities,
  profile,
  routerEnabled,
  disabled = false,
  onChange,
}: TaskRunProfileControlProps) {
  const [draft, setDraft] = useState<Draft>(() => draftFrom(profile));
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A save or suggestion changes the stored profile: restart the draft from it (state derived from props).
  const [draftSource, setDraftSource] = useState(profile);
  if (draftSource !== profile) {
    setDraftSource(profile);
    setDraft(draftFrom(profile));
  }

  const levelIdPrefix = `run-profile-${taskId}`;
  const isLocked = disabled || isBusy;

  async function run(action: () => Promise<void>, failure: string) {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setIsBusy(false);
    }
  }

  function handleSave() {
    void run(async () => {
      const levelChanged = (profile?.level ?? NO_LEVEL) !== draft.level;
      const response = await saveTaskRunProfile(taskId, {
        level: draft.level === NO_LEVEL ? null : draft.level,
        selection: draft.selection,
        touches: parseTouches(draft.touchesText),
        parallelSafe: draft.parallelSafe,
        ...(levelChanged ? { effort: null, reason: null, confidence: null } : {}),
      });
      onChange(response);
      setNotice("Run profile saved.");
    }, "Could not save the run profile.");
  }

  function handleClear() {
    void run(async () => {
      const response = await clearTaskRunProfile(taskId);
      onChange(response);
      setNotice("Run profile cleared.");
    }, "Could not clear the run profile.");
  }

  function handleSuggest() {
    void run(async () => {
      const response = await suggestTaskRunProfile(taskId);
      onChange(response);
      if (response.stored && response.profile?.level) {
        setNotice(`Router suggested level ${levelLabel(levels, response.profile.level)}.`);
      } else if (response.suggestion) {
        setNotice(
          `Router suggested level ${levelLabel(levels, response.suggestion.level)}, but the profile set by you or an agent is kept.`,
        );
      } else {
        setNotice("The router had no confident suggestion; the project default level applies.");
      }
    }, "Could not get a suggestion from the AI router.");
  }

  return (
    <fieldset
      data-testid="task-run-profile"
      className="m-0 flex flex-col gap-2 rounded-md border border-rule bg-paper p-2.5 text-xs text-ink-2"
    >
      <legend className="px-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">Run profile</legend>

      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${levelIdPrefix}-level`}>Level</label>
        <select
          id={`${levelIdPrefix}-level`}
          value={draft.level}
          disabled={isLocked}
          onChange={(e) => {
            setDraft((prev) => ({ ...prev, level: e.target.value }));
          }}
          className="rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
        >
          <option value={NO_LEVEL}>No level (project default)</option>
          {levels.map((level) => (
            <option key={level.key} value={level.key} title={level.description}>
              {level.label}
            </option>
          ))}
          {draft.level !== NO_LEVEL && !levels.some((level) => level.key === draft.level) && (
            <option value={draft.level}>{draft.level} (removed)</option>
          )}
        </select>
        {profile?.reason && (
          <span className="text-2xs text-ink-3" title={profile.reason}>
            Why: {profile.reason}
          </span>
        )}
      </div>

      {capabilities.length > 0 && (
        <T3ModelPicker
          idSuffix={`${levelIdPrefix}-override`}
          label="Model override"
          keepLabel="No override (use the level's model)"
          capabilities={capabilities}
          value={draft.selection}
          onChange={(selection) => {
            setDraft((prev) => ({ ...prev, selection }));
          }}
          disabled={isLocked}
        />
      )}

      <label htmlFor={`${levelIdPrefix}-touches`} className="flex flex-col gap-1">
        <span>Touched paths (one glob per line)</span>
        <textarea
          id={`${levelIdPrefix}-touches`}
          rows={2}
          value={draft.touchesText}
          disabled={isLocked}
          placeholder="apps/web/src/**"
          onChange={(e) => {
            setDraft((prev) => ({ ...prev, touchesText: e.target.value }));
          }}
          className="rounded-md border border-rule bg-paper px-2 py-1 font-mono text-xs text-ink disabled:opacity-50"
        />
      </label>

      <label className="inline-flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={draft.parallelSafe}
          disabled={isLocked}
          onChange={(e) => {
            setDraft((prev) => ({ ...prev, parallelSafe: e.target.checked }));
          }}
        />
        <span>Parallel-safe: may run beside sibling tasks whose paths do not overlap</span>
      </label>

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

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={handleSave}
          disabled={isLocked}
          className="inline-flex items-center gap-1 rounded-md border border-accent/40 bg-paper px-2.5 py-1 text-2xs font-semibold text-accent-ink hover:bg-accent-soft disabled:opacity-50"
        >
          <Save size={11} aria-hidden="true" />
          Save run profile
        </button>
        {routerEnabled && (
          <button
            type="button"
            onClick={handleSuggest}
            disabled={isLocked}
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2.5 py-1 text-2xs font-semibold text-ink-2 hover:bg-paper-3 disabled:opacity-50"
          >
            <Sparkles size={11} aria-hidden="true" />
            Suggest
          </button>
        )}
        {profile && (
          <button
            type="button"
            onClick={handleClear}
            disabled={isLocked}
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2.5 py-1 text-2xs text-ink-3 hover:bg-paper-3 disabled:opacity-50"
          >
            <X size={11} aria-hidden="true" />
            Clear
          </button>
        )}
      </div>
    </fieldset>
  );
}
