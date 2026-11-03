import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, GitBranch, MessageSquare, RefreshCw, Send, Terminal } from "lucide-react";
import {
  DEFAULT_PROJECT_T3_WORKSPACE_STRATEGY,
  canSwitchT3Model,
  type Project,
  type ProjectT3Thread,
  type T3ConnectionStatus,
  type T3ModelCapability,
  type T3ModelSelection,
  type T3ProjectMapping,
  type T3WorkspaceStrategy,
} from "@bitig/core";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { hrefFor } from "../../routing/router";
import {
  fetchProjectT3Threads,
  fetchT3Capabilities,
  fetchT3Connection,
  fetchT3ProjectMappings,
  sendProjectT3Message,
  startProjectT3Thread,
} from "../../services/t3";
import { T3ModelPicker } from "../tasks/T3ModelPicker";
import { STATE_BADGE_CLASSES, STATE_LABELS } from "../tasks/t3-run-state";

const ICON_SIZE = 12;
const HTTP_URL_PATTERN = /^https?:\/\//i;

interface ProjectT3PanelProps {
  readonly project: Project;
  /** Focuses the message box on mount, e.g. when opened from the project card's Message action. */
  readonly focusComposer?: boolean | undefined;
}

/** T3 links come from the host; only http(s) URLs are rendered as links. */
function safeHttpUrl(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim().replace(/^<|>$/g, "").trim();
  return trimmed && HTTP_URL_PATTERN.test(trimmed) ? trimmed : undefined;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message.trim().length > 0 ? err.message : fallback;
}

/** Ctrl/Cmd+Enter sends, matching the comment box. */
function isSendShortcut(e: React.KeyboardEvent): boolean {
  return e.key === "Enter" && (e.ctrlKey || e.metaKey);
}

interface ThreadItemProps {
  readonly projectId: string;
  readonly thread: ProjectT3Thread;
  readonly capabilities: readonly T3ModelCapability[];
  readonly onUpdated: (thread: ProjectT3Thread) => void;
}

function ProjectT3ThreadItem({ projectId, thread, capabilities, onUpdated }: ThreadItemProps) {
  const [isReplying, setIsReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState<T3ModelSelection | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = safeHttpUrl(thread.link);
  const isOffline = thread.state === "offline";
  const showPicker = !isOffline && capabilities.length > 0;
  const canSwitch = canSwitchT3Model(thread.state);
  const switchSelection = showPicker && canSwitch ? selection : null;

  async function send() {
    const body = draft.trim();
    if (body === "" || isSending) return;
    setIsSending(true);
    setError(null);
    try {
      const updated = await sendProjectT3Message(projectId, thread.threadId, {
        body,
        ...(switchSelection ? { modelSelection: switchSelection } : {}),
      });
      onUpdated(updated);
      setDraft("");
      setSelection(null);
      setIsReplying(false);
    } catch (err: unknown) {
      setError(errorMessage(err, "Could not send message to T3 thread."));
    } finally {
      setIsSending(false);
    }
  }

  const replyId = `project-t3-reply-${thread.threadId}`;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-rule bg-paper p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-xs font-semibold text-ink" title={thread.title}>
            {thread.title}
          </span>
          <span className="text-2xs text-ink-3">
            <time dateTime={thread.startedAt} title={formatFullTimestamp(thread.startedAt)}>
              {formatTimeAgo(thread.startedAt)}
            </time>
            {" · "}
            {thread.workspaceStrategy === "worktree" ? "worktree" : "project root"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            data-testid="project-t3-thread-state"
            className={`inline-flex items-center rounded-pill border px-2 py-0.5 text-2xs font-semibold ${STATE_BADGE_CLASSES[thread.state]}`}
          >
            {STATE_LABELS[thread.state]}
            {thread.model ? ` · ${thread.model}` : ""}
          </span>
          {link && (
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open "${thread.title}" in T3`}
              className="inline-flex items-center gap-1 rounded-pill border border-rule bg-paper px-2 py-0.5 text-2xs font-medium text-accent-ink hover:bg-paper-3"
            >
              Open in T3
              <ExternalLink size={11} aria-hidden="true" />
            </a>
          )}
          {!isOffline && !isReplying && (
            <button
              type="button"
              onClick={() => {
                setIsReplying(true);
              }}
              aria-label={`Follow up on "${thread.title}"`}
              className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-3"
            >
              <MessageSquare size={11} aria-hidden="true" />
              Follow up
            </button>
          )}
        </div>
      </div>

      {isReplying && (
        <div className="flex flex-col gap-2">
          <label htmlFor={replyId} className="sr-only">
            Follow-up message for {thread.title}
          </label>
          <textarea
            id={replyId}
            value={draft}
            autoFocus
            rows={2}
            disabled={isSending}
            onChange={(e) => {
              setDraft(e.target.value);
            }}
            onKeyDown={(e) => {
              if (isSendShortcut(e)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Send the agent a follow-up…"
            className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
          />
          {showPicker && (
            <div className="flex flex-col gap-1">
              <T3ModelPicker
                idSuffix={`project-reply-${thread.threadId}`}
                keepLabel={`Keep current model (${thread.model ?? "default model"})`}
                capabilities={capabilities}
                value={switchSelection}
                onChange={setSelection}
                disabled={isSending || !canSwitch}
              />
              {!canSwitch && (
                <p className="m-0 text-2xs text-ink-3">
                  The model can change once the T3 thread waits for you or its turn ends.
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="m-0 text-xs text-danger">
              {error}
            </p>
          )}
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isSending || draft.trim() === ""}
              onClick={() => {
                void send();
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send size={12} aria-hidden="true" />
              {isSending ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              disabled={isSending}
              onClick={() => {
                setIsReplying(false);
                setError(null);
              }}
              className="rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-paper-3 disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Sends messages to a project's T3 workspace without a task (#BIT-127), e.g. to check the
 * environment, and lists the threads Bitig started for the project with follow-ups and model switching.
 */
export function ProjectT3Panel({ project, focusComposer = false }: ProjectT3PanelProps) {
  const [connection, setConnection] = useState<T3ConnectionStatus | null>(null);
  const [mapping, setMapping] = useState<T3ProjectMapping | undefined>(undefined);
  const [capabilities, setCapabilities] = useState<T3ModelCapability[]>([]);
  const [threads, setThreads] = useState<ProjectT3Thread[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [selection, setSelection] = useState<T3ModelSelection | null>(null);
  const [workspace, setWorkspace] = useState<T3WorkspaceStrategy>(DEFAULT_PROJECT_T3_WORKSPACE_STRATEGY);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const isConnected = Boolean(connection?.connected && !connection.expired);
  const isMapped = mapping !== undefined;
  const isReady = isConnected && isMapped;

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetchT3Connection(controller.signal).catch((): T3ConnectionStatus => ({ connected: false })),
      fetchT3ProjectMappings(controller.signal).catch((): T3ProjectMapping[] => []),
    ])
      .then(async ([conn, mappings]) => {
        const projectMapping = mappings.find((m) => m.projectId === project.id);
        const ready = conn.connected && !conn.expired && projectMapping !== undefined;
        const [caps, projectThreads] = ready
          ? await Promise.all([
              fetchT3Capabilities(controller.signal).catch((): T3ModelCapability[] => []),
              fetchProjectT3Threads(project.id, controller.signal).catch((err: unknown) => {
                if (!controller.signal.aborted) {
                  setLoadError(errorMessage(err, "Could not load project T3 threads."));
                }
                return [];
              }),
            ])
          : [[], []];
        if (controller.signal.aborted) return;
        setConnection(conn);
        setMapping(projectMapping);
        setCapabilities(caps);
        setThreads(projectThreads);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [project.id]);

  useEffect(() => {
    if (focusComposer && !isLoading && isReady) {
      composerRef.current?.focus();
    }
  }, [focusComposer, isLoading, isReady]);

  const refresh = useCallback(async () => {
    setIsRefreshing(true);
    setLoadError(null);
    try {
      setThreads(await fetchProjectT3Threads(project.id));
    } catch (err: unknown) {
      setLoadError(errorMessage(err, "Could not load project T3 threads."));
    } finally {
      setIsRefreshing(false);
    }
  }, [project.id]);

  const handleThreadUpdated = useCallback((updated: ProjectT3Thread) => {
    setThreads((prev) => prev.map((t) => (t.threadId === updated.threadId ? updated : t)));
  }, []);

  async function startThread() {
    const prompt = draft.trim();
    if (prompt === "" || isSending) return;
    setIsSending(true);
    setSendError(null);
    try {
      const thread = await startProjectT3Thread(project.id, {
        prompt,
        workspaceStrategy: workspace,
        ...(selection ? { modelSelection: selection } : {}),
      });
      setThreads((prev) => [thread, ...prev.filter((t) => t.threadId !== thread.threadId)]);
      setDraft("");
    } catch (err: unknown) {
      setSendError(errorMessage(err, "Could not start T3 thread."));
    } finally {
      setIsSending(false);
    }
  }

  let gateReason: string | null = null;
  if (!isConnected) {
    gateReason = connection?.expired
      ? "T3 OAuth token has expired. Reconnect in Settings."
      : "Connect a T3 Code host in Settings to message this project.";
  } else if (!isMapped) {
    gateReason = `Map project "${project.name}" to a T3 project in Settings first.`;
  }

  return (
    <section
      aria-labelledby="project-t3-heading"
      className="mb-5 flex flex-col gap-3 rounded-md border border-rule bg-paper-2 p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3
          id="project-t3-heading"
          className="m-0 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3"
        >
          <Terminal size={ICON_SIZE} aria-hidden="true" />
          Message T3 (no task)
        </h3>
        {isReady && threads.length > 0 && (
          <button
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={isRefreshing}
            aria-label="Refresh project T3 threads"
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-3 disabled:opacity-50"
          >
            <RefreshCw size={11} aria-hidden="true" />
            Refresh
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="m-0 text-xs text-ink-3">Loading T3…</p>
      ) : gateReason ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
          <span>{gateReason}</span>
          <Link href={hrefFor({ name: "settings" })} className="text-xs font-semibold text-accent-ink underline">
            Open Settings
          </Link>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            <label htmlFor={`project-t3-prompt-${project.id}`} className="sr-only">
              Message for {project.name} in T3
            </label>
            <textarea
              id={`project-t3-prompt-${project.id}`}
              ref={composerRef}
              value={draft}
              rows={3}
              disabled={isSending}
              onChange={(e) => {
                setDraft(e.target.value);
              }}
              onKeyDown={(e) => {
                if (isSendShortcut(e)) {
                  e.preventDefault();
                  void startThread();
                }
              }}
              placeholder="Ask the agent something about this project, e.g. check the environment…"
              className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
            />
            <div className="flex flex-wrap items-center gap-3">
              {capabilities.length > 0 && (
                <T3ModelPicker
                  idSuffix={`project-new-${project.id}`}
                  label="Model"
                  keepLabel="Default T3 model"
                  capabilities={capabilities}
                  value={selection}
                  onChange={setSelection}
                  disabled={isSending}
                />
              )}
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
                <input
                  type="checkbox"
                  checked={workspace === "worktree"}
                  disabled={isSending}
                  onChange={(e) => {
                    setWorkspace(e.target.checked ? "worktree" : "root");
                  }}
                />
                <GitBranch size={ICON_SIZE} aria-hidden="true" />
                <span>Isolated git worktree</span>
              </label>
            </div>
            {sendError && (
              <div
                role="alert"
                className="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-xs text-danger"
              >
                <AlertTriangle size={13} aria-hidden="true" />
                <span>{sendError}</span>
              </div>
            )}
            <div>
              <button
                type="button"
                disabled={isSending || draft.trim() === ""}
                onClick={() => {
                  void startThread();
                }}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={13} aria-hidden="true" />
                {isSending ? "Sending…" : "Send to T3"}
              </button>
            </div>
          </div>

          {loadError && (
            <p role="alert" className="m-0 text-xs text-danger">
              {loadError}
            </p>
          )}

          {threads.length > 0 && (
            <ul aria-label="Project T3 threads" className="m-0 flex list-none flex-col gap-2 p-0">
              {threads.map((thread) => (
                <ProjectT3ThreadItem
                  key={thread.threadId}
                  projectId={project.id}
                  thread={thread}
                  capabilities={capabilities}
                  onUpdated={handleThreadUpdated}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
