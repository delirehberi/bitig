import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Gauge, Plus, Save, Trash2 } from "lucide-react";
import type { T3HostConnectionStatus, T3ModelCapability, T3ModelSelection } from "@bitig/core";
import {
  fetchRunLevels,
  RunOrchestrationApiError,
  saveRunLevels,
  type RunLevelsResponse,
} from "../../services/run-orchestration";
import { fetchT3Capabilities, fetchT3Hosts } from "../../services/t3";
import { T3ModelPicker } from "../tasks/T3ModelPicker";
import { draftsFromServer, removedKeys, toSaveInput, validateDrafts, type LevelDraft } from "./run-levels-draft";

interface TaskLevelsEditorProps {
  readonly orgSlug: string;
  /** Model lists come from the active organisation's T3 hosts; another organisation shows none. */
  readonly isActiveOrg: boolean;
  readonly onSaved?: ((response: RunLevelsResponse) => void) | undefined;
}

interface HostModels {
  readonly host: T3HostConnectionStatus;
  readonly capabilities: T3ModelCapability[];
}

/** Asked after the server refuses to remove levels that tasks or projects still use. */
interface ReplacementPrompt {
  readonly removed: string[];
  readonly choices: Record<string, string>;
}

const NEW_LEVEL_LABEL = "New level";

function capabilityKey(cap: { readonly providerInstanceId: string; readonly model: string }): string {
  return `${cap.providerInstanceId}::${cap.model}`;
}

function hostName(host: T3HostConnectionStatus): string {
  return host.label ?? host.id;
}

function nextRowId(): string {
  return `new:${crypto.randomUUID()}`;
}

/**
 * Organisation Task levels editor (#BIT-188, owners only): add, rename, reorder and remove levels, write
 * each level's "when to use" description (what the AI router reads), and map each level to a provider,
 * model and options for every host, with optional per-host overrides.
 */
export function TaskLevelsEditor({ orgSlug, isActiveOrg, onSaved }: TaskLevelsEditorProps) {
  const [drafts, setDrafts] = useState<LevelDraft[] | null>(null);
  const [savedKeys, setSavedKeys] = useState<string[]>([]);
  const [hostModels, setHostModels] = useState<HostModels[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<ReplacementPrompt | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchRunLevels(orgSlug, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setDrafts(draftsFromServer(res.levels, res.models));
        setSavedKeys(res.levels.map((l) => l.key));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load task levels.");
      });
    return () => {
      controller.abort();
    };
  }, [orgSlug]);

  useEffect(() => {
    if (!isActiveOrg) return;
    const controller = new AbortController();
    fetchT3Hosts(controller.signal)
      .then(async (hosts) => {
        const usable = hosts.filter((h) => !h.expired);
        const lists = await Promise.all(
          usable.map(async (host) => ({
            host,
            capabilities: await fetchT3Capabilities(controller.signal, { hostId: host.id }).catch(
              (err: unknown): T3ModelCapability[] => {
                console.warn("Could not load models for T3 host", host.id, err);
                return [];
              },
            ),
          })),
        );
        if (!controller.signal.aborted) setHostModels(lists);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // Levels can still be edited; only the model pickers stay hidden.
        console.warn("Could not load T3 hosts", err);
      });
    return () => {
      controller.abort();
    };
  }, [isActiveOrg]);

  // The default model applies on every host, so offer each model any host has.
  const allCapabilities = useMemo(() => {
    const byKey = new Map<string, T3ModelCapability>();
    for (const { capabilities } of hostModels) {
      for (const cap of capabilities) {
        if (!byKey.has(capabilityKey(cap))) byKey.set(capabilityKey(cap), cap);
      }
    }
    return [...byKey.values()];
  }, [hostModels]);

  if (!drafts) {
    return (
      <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2 className="m-0 mb-2 font-display text-base font-bold text-ink">Task levels</h2>
        {error ? (
          <p role="alert" className="m-0 text-xs text-danger">
            {error}
          </p>
        ) : (
          <p className="m-0 text-xs text-ink-3">Loading task levels…</p>
        )}
      </section>
    );
  }

  const currentDrafts = drafts;
  const validationError = validateDrafts(currentDrafts);

  function update(rowId: string, patch: Partial<LevelDraft>) {
    setDrafts((prev) => (prev ? prev.map((d) => (d.rowId === rowId ? { ...d, ...patch } : d)) : prev));
    setNotice(null);
  }

  function move(index: number, direction: -1 | 1) {
    setDrafts((prev) => {
      if (!prev) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (row) next.splice(target, 0, row);
      return next;
    });
    setNotice(null);
  }

  function remove(rowId: string) {
    setDrafts((prev) => (prev ? prev.filter((d) => d.rowId !== rowId) : prev));
    setNotice(null);
  }

  function add() {
    setDrafts((prev) => [
      ...(prev ?? []),
      { rowId: nextRowId(), key: undefined, label: NEW_LEVEL_LABEL, description: "", selection: null, hostOverrides: {} },
    ]);
    setNotice(null);
  }

  function setHostOverride(draft: LevelDraft, hostId: string, selection: T3ModelSelection | null) {
    const others = Object.entries(draft.hostOverrides).filter(([id]) => id !== hostId);
    update(draft.rowId, {
      hostOverrides: Object.fromEntries(selection ? [...others, [hostId, selection]] : others),
    });
  }

  async function save(replacementKeys?: Record<string, string>) {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { input } = toSaveInput(currentDrafts, replacementKeys);
      const saved = await saveRunLevels(orgSlug, input);
      setDrafts(draftsFromServer(saved.levels, saved.models));
      setSavedKeys(saved.levels.map((l) => l.key));
      setReplacement(null);
      setNotice("Task levels saved.");
      onSaved?.(saved);
    } catch (err) {
      const removed = removedKeys(savedKeys, currentDrafts);
      if (err instanceof RunOrchestrationApiError && err.needsReplacementLevel && removed.length > 0) {
        const { keys } = toSaveInput(currentDrafts);
        const fallback = keys[0] ?? "";
        setReplacement({
          removed,
          choices: Object.fromEntries(removed.map((key) => [key, replacementKeys?.[key] ?? fallback])),
        });
      } else {
        setError(err instanceof Error ? err.message : "Could not save task levels.");
      }
    } finally {
      setIsSaving(false);
    }
  }

  const keptChoices = toSaveInput(currentDrafts).keys.map((key, index) => {
    const label = currentDrafts[index]?.label.trim();
    return { key, label: label && label.length > 0 ? label : key };
  });

  return (
    <section
      aria-labelledby="org-task-levels-heading"
      className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <h2 id="org-task-levels-heading" className="m-0 mb-1 flex items-center gap-2 font-display text-base font-bold text-ink">
        <Gauge size={16} aria-hidden="true" className="text-accent-ink" />
        Task levels
      </h2>
      <p className="m-0 mb-4 text-xs text-ink-3">
        Ordered from cheapest to strongest. The AI router reads each &quot;when to use&quot; description to pick a
        level, and &quot;Retry on the next level up&quot; moves one row down.
        {!isActiveOrg && " Switch to this organisation to pick models from its T3 hosts."}
      </p>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="m-0 mb-3 text-xs text-ink-2">
          {notice}
        </p>
      )}

      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {currentDrafts.map((draft, index) => {
          const idBase = `task-level-${draft.rowId.replace(/[^a-z0-9]/gi, "-")}`;
          return (
            <li key={draft.rowId} data-testid="task-level-row" className="rounded-md border border-rule bg-paper-2 p-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <label htmlFor={`${idBase}-label`} className="block text-2xs font-semibold text-ink-2">
                    Level name
                  </label>
                  <input
                    id={`${idBase}-label`}
                    type="text"
                    value={draft.label}
                    disabled={isSaving}
                    maxLength={120}
                    onChange={(e) => {
                      update(draft.rowId, { label: e.target.value });
                    }}
                    className="mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1 text-sm text-ink"
                  />
                </div>
                {draft.key && <code className="pb-1.5 font-mono text-2xs text-ink-3">{draft.key}</code>}
                <div className="flex items-center gap-1 pb-0.5">
                  <button
                    type="button"
                    aria-label={`Move ${draft.label} up`}
                    disabled={isSaving || index === 0}
                    onClick={() => {
                      move(index, -1);
                    }}
                    className="rounded-md p-1 text-ink-3 hover:bg-paper-3 hover:text-ink disabled:opacity-40"
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${draft.label} down`}
                    disabled={isSaving || index === currentDrafts.length - 1}
                    onClick={() => {
                      move(index, 1);
                    }}
                    className="rounded-md p-1 text-ink-3 hover:bg-paper-3 hover:text-ink disabled:opacity-40"
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${draft.label}`}
                    disabled={isSaving || currentDrafts.length === 1}
                    onClick={() => {
                      remove(draft.rowId);
                    }}
                    className="rounded-md p-1 text-ink-3 hover:bg-danger-soft hover:text-danger disabled:opacity-40"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <label htmlFor={`${idBase}-description`} className="mt-2 block text-2xs font-semibold text-ink-2">
                When to use
              </label>
              <textarea
                id={`${idBase}-description`}
                rows={2}
                value={draft.description}
                disabled={isSaving}
                maxLength={1000}
                onChange={(e) => {
                  update(draft.rowId, { description: e.target.value });
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink"
              />

              {allCapabilities.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  <T3ModelPicker
                    idSuffix={`${idBase}-default`}
                    label="Model"
                    keepLabel="T3 default model"
                    capabilities={allCapabilities}
                    value={draft.selection}
                    onChange={(selection) => {
                      update(draft.rowId, { selection });
                    }}
                    disabled={isSaving}
                  />
                  {hostModels.length > 1 &&
                    hostModels.map(({ host, capabilities }) => (
                      <T3ModelPicker
                        key={host.id}
                        idSuffix={`${idBase}-host-${host.id}`}
                        label={`On ${hostName(host)}`}
                        keepLabel="Same as above"
                        capabilities={capabilities}
                        value={draft.hostOverrides[host.id] ?? null}
                        onChange={(selection) => {
                          setHostOverride(draft, host.id, selection);
                        }}
                        disabled={isSaving}
                      />
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {replacement && (
        <div
          role="group"
          aria-label="Choose replacement levels"
          className="mt-4 flex flex-col gap-2 rounded-md border border-accent/30 bg-accent-soft p-3 text-xs text-accent-ink"
        >
          <p className="m-0 font-semibold">Some removed levels are still used by tasks or projects. Which level replaces each?</p>
          {replacement.removed.map((key) => (
            <label key={key} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{key}</span>
              <span>→</span>
              <select
                aria-label={`Replacement for ${key}`}
                value={replacement.choices[key] ?? ""}
                onChange={(e) => {
                  setReplacement({ ...replacement, choices: { ...replacement.choices, [key]: e.target.value } });
                }}
                className="rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink"
              >
                {keptChoices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isSaving}
              onClick={() => {
                void save(replacement.choices);
              }}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper disabled:opacity-50"
            >
              Replace and save
            </button>
            <button
              type="button"
              disabled={isSaving}
              onClick={() => {
                setReplacement(null);
              }}
              className="rounded-md border border-rule bg-paper px-3 py-1.5 text-xs text-ink-2"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {validationError && (
        <p className="m-0 mt-3 text-xs text-danger">{validationError}</p>
      )}

      <div className="mt-4 flex flex-wrap justify-between gap-2">
        <button
          type="button"
          onClick={add}
          disabled={isSaving}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-3 disabled:opacity-50"
        >
          <Plus size={14} aria-hidden="true" />
          Add level
        </button>
        <button
          type="button"
          onClick={() => {
            void save();
          }}
          disabled={isSaving || validationError !== undefined || replacement !== null}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
        >
          <Save size={14} aria-hidden="true" />
          {isSaving ? "Saving…" : "Save task levels"}
        </button>
      </div>
    </section>
  );
}
