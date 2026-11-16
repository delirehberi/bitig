import { ListPlus } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Project, T3ModelCapability } from "@bitig/core";
import { useRunProfiles } from "../../domain/run-profiles";
import { Link } from "../../routing/Link";
import { hrefFor } from "../../routing/router";
import { fetchT3Capabilities } from "../../services/t3";
import {
  confirmWorkQueue,
  planWorkQueue,
  WorkQueueApiError,
  type PlanWorkQueueInput,
  type WorkQueueConfirmResult,
  type WorkQueuePlanView,
} from "../../services/work-queue";
import { useT3Connected } from "./useT3Connected";
import { WorkQueuePlanPreview } from "./WorkQueuePlanPreview";
import {
  addCodes,
  approvableRows,
  buildOverrides,
  queuedCodes,
  replaceCode,
  replacePromptKey,
  type RowOverrideDraft,
} from "./work-queue-model";

interface WorkQueuePromptProps {
  /** False outside Cloudflare mode, where there is no worker to plan with. */
  readonly enabled: boolean;
  /** Projects, for names in key suggestions. */
  readonly projects: readonly Project[];
  /** Known T3 connection (tests); the prompt checks it itself otherwise. */
  readonly t3Connected?: boolean | undefined;
}

export const WORK_QUEUE_PLACEHOLDER = "Start BIT-92 to BIT-102, WOR-1 and KMZ-3";
const PLAN_FAILURE = "Could not plan the work queue";
const CONFIRM_FAILURE = "Could not queue the tasks";
const NO_CODES_MESSAGE = "Couldn't find any task codes. Try codes like BIT-92 or a range like BIT-92 to BIT-102.";

type Busy = "idle" | "planning" | "confirming";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function confirmedSummary(result: WorkQueueConfirmResult): string {
  const count = result.queue.entries.length;
  const parts = [`Queued ${String(count)} ${count === 1 ? "task" : "tasks"}.`];
  if (result.approved.length > 0) parts.push(`Approved ${result.approved.join(", ")}.`);
  const umbrellas = result.umbrellas.flatMap((umbrella) => (umbrella.code ? [umbrella.code] : []));
  if (umbrellas.length > 0) parts.push(`Queue umbrellas: ${umbrellas.join(", ")}.`);
  return parts.join(" ");
}

/**
 * Dashboard prompt (#BIT-205): free text becomes a plan preview through the worker, and one confirm
 * queues the tasks. The typed text is never cleared by a failure, only by a successful queue.
 */
export function WorkQueuePrompt({ enabled, projects, t3Connected }: WorkQueuePromptProps) {
  const connection = useT3Connected(enabled, t3Connected);
  const { levels } = useRunProfiles();
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<WorkQueuePlanView | null>(null);
  const [busy, setBusy] = useState<Busy>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [approvals, setApprovals] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, RowOverrideDraft>>(new Map());
  const [capabilities, setCapabilities] = useState<readonly T3ModelCapability[]>([]);
  const requestRef = useRef<AbortController | null>(null);
  const capabilitiesRequest = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      requestRef.current?.abort();
      capabilitiesRequest.current?.abort();
    },
    [],
  );

  // Models are only needed once there is a plan to edit; a failure leaves the level selector alone.
  useEffect(() => {
    if (!plan || capabilitiesRequest.current) return;
    const controller = new AbortController();
    capabilitiesRequest.current = controller;
    fetchT3Capabilities(controller.signal)
      .then((caps) => {
        if (!controller.signal.aborted) setCapabilities(caps);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Could not load T3 models for the work queue preview", err);
      });
  }, [plan]);

  if (!enabled) return null;

  function startRequest(): AbortSignal {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    return controller.signal;
  }

  async function runPlan(input: PlanWorkQueueInput) {
    const signal = startRequest();
    setBusy("planning");
    setError(null);
    setNotice(null);
    try {
      const next = await planWorkQueue(input, signal);
      if (signal.aborted) return;
      setPlan(next);
      // Edits and approvals survive a re-plan for codes that are still listed.
      const planned = new Set(next.rows.map((row) => row.code));
      setApprovals((prev) => new Set([...prev].filter((code) => planned.has(code))));
      setDrafts((prev) => new Map([...prev].filter(([code]) => planned.has(code))));
      if (next.rows.length === 0 && next.parse.unknownKeys.length === 0) setError(NO_CODES_MESSAGE);
    } catch (err: unknown) {
      if (signal.aborted || isAbort(err)) return;
      setError(errorMessage(err, PLAN_FAILURE));
    } finally {
      if (!signal.aborted) setBusy("idle");
    }
  }

  function planPrompt(text: string) {
    const trimmed = text.trim();
    if (trimmed.length === 0 || busy !== "idle") return;
    void runPlan({ prompt: trimmed });
  }

  function planCodes(codes: readonly string[]) {
    if (codes.length === 0) {
      requestRef.current?.abort();
      setPlan(null);
      setApprovals(new Set());
      setDrafts(new Map());
      return;
    }
    void runPlan({ prompt: prompt.trim() || codes.join(", "), items: codes });
  }

  function currentCodes(): string[] {
    return plan ? plan.parse.items.map((item) => item.code) : [];
  }

  async function confirm() {
    if (!plan) return;
    const codes = currentCodes();
    const queued = queuedCodes(plan, approvals);
    const signal = startRequest();
    setBusy("confirming");
    setError(null);
    try {
      const result = await confirmWorkQueue(
        {
          prompt: prompt.trim() || codes.join(", "),
          items: codes,
          approvals: approvableRows(plan)
            .filter((row) => approvals.has(row.code))
            .map((row) => row.code),
          overrides: buildOverrides(drafts, queued),
        },
        signal,
      );
      if (signal.aborted) return;
      setNotice(confirmedSummary(result));
      setPrompt("");
      setPlan(null);
      setApprovals(new Set());
      setDrafts(new Map());
    } catch (err: unknown) {
      if (signal.aborted || isAbort(err)) return;
      // The server sends its fresh plan when nothing can be queued any more; show it.
      if (err instanceof WorkQueueApiError && err.plan) setPlan(err.plan);
      setError(errorMessage(err, CONFIRM_FAILURE));
    } finally {
      if (!signal.aborted) setBusy("idle");
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    planPrompt(prompt);
  }

  const isBusy = busy !== "idle";
  const queueCount = plan ? queuedCodes(plan, approvals).length : 0;

  return (
    <section
      aria-labelledby="work-queue-heading"
      className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-4 shadow-xs sm:p-6"
    >
      <div className="flex items-center gap-2">
        <ListPlus size={18} className="text-ink-3" aria-hidden="true" />
        <h2 id="work-queue-heading" className="m-0 font-display text-lg font-semibold text-ink">
          Start work
        </h2>
      </div>

      {connection === "checking" ? (
        <p className="m-0 text-sm text-ink-3" role="status">
          Checking the T3 connection…
        </p>
      ) : connection !== "connected" ? (
        <p className="m-0 text-sm text-ink-2">
          {connection === "unknown"
            ? "Could not check the T3 connection. "
            : "Queue tasks for agents once a T3 host is connected. "}
          <Link href={hrefFor({ name: "settings" })} className="font-semibold text-accent-ink hover:underline">
            Connect T3
          </Link>
        </p>
      ) : (
        <>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              planPrompt(prompt);
            }}
          >
            <label htmlFor="work-queue-prompt" className="text-xs font-semibold text-ink-2">
              Which tasks should agents work on?
            </label>
            <textarea
              id="work-queue-prompt"
              value={prompt}
              rows={2}
              placeholder={WORK_QUEUE_PLACEHOLDER}
              onChange={(e) => {
                setPrompt(e.target.value);
              }}
              onKeyDown={handleKeyDown}
              aria-describedby="work-queue-hint"
              className="w-full resize-y rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span id="work-queue-hint" className="text-2xs text-ink-3">
                Codes, ranges and lists. Ctrl+Enter or Cmd+Enter plans.
              </span>
              <button
                type="submit"
                disabled={isBusy || prompt.trim().length === 0}
                className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
              >
                {busy === "planning" ? "Planning…" : "Plan"}
              </button>
            </div>
          </form>

          {error && (
            <p role="alert" className="m-0 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="m-0 rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">
              {notice}
            </p>
          )}

          {plan && (
            <WorkQueuePlanPreview
              plan={plan}
              projects={projects}
              levels={levels}
              capabilities={capabilities}
              approvals={approvals}
              drafts={drafts}
              queueCount={queueCount}
              busy={isBusy}
              onRemoveCode={(code) => {
                planCodes(currentCodes().filter((candidate) => candidate !== code));
              }}
              onPickSuggestion={(unknownKey, suggestion) => {
                const next = replacePromptKey(prompt, unknownKey, suggestion);
                setPrompt(next);
                if (next.trim().length > 0) void runPlan({ prompt: next.trim() });
              }}
              onReplaceCode={(from, to) => {
                planCodes(replaceCode(currentCodes(), from, to));
              }}
              onAddCodes={(codes) => {
                planCodes(addCodes(currentCodes(), codes));
              }}
              onToggleApproval={(code, approved) => {
                setApprovals((prev) => {
                  const next = new Set(prev);
                  if (approved) next.add(code);
                  else next.delete(code);
                  return next;
                });
              }}
              onToggleApproveAll={(approved) => {
                setApprovals(approved ? new Set(approvableRows(plan).map((row) => row.code)) : new Set());
              }}
              onChangeDraft={(code, draft) => {
                setDrafts((prev) => {
                  const next = new Map(prev);
                  if (Object.keys(draft).length === 0) next.delete(code);
                  else next.set(code, draft);
                  return next;
                });
              }}
              onConfirm={() => {
                void confirm();
              }}
            />
          )}
        </>
      )}
    </section>
  );
}
