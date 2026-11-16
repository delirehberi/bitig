import { AlertTriangle, X } from "lucide-react";
import type { Project, RunLevel, T3ModelCapability, T3ModelSelection } from "@bitig/core";
import { Link } from "../../routing/Link";
import { hrefFor } from "../../routing/router";
import type { WorkQueuePlanRow, WorkQueuePlanView } from "../../services/work-queue";
import { T3ModelPicker } from "../tasks/T3ModelPicker";
import { levelLabel } from "../tasks/run-profile-labels";
import {
  approvableRows,
  describeLaneWaves,
  describeRowStatus,
  effortValues,
  findCapability,
  planWarnings,
  suggestionLabel,
  unknownKeyMessage,
  type RowOverrideDraft,
} from "./work-queue-model";

interface WorkQueuePlanPreviewProps {
  readonly plan: WorkQueuePlanView;
  readonly projects: readonly Project[];
  readonly levels: readonly RunLevel[];
  readonly capabilities: readonly T3ModelCapability[];
  readonly approvals: ReadonlySet<string>;
  readonly drafts: ReadonlyMap<string, RowOverrideDraft>;
  readonly queueCount: number;
  readonly busy: boolean;
  readonly onRemoveCode: (code: string) => void;
  readonly onPickSuggestion: (unknownKey: string, suggestion: string) => void;
  readonly onReplaceCode: (from: string, to: string) => void;
  readonly onAddCodes: (codes: readonly string[]) => void;
  readonly onToggleApproval: (code: string, approved: boolean) => void;
  readonly onToggleApproveAll: (approved: boolean) => void;
  readonly onChangeDraft: (code: string, draft: RowOverrideDraft) => void;
  readonly onConfirm: () => void;
}

const KEEP_VALUE = "";
const SOURCE_TEXT = { manual: "set by you", agent: "set by agent", router: "set by router" } as const;

const SECONDARY_BUTTON =
  "inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-1 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-50 focus-visible:outline-focus";
const SELECT_CLASS =
  "rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50 focus-visible:outline-focus";

function statusTone(row: WorkQueuePlanRow): string {
  if (row.queueable) return "bg-ok-soft text-ok";
  if (row.classification === "needs_approval") return "bg-accent-soft text-accent-ink";
  if (row.classification === "not_found" || row.classification === "dependency_cycle") {
    return "bg-danger-soft text-danger";
  }
  return "bg-paper-3 text-ink-2";
}

/** The draft without one field, so clearing a selector falls back to the plan's value. */
function withoutField(draft: RowOverrideDraft | undefined, field: keyof RowOverrideDraft): RowOverrideDraft {
  const { level, effort, selection } = draft ?? {};
  return {
    ...(level !== undefined && field !== "level" ? { level } : {}),
    ...(effort !== undefined && field !== "effort" ? { effort } : {}),
    ...(selection !== undefined && field !== "selection" ? { selection } : {}),
  };
}

interface RunControlsProps {
  readonly row: WorkQueuePlanRow;
  readonly levels: readonly RunLevel[];
  readonly capabilities: readonly T3ModelCapability[];
  readonly draft: RowOverrideDraft | undefined;
  readonly busy: boolean;
  readonly onChange: (draft: RowOverrideDraft) => void;
}

/** Level, model and effort for one row. Edits are sent on confirm and saved as a `manual` profile. */
function RunControls({ row, levels, capabilities, draft, busy, onChange }: RunControlsProps) {
  const run = row.run;
  if (!run) return null;
  const level = draft?.level ?? run.level ?? KEEP_VALUE;
  // A new level brings its own model; until then the plan's resolved model applies.
  const levelSelection = draft?.level !== undefined ? levels.find((l) => l.key === draft.level)?.selection : undefined;
  const effectiveProvider = draft?.level !== undefined ? levelSelection?.providerInstanceId : run.providerInstanceId;
  const effectiveModel = draft?.level !== undefined ? levelSelection?.model : run.model;
  const efforts = effortValues(findCapability(capabilities, effectiveProvider, effectiveModel));
  const effort = draft?.effort ?? (draft?.level !== undefined ? KEEP_VALUE : (run.effort ?? KEEP_VALUE));
  const idSuffix = `wq-${row.code}`;
  const modelText = effectiveModel ?? "T3 default model";
  const sourceText = run.source === "default" ? (run.note ?? "default") : SOURCE_TEXT[run.source];

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
      {levels.length > 0 ? (
        <>
          <label htmlFor={`wq-level-${row.code}`} className="sr-only">
            Level for {row.code}
          </label>
          <select
            id={`wq-level-${row.code}`}
            value={level}
            disabled={busy}
            onChange={(e) => {
              // A new level replaces the model and effort it implied, as on the server.
              onChange({ level: e.target.value });
            }}
            className={SELECT_CLASS}
          >
            {level === KEEP_VALUE && <option value={KEEP_VALUE}>No level</option>}
            {levels.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </>
      ) : (
        run.level && <span className="font-semibold text-ink">{levelLabel(levels, run.level)}</span>
      )}
      {capabilities.length > 0 && (
        <T3ModelPicker
          idSuffix={idSuffix}
          label={`Model for ${row.code}`}
          keepLabel={`Level model (${modelText})`}
          capabilities={capabilities}
          value={draft?.selection ?? null}
          disabled={busy}
          onChange={(selection: T3ModelSelection | null) => {
            const rest = withoutField(draft, "selection");
            onChange(selection ? { ...rest, selection } : rest);
          }}
        />
      )}
      {capabilities.length === 0 && <span>{modelText}</span>}
      {draft?.selection === undefined && efforts.length > 0 && (
        <>
          <label htmlFor={`wq-effort-${row.code}`} className="sr-only">
            Effort for {row.code}
          </label>
          <select
            id={`wq-effort-${row.code}`}
            value={effort}
            disabled={busy}
            onChange={(e) => {
              const rest = withoutField(draft, "effort");
              onChange(e.target.value === KEEP_VALUE ? rest : { ...rest, effort: e.target.value });
            }}
            className={SELECT_CLASS}
          >
            <option value={KEEP_VALUE}>Level effort</option>
            {efforts.map((value) => (
              <option key={value} value={value}>
                effort: {value}
              </option>
            ))}
          </select>
        </>
      )}
      <span className="text-2xs text-ink-3">{sourceText}</span>
    </div>
  );
}

/** The plan for a prompt: chips, one row per task, lanes with waves and the single confirm button. */
export function WorkQueuePlanPreview({
  plan,
  projects,
  levels,
  capabilities,
  approvals,
  drafts,
  queueCount,
  busy,
  onRemoveCode,
  onPickSuggestion,
  onReplaceCode,
  onAddCodes,
  onToggleApproval,
  onToggleApproveAll,
  onChangeDraft,
  onConfirm,
}: WorkQueuePlanPreviewProps) {
  const pending = approvableRows(plan);
  const allApproved = pending.length > 0 && pending.every((row) => approvals.has(row.code));
  const warnings = planWarnings(plan);
  const projectsLink = hrefFor({ name: "projects" });

  return (
    <div className="flex flex-col gap-4" aria-label="Plan preview" role="group">
      {plan.parse.items.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Parsed codes">
          {plan.parse.items.map((item) => (
            <li
              key={item.code}
              className="inline-flex items-center gap-1 rounded-pill bg-paper-3 py-0.5 pl-2.5 pr-1 font-mono text-xs font-semibold text-ink"
            >
              {item.code}
              <button
                type="button"
                aria-label={`Remove ${item.code}`}
                disabled={busy}
                onClick={() => {
                  onRemoveCode(item.code);
                }}
                className="inline-flex size-5 items-center justify-center rounded-pill text-ink-3 hover:bg-paper-2 hover:text-ink disabled:opacity-50 focus-visible:outline-focus"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {plan.parse.unknownKeys.map((unknown) => (
        <div
          key={unknown.key}
          className="flex flex-wrap items-center gap-2 rounded-md bg-accent-soft px-3 py-2 text-sm text-ink"
        >
          <span>{unknownKeyMessage(unknown.key, unknown.suggestions, projects)}</span>
          {unknown.suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              disabled={busy}
              onClick={() => {
                onPickSuggestion(unknown.key, suggestion);
              }}
              className={SECONDARY_BUTTON}
            >
              Use {suggestionLabel(suggestion, projects)}
            </button>
          ))}
        </div>
      ))}

      {warnings.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Warnings">
          {warnings.map((warning) => (
            <li key={warning} className="flex items-start gap-1.5 text-xs text-ink-2">
              <AlertTriangle size={14} className="mt-px shrink-0 text-accent-ink" aria-hidden="true" />
              <span>{warning}</span>
            </li>
          ))}
        </ul>
      )}

      {plan.rows.length > 0 && (
        <div className="flex flex-col gap-2">
          {pending.length > 1 && (
            <label className="inline-flex items-center gap-2 text-xs font-semibold text-ink-2">
              <input
                type="checkbox"
                checked={allApproved}
                disabled={busy}
                onChange={(e) => {
                  onToggleApproveAll(e.target.checked);
                }}
              />
              Approve all ({pending.length})
            </label>
          )}
          <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Planned tasks">
            {plan.rows.map((row) => {
              const parent = row.classification === "unlisted_parent" ? row.related?.[0] : undefined;
              const missing = row.classification === "waits_on_unqueued_task" ? (row.related ?? []) : [];
              return (
                <li
                  key={row.code}
                  aria-label={row.title ? `${row.code} ${row.title}` : row.code}
                  className="flex flex-col gap-2 rounded-md border border-rule bg-paper-2 p-3"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs font-semibold text-ink">{row.code}</span>
                    {row.title && <span className="min-w-0 break-words text-sm text-ink">{row.title}</span>}
                    {row.isUmbrella && <span className="text-2xs text-ink-3">umbrella</span>}
                    <span className={`rounded-pill px-2 py-0.5 text-2xs font-semibold ${statusTone(row)}`}>
                      {describeRowStatus(row)}
                    </span>
                  </div>
                  <RunControls
                    row={row}
                    levels={levels}
                    capabilities={capabilities}
                    draft={drafts.get(row.code)}
                    busy={busy}
                    onChange={(draft) => {
                      onChangeDraft(row.code, draft);
                    }}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    {row.classification === "needs_approval" && row.taskId !== undefined && (
                      <label className="inline-flex items-center gap-2 text-xs font-semibold text-ink-2">
                        <input
                          type="checkbox"
                          checked={approvals.has(row.code)}
                          disabled={busy}
                          onChange={(e) => {
                            onToggleApproval(row.code, e.target.checked);
                          }}
                        />
                        Approve {row.code}
                      </label>
                    )}
                    {parent && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onReplaceCode(row.code, parent);
                        }}
                        className={SECONDARY_BUTTON}
                      >
                        Queue {parent} instead
                      </button>
                    )}
                    {missing.length > 0 && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          onAddCodes(missing);
                        }}
                        className={SECONDARY_BUTTON}
                      >
                        Add {missing.join(", ")}
                      </button>
                    )}
                    {row.classification === "project_not_connected" && (
                      <Link href={projectsLink} className="text-xs font-semibold text-accent-ink hover:underline">
                        Map it in Projects
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {plan.lanes.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Lanes">
          {plan.lanes.map((lane) => {
            const waves = describeLaneWaves(lane, plan.rows);
            return (
              <li key={lane.projectId} className="flex flex-col gap-0.5 text-sm text-ink-2">
                <span className="font-semibold text-ink">
                  {lane.projectKey} · {lane.projectName}
                  {lane.needsQueueUmbrella && (
                    <span className="font-normal text-ink-3"> · one PR through a queue umbrella</span>
                  )}
                </span>
                {waves && <span className="break-words text-xs">{waves}</span>}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || queueCount === 0}
          onClick={onConfirm}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
        >
          Queue {queueCount} {queueCount === 1 ? "task" : "tasks"}
        </button>
        {queueCount === 0 && <span className="text-xs text-ink-3">Nothing in this plan can be queued yet.</span>}
      </div>
    </div>
  );
}
