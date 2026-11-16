import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, GitBranch, RefreshCw } from "lucide-react";
import type {
  ImportHierarchyResponse,
  LegacyHierarchyCandidate,
  LegacyHierarchyConflictReason,
  LegacyHierarchyInventoryResponse,
  LegacyHierarchyProvenance,
  OrganisationRole,
  Project,
} from "@bitig/core";
import { useOptionalAuth } from "../../auth/useAuth";
import { dispatchRealtimeEvent } from "../../hooks/useRealtime";
import { fetchLegacyHierarchyInventory, importLegacyHierarchy } from "../../services/hierarchy";

interface LegacyHierarchyPanelProps {
  readonly projects: readonly Project[];
  readonly role?: OrganisationRole | undefined;
}

const PROVENANCE_LABELS: Record<LegacyHierarchyProvenance, string> = {
  run_child: "Run child",
  run_parent_task: "Run parent",
  run_waiting_for: "Run waiting",
  checklist_mention: "Checklist mention",
  description_mention: "Description mention",
  reverse_dependency: "Reverse dependency",
};

const CONFLICT_LABELS: Record<LegacyHierarchyConflictReason, string> = {
  multiple_parents: "Multiple parents",
  cross_project: "Cross-project",
  cycle: "Cycle",
  parent_dependency: "Depends on parent",
  already_parented: "Already parented",
};

function edgeKey(candidate: Pick<LegacyHierarchyCandidate, "proposedParentId" | "childTaskId">): string {
  return `${candidate.proposedParentId}::${candidate.childTaskId}`;
}

/**
 * Read-only inventory and human-confirmed import panel for legacy inferred parent-child links (#BIT-195).
 */
export function LegacyHierarchyPanel({ projects, role }: LegacyHierarchyPanelProps) {
  const auth = useOptionalAuth();
  const effectiveRole: OrganisationRole = role ?? auth?.currentRole ?? "owner";
  const canImport = effectiveRole !== "viewer";

  const [projectId, setProjectId] = useState<string>("");
  const [inventory, setInventory] = useState<LegacyHierarchyInventoryResponse | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<ImportHierarchyResponse | null>(null);

  const loadInventory = useCallback(async (filterProjectId: string, signal?: AbortSignal) => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchLegacyHierarchyInventory(filterProjectId || undefined, signal);
      if (signal?.aborted) return;
      setInventory(next);
      setSelectedKeys(new Set());
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Could not load legacy hierarchy inventory.");
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void fetchLegacyHierarchyInventory(projectId || undefined, controller.signal)
      .then((next) => {
        if (!active || controller.signal.aborted) return;
        setInventory(next);
        setSelectedKeys(new Set());
        setError(null);
      })
      .catch((err: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load legacy hierarchy inventory.");
      })
      .finally(() => {
        if (active && !controller.signal.aborted) {
          setIsLoading(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId]);

  const candidates = inventory?.candidates ?? [];
  const importableCandidates = candidates.filter((c) => c.importable);

  function toggleEdge(candidate: LegacyHierarchyCandidate) {
    if (!candidate.importable || !canImport || isSubmitting) return;
    const key = edgeKey(candidate);
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
        return next;
      }
      // At most one parent per child can be imported cleanly in one batch.
      for (const other of candidates) {
        if (other.childTaskId === candidate.childTaskId) {
          next.delete(edgeKey(other));
        }
      }
      next.add(key);
      return next;
    });
  }

  function selectAllClean() {
    if (!canImport || isSubmitting) return;
    const next = new Set<string>();
    const seenChildren = new Set<string>();
    for (const candidate of importableCandidates) {
      if (candidate.conflicts.length > 0) continue;
      if (seenChildren.has(candidate.childTaskId)) continue;
      seenChildren.add(candidate.childTaskId);
      next.add(edgeKey(candidate));
    }
    setSelectedKeys(next);
  }

  async function handleConfirmImport() {
    if (!canImport || selectedKeys.size === 0 || isSubmitting) return;
    const edges = candidates
      .filter((c) => c.importable && selectedKeys.has(edgeKey(c)))
      .map((c) => ({ childTaskId: c.childTaskId, parentTaskId: c.proposedParentId }));
    if (edges.length === 0) return;

    setIsSubmitting(true);
    setError(null);
    setImportResult(null);
    try {
      const result = await importLegacyHierarchy({ edges });
      setImportResult(result);
      if (result.imported.length > 0) {
        dispatchRealtimeEvent({ type: "sync" });
      }
      await loadInventory(projectId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not import selected hierarchy edges.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const activeProjects = projects.filter((p) => !p.archived);

  return (
    <section
      aria-labelledby="legacy-hierarchy-heading"
      className="flex flex-col gap-5 rounded-lg border border-rule bg-paper p-6 shadow-xs"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2
            id="legacy-hierarchy-heading"
            className="m-0 flex items-center gap-2 font-display text-lg font-bold text-ink"
          >
            <GitBranch size={18} aria-hidden="true" className="text-accent-ink" />
            Explicit Task Hierarchy &amp; Legacy Import
          </h2>
          <p className="m-0 text-xs text-ink-2">
            Inspect legacy inferred parent-child candidates from run ancestry, checklist/description mentions, and reverse
            dependencies. Nothing is promoted automatically; select clean edges below and confirm to set{" "}
            <code className="font-mono">parentId</code>.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {inventory && (
            <span
              data-testid="hierarchy-mode-badge"
              className="inline-flex items-center rounded-pill border border-rule bg-paper-2 px-3 py-1 font-mono text-2xs font-semibold text-ink-2"
            >
              Mode: {inventory.hierarchyMode}
            </span>
          )}
          {!canImport && (
            <span className="inline-flex items-center rounded-pill border border-rule bg-paper-2 px-3 py-1 text-xs font-medium text-ink-3">
              Read-only ({effectiveRole})
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
          <span>Project:</span>
          <select
            aria-label="Filter hierarchy inventory by project"
            value={projectId}
            onChange={(e) => {
              setImportResult(null);
              setProjectId(e.target.value);
            }}
            className="rounded-md border border-rule bg-paper px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
          >
            <option value="">All Projects ({activeProjects.length})</option>
            {activeProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          {inventory && (
            <span className="text-xs text-ink-3">
              {String(inventory.alreadyParentedCount)} of {String(inventory.totalTasks)} tasks parented ·{" "}
              {String(candidates.length)} candidate{candidates.length === 1 ? "" : "s"}
            </span>
          )}
          <button
            type="button"
            onClick={() => {
              setImportResult(null);
              void loadInventory(projectId);
            }}
            disabled={isLoading || isSubmitting}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-paper-3 disabled:opacity-50"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
        >
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {importResult && (
        <div
          role="status"
          className="flex flex-col gap-2 rounded-md border border-accent/30 bg-accent-soft px-4 py-3 text-xs text-accent-ink"
        >
          <div className="flex items-center gap-2 font-semibold">
            <CheckCircle2 size={15} aria-hidden="true" />
            <span>
              Imported {String(importResult.imported.length)} explicit parent link
              {importResult.imported.length === 1 ? "" : "s"}
              {importResult.rejected.length > 0 ? `, ${String(importResult.rejected.length)} rejected` : ""}.
            </span>
          </div>
          {importResult.rejected.length > 0 && (
            <ul className="m-0 list-disc pl-5 text-danger">
              {importResult.rejected.map((item) => (
                <li key={`${item.parentTaskId}::${item.childTaskId}`}>
                  <code className="font-mono">{item.childTaskId}</code> →{" "}
                  <code className="font-mono">{item.parentTaskId}</code>: {item.reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {isLoading ? (
        <p role="status" className="m-0 text-sm text-ink-3">
          Scanning legacy hierarchy candidates…
        </p>
      ) : candidates.length === 0 ? (
        <p className="m-0 rounded-md border border-rule bg-paper-2 px-4 py-3 text-xs text-ink-2">
          No legacy inferred parent-child candidates found.
        </p>
      ) : (
        <>
          <div className="divide-y divide-rule rounded-md border border-rule">
            {candidates.map((candidate) => {
              const key = edgeKey(candidate);
              const checked = selectedKeys.has(key);
              const checkboxId = `hierarchy-candidate-${key}`;
              return (
                <div
                  key={key}
                  data-testid={`hierarchy-candidate-${candidate.childCode ?? candidate.childTaskId}-${candidate.proposedParentCode ?? candidate.proposedParentId}`}
                  className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      checked={checked}
                      disabled={!candidate.importable || !canImport || isSubmitting}
                      onChange={() => {
                        toggleEdge(candidate);
                      }}
                      aria-label={`Select ${candidate.childCode ?? candidate.childTaskId} under ${candidate.proposedParentCode ?? candidate.proposedParentId}`}
                      className="mt-0.5 size-4 rounded border-rule accent-accent disabled:opacity-40"
                    />
                    <div className="flex min-w-0 flex-col gap-1">
                      <label htmlFor={checkboxId} className="flex flex-wrap items-baseline gap-1.5 text-sm text-ink">
                        <span className="font-mono text-xs font-semibold text-ink-2">
                          {candidate.childCode ?? candidate.childTaskId}
                        </span>
                        <span className="font-semibold">{candidate.childTitle}</span>
                        <span className="text-xs text-ink-3">→ Parent:</span>
                        <span className="font-mono text-xs font-semibold text-accent-ink">
                          {candidate.proposedParentCode ?? candidate.proposedParentId}
                        </span>
                        <span className="text-xs text-ink-2">{candidate.proposedParentTitle}</span>
                      </label>

                      <div className="flex flex-wrap items-center gap-1.5">
                        {candidate.provenance.map((source) => (
                          <span
                            key={source}
                            className="rounded-pill border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2"
                          >
                            {PROVENANCE_LABELS[source]}
                          </span>
                        ))}
                        {candidate.conflicts.map((conflict) => {
                          const hard =
                            conflict === "cross_project" ||
                            conflict === "cycle" ||
                            conflict === "already_parented";
                          return (
                            <span
                              key={conflict}
                              className={`rounded-pill border px-2 py-0.5 text-2xs font-semibold ${
                                hard
                                  ? "border-danger/30 bg-danger-soft text-danger"
                                  : "border-accent/30 bg-accent-soft text-accent-ink"
                              }`}
                            >
                              {CONFLICT_LABELS[conflict]}
                              {conflict === "already_parented" && candidate.currentParentCode
                                ? ` (${candidate.currentParentCode})`
                                : ""}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {canImport && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-4">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={selectAllClean}
                  disabled={isSubmitting || importableCandidates.every((c) => c.conflicts.length > 0)}
                  className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-3 disabled:opacity-50"
                >
                  Select clean candidates
                </button>
                {selectedKeys.size > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedKeys(new Set());
                    }}
                    disabled={isSubmitting}
                    className="rounded-md border border-rule bg-paper px-3 py-1.5 text-xs font-medium text-ink-3 hover:text-ink disabled:opacity-50"
                  >
                    Clear selection
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  void handleConfirmImport();
                }}
                disabled={isSubmitting || selectedKeys.size === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {isSubmitting
                  ? "Importing…"
                  : `Import selected (${String(selectedKeys.size)})`}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
