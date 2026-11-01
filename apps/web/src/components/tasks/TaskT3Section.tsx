import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  ExternalLink,
  GitBranch,
  MessageSquare,
  Play,
  RefreshCw,
  Send,
  Square,
  Terminal,
} from "lucide-react";
import type {
  AgentRun,
  AgentRunState,
  Project,
  T3ConnectionStatus,
  T3ModelCapability,
  T3PendingQuestion,
  T3ProjectMapping,
  T3TaskRunLiveResponse,
  T3WorkspaceStrategy,
  Task,
} from "@bitig/core";
import { useRealtimeEvent } from "../../hooks/useRealtime";
import { Link } from "../../routing/Link";
import { hrefFor } from "../../routing/router";
import {
  fetchT3Capabilities,
  fetchT3Connection,
  fetchT3ProjectMappings,
  fetchTaskT3Run,
  respondToTaskT3PendingRequest,
  sendTaskT3Message,
  startTaskT3Run,
  stopTaskT3Run,
} from "../../services/t3";

interface TaskT3SectionProps {
  readonly task: Task;
  readonly project: Project | undefined;
  readonly hasUnfinishedDependencies: boolean;
  readonly onTaskUpdated?: ((task: Task) => void) | undefined;
}

const STATE_LABELS: Record<AgentRunState, string> = {
  working: "working",
  waiting_for_approval: "waiting for approval",
  finished: "finished",
  failed: "failed",
  stopped: "stopped",
  offline: "offline",
};

const STATE_BADGE_CLASSES: Record<AgentRunState, string> = {
  working: "border-accent/40 bg-accent-soft text-accent-ink",
  waiting_for_approval: "border-danger/40 bg-danger-soft text-danger",
  finished: "border-rule bg-paper-2 text-ink-2",
  failed: "border-danger/40 bg-danger-soft text-danger",
  stopped: "border-rule bg-paper-3 text-ink-3",
  offline: "border-rule bg-paper-3 text-ink-3",
};

export function TaskT3Section({
  task,
  project,
  hasUnfinishedDependencies,
  onTaskUpdated,
}: TaskT3SectionProps) {
  const [run, setRun] = useState<AgentRun | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | undefined>(undefined);
  const [pendingQuestions, setPendingQuestions] = useState<T3PendingQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState<T3ConnectionStatus | null>(null);
  const [mapping, setMapping] = useState<T3ProjectMapping | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<T3ModelCapability[]>([]);
  const [selectedModelKey, setSelectedModelKey] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [messageInput, setMessageInput] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshRunStatus = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const live = await fetchTaskT3Run(task.id, signal);
        setRun(live.run);
        setPendingRequestId(live.pendingRequestId);
        setPendingQuestions(live.pendingQuestions);
      } catch (err) {
        if (signal?.aborted) return;
        setError(err instanceof Error ? err.message : "Could not check T3 thread status.");
      }
    },
    [task.id],
  );

  useEffect(() => {
    const controller = new AbortController();

    void Promise.all([
      fetchTaskT3Run(task.id, controller.signal).catch(
        (): T3TaskRunLiveResponse => ({
          run: null,
          pendingQuestions: [],
        }),
      ),
      fetchT3Connection(controller.signal).catch(
        (): T3ConnectionStatus => ({ connected: false }),
      ),
      fetchT3ProjectMappings(controller.signal).catch(
        (): T3ProjectMapping[] => [],
      ),
    ])
      .then(async ([liveRun, conn, mappings]) => {
        const caps =
          conn.connected && !conn.expired
            ? await fetchT3Capabilities(controller.signal).catch(
                (): T3ModelCapability[] => [],
              )
            : [];
        if (controller.signal.aborted) return;
        setRun(liveRun.run);
        setPendingRequestId(liveRun.pendingRequestId);
        setPendingQuestions(liveRun.pendingQuestions);
        setConnection(conn);
        setMapping(mappings.find((m) => m.projectId === task.projectId));

        if (conn.connected && !conn.expired) {
          setCapabilities(caps);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [task.id, task.projectId]);

  useRealtimeEvent((event) => {
    if (event.type === "agent_run.updated" && event.run.taskId === task.id) {
      setRun(event.run);
    }
  });

  const isDone = task.status === "done" || task.status === "archived";
  const isAwaitingApproval = task.pendingApproval === true;
  const isConnected = Boolean(connection?.connected && !connection.expired);
  const isMapped = Boolean(mapping);

  let gateReason: string | null = null;
  if (isAwaitingApproval) {
    gateReason = "Approve this task before starting it in T3.";
  } else if (hasUnfinishedDependencies && !isDone) {
    gateReason = "Finish blocking dependencies before starting this task in T3.";
  } else if (!isConnected) {
    gateReason = connection?.expired
      ? "T3 OAuth token has expired. Reconnect in Settings."
      : "Connect a T3 Code host in Settings to launch threads.";
  } else if (!isMapped) {
    gateReason = `Map project "${project?.name ?? task.projectId}" to a T3 project in Settings first.`;
  }

  async function handleStartInT3() {
    setIsBusy(true);
    setError(null);
    try {
      const workspaceStrategy: T3WorkspaceStrategy = useWorktree ? "worktree" : "root";
      let providerInstanceId: string | undefined;
      let model: string | undefined;
      if (selectedModelKey) {
        const [prov, mod] = selectedModelKey.split("::");
        if (prov && mod) {
          providerInstanceId = prov;
          model = mod;
        } else {
          model = selectedModelKey;
        }
      }

      const launched = await startTaskT3Run(task.id, {
        workspaceStrategy,
        ...(providerInstanceId ? { providerInstanceId } : {}),
        ...(model ? { model } : {}),
      });
      setRun(launched.run);
      if (onTaskUpdated) {
        onTaskUpdated(launched.task);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start T3 thread.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleSendMessage(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = messageInput.trim();
    if (!trimmed) return;
    setIsBusy(true);
    setError(null);
    try {
      const updated = await sendTaskT3Message(task.id, trimmed);
      setRun(updated.run);
      setMessageInput("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send message to T3.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleStopRun() {
    setIsBusy(true);
    setError(null);
    try {
      const updated = await stopTaskT3Run(task.id);
      setRun(updated.run);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop T3 thread.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRespondQuestions(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!pendingRequestId) return;
    setIsBusy(true);
    setError(null);
    try {
      const updated = await respondToTaskT3PendingRequest(task.id, {
        requestId: pendingRequestId,
        answers,
      });
      setRun(updated.run);
      setPendingRequestId(undefined);
      setPendingQuestions([]);
      setAnswers({});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit answer to T3.");
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="task-t3-heading"
      className="mb-5 flex flex-col gap-3 rounded-md border border-rule bg-paper-2 p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="task-t3-heading"
          className="m-0 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3"
        >
          <Terminal size={12} aria-hidden="true" />
          T3 Code Agent
        </h3>

        {run && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              data-testid="t3-thread-chip"
              className={`inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-0.5 text-2xs font-semibold ${STATE_BADGE_CLASSES[run.state]}`}
            >
              <span>T3 thread · {STATE_LABELS[run.state]}</span>
            </span>

            {run.link && (
              <a
                href={run.link}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper px-2 py-0.5 text-2xs font-medium text-accent-ink hover:bg-paper-3"
              >
                Open in T3
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            )}

            <button
              type="button"
              onClick={() => {
                void refreshRunStatus();
              }}
              disabled={isBusy}
              aria-label="Refresh T3 thread status"
              className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-3 disabled:opacity-50"
            >
              <RefreshCw size={11} aria-hidden="true" />
              Refresh
            </button>
          </div>
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-xs text-danger"
        >
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {run ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-ink-3">
            <span>
              Thread <code className="font-mono text-ink-2">{run.threadId}</code>
              {run.workspaceStrategy === "worktree" ? " · worktree" : ""}
              {run.model ? ` · ${run.model}` : ""}
            </span>

            {(run.state === "working" || run.state === "waiting_for_approval") && (
              <button
                type="button"
                onClick={() => {
                  void handleStopRun();
                }}
                disabled={isBusy}
                className="inline-flex items-center gap-1 rounded-md border border-danger/40 bg-paper px-2.5 py-1 text-2xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
              >
                <Square size={11} aria-hidden="true" />
                Stop thread
              </button>
            )}
          </div>

          {pendingQuestions.length > 0 && pendingRequestId && (
            <form
              onSubmit={(e) => {
                void handleRespondQuestions(e);
              }}
              className="flex flex-col gap-2.5 rounded-md border border-danger/30 bg-paper p-3"
            >
              <p className="m-0 text-xs font-semibold text-danger">
                T3 thread is waiting for your input:
              </p>
              {pendingQuestions.map((q) => {
                const inputId = `t3-pending-q-${q.id}`;
                return (
                  <div key={q.id} className="flex flex-col gap-1">
                    <label htmlFor={inputId} className="text-xs font-medium text-ink">
                      {q.header ? `${q.header}: ` : ""}
                      {q.question}
                    </label>
                    {q.options && q.options.length > 0 ? (
                      <select
                        id={inputId}
                        value={answers[q.id] ?? ""}
                        onChange={(e) => {
                          setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }));
                        }}
                        required
                        className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs text-ink"
                      >
                        <option value="">Select an answer…</option>
                        {q.options.map((opt) => (
                          <option key={opt.label} value={opt.label}>
                            {opt.label}
                            {opt.description ? ` — ${opt.description}` : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={inputId}
                        type="text"
                        required
                        value={answers[q.id] ?? ""}
                        onChange={(e) => {
                          setAnswers((prev) => ({ ...prev, [q.id]: e.target.value }));
                        }}
                        placeholder="Type your response…"
                        className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs text-ink"
                      />
                    )}
                  </div>
                );
              })}
              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={isBusy}
                  className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper hover:bg-accent-ink disabled:opacity-50"
                >
                  <Send size={12} aria-hidden="true" />
                  Submit answer
                </button>
              </div>
            </form>
          )}

          {run.state === "waiting_for_approval" && pendingQuestions.length === 0 && (
            <p className="m-0 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-2xs text-danger">
              The thread is waiting for a tool approval or input in T3 Code.
            </p>
          )}

          <form
            onSubmit={(e) => {
              void handleSendMessage(e);
            }}
            className="flex items-center gap-2"
          >
            <MessageSquare size={14} aria-hidden="true" className="shrink-0 text-ink-3" />
            <input
              type="text"
              aria-label="Message T3 thread"
              placeholder="Send a follow-up message to the T3 thread…"
              value={messageInput}
              onChange={(e) => {
                setMessageInput(e.target.value);
              }}
              disabled={isBusy || run.state === "offline"}
              className="flex-1 rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs text-ink focus-visible:outline-focus disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={isBusy || !messageInput.trim() || run.state === "offline"}
              className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-3 disabled:opacity-50"
            >
              <Send size={12} aria-hidden="true" />
              Send
            </button>
          </form>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {gateReason ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
              <span>{gateReason}</span>
              {(!isConnected || !isMapped) && (
                <Link
                  href={hrefFor({ name: "settings" })}
                  className="text-xs font-semibold text-accent-ink underline"
                >
                  Open Settings
                </Link>
              )}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={useWorktree}
                  onChange={(e) => {
                    setUseWorktree(e.target.checked);
                  }}
                />
                <GitBranch size={12} aria-hidden="true" />
                <span>Isolated git worktree</span>
              </label>

              {capabilities.length > 0 && (
                <select
                  aria-label="T3 model"
                  value={selectedModelKey}
                  onChange={(e) => {
                    setSelectedModelKey(e.target.value);
                  }}
                  className="rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink"
                >
                  <option value="">Default T3 model</option>
                  {capabilities.map((cap) => {
                    const key = `${cap.providerInstanceId}::${cap.model}`;
                    return (
                      <option key={key} value={key}>
                        {cap.displayName ? `${cap.displayName}: ` : ""}
                        {cap.label ?? cap.model}
                      </option>
                    );
                  })}
                </select>
              )}
            </div>
          )}

          <div>
            <button
              type="button"
              disabled={isLoading || isBusy || Boolean(gateReason) || isDone}
              onClick={() => {
                void handleStartInT3();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play size={13} aria-hidden="true" />
              Start in T3
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
