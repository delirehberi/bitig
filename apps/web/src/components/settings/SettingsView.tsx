import { useCallback, useEffect, useState } from "react";
import { McpTokensPanel } from "./McpTokensPanel";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Link2,
  RefreshCw,
  Server,
  Unlink,
} from "lucide-react";
import type {
  Project,
  StorageMode,
  T3ConnectionStatus,
  T3ProjectMapping,
  T3RemoteProject,
} from "@bitig/core";
import {
  deleteT3ProjectMapping,
  disconnectT3,
  fetchT3Connection,
  fetchT3ProjectMappings,
  fetchT3RemoteProjects,
  saveT3ProjectMapping,
  startT3OAuth,
} from "../../services/t3";

interface SettingsViewProps {
  readonly mode: StorageMode;
  readonly projects: readonly Project[];
}

function formatExpiryDate(iso: string | undefined): string {
  if (iso === undefined) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function SettingsView({ mode, projects }: SettingsViewProps) {
  const [tab, setTab] = useState<"t3" | "mcp">("t3");
  const tabs = [{ id: "t3", label: "T3 Code" }, { id: "mcp", label: "MCP Tokens" }] as const;

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 font-display text-2xl font-bold text-ink">Settings</h1>
        <p className="m-0 text-sm text-ink-2">Manage MCP client access and your T3 Code integration.</p>
      </header>
      <div role="tablist" aria-label="Settings" className="flex gap-2 border-b border-rule pb-2">
        {tabs.map((item) => (
          <button key={item.id} id={`settings-tab-${item.id}`} type="button" role="tab"
            aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
            className={`rounded-md px-4 py-2 text-sm font-semibold ${tab === item.id ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-paper-2"}`}
            onClick={() => { setTab(item.id); }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === "Home" ? "t3" : event.key === "End" ? "mcp" : tab === "t3" ? "mcp" : "t3";
              setTab(next);
              document.getElementById(`settings-tab-${next}`)?.focus();
            }}>
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
        {tab === "t3" ? <T3SettingsPanel mode={mode} projects={projects} /> : mode === "cloudflare" ? <McpTokensPanel /> : (
          <p role="note" className="rounded-lg border border-rule bg-paper-2 p-5 text-sm text-ink-2">MCP token management requires the Cloudflare Worker storage mode.</p>
        )}
      </div>
    </div>
  );
}

function T3SettingsPanel({ mode, projects }: SettingsViewProps) {
  const [connection, setConnection] = useState<T3ConnectionStatus | null>(null);
  const [mcpUrlInput, setMcpUrlInput] = useState("");
  const [mappings, setMappings] = useState<T3ProjectMapping[]>([]);
  const [remoteProjects, setRemoteProjects] = useState<T3RemoteProject[]>([]);
  const [isLoading, setIsLoading] = useState(mode === "cloudflare");
  const [isProjectsLoading, setIsProjectsLoading] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [savingProjectId, setSavingProjectId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("t3") === "error"
      ? (params.get("reason") ?? "T3 OAuth authorization failed.")
      : null;
  });
  const [banner, setBanner] = useState<string | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("t3") === "connected" ? "Connected to T3 Code host." : null;
  });

  const loadRemoteProjects = useCallback(async () => {
    setIsProjectsLoading(true);
    try {
      const list = await fetchT3RemoteProjects();
      setRemoteProjects(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load T3 projects.");
    } finally {
      setIsProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (mode !== "cloudflare") {
      return;
    }
    const controller = new AbortController();

    Promise.all([
      fetchT3Connection(controller.signal),
      fetchT3ProjectMappings(controller.signal),
    ])
      .then(async ([conn, currentMappings]) => {
        const list =
          conn.connected && !conn.expired
            ? await fetchT3RemoteProjects(controller.signal).catch(
                (): T3RemoteProject[] => [],
              )
            : [];
        if (controller.signal.aborted) return;
        setConnection(conn);
        setMappings(currentMappings);
        if (conn.mcpUrl) {
          setMcpUrlInput((prev) => (prev.length > 0 ? prev : (conn.mcpUrl ?? "")));
        }
        setRemoteProjects(list);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load T3 settings.");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [mode]);

  async function handleConnect(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const typedUrl = mcpUrlInput.trim();
    const targetUrl = typedUrl.length > 0 ? typedUrl : (connection?.mcpUrl?.trim() ?? "");
    if (!targetUrl) {
      setError("Enter your T3 Code /mcp URL first.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      const { authorizationUrl } = await startT3OAuth(targetUrl);
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start T3 OAuth.");
      setIsSubmitting(false);
    }
  }

  async function handleReconnect() {
    const typedUrl = mcpUrlInput.trim();
    const targetUrl = typedUrl.length > 0 ? typedUrl : (connection?.mcpUrl?.trim() ?? "");
    if (!targetUrl) {
      setError("Enter your T3 Code /mcp URL first.");
      return;
    }
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      const { authorizationUrl } = await startT3OAuth(targetUrl);
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reconnect T3.");
      setIsSubmitting(false);
    }
  }

  async function handleDisconnect() {
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      await disconnectT3();
      setConnection({ connected: false });
      setRemoteProjects([]);
      setBanner("Disconnected from T3 Code host.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect T3.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMappingChange(projectId: string, selectedT3ProjectId: string) {
    setSavingProjectId(projectId);
    setError(null);
    try {
      if (!selectedT3ProjectId) {
        await deleteT3ProjectMapping(projectId);
        setMappings((prev) => prev.filter((m) => m.projectId !== projectId));
      } else {
        const remote = remoteProjects.find((p) => p.id === selectedT3ProjectId);
        const t3ProjectTitle = remote?.displayName ?? remote?.title ?? selectedT3ProjectId;
        const saved = await saveT3ProjectMapping(projectId, {
          t3ProjectId: selectedT3ProjectId,
          t3ProjectTitle,
        });
        setMappings((prev) => [
          ...prev.filter((m) => m.projectId !== projectId),
          saved,
        ]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update project mapping.");
    } finally {
      setSavingProjectId(null);
    }
  }

  const activeProjects = projects.filter((project) => !project.archived);

  return (
    <div className="flex flex-col gap-8">
      {mode !== "cloudflare" ? (
        <div
          role="note"
          className="rounded-lg border border-rule bg-paper-2 p-5 text-sm text-ink-2"
        >
          T3 Code OAuth integration requires the Cloudflare Worker storage mode.
        </div>
      ) : (
        <>
          {banner && (
            <div
              role="status"
              className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-4 py-3 text-sm font-medium text-accent-ink"
            >
              <CheckCircle2 size={16} aria-hidden="true" />
              <span>{banner}</span>
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm font-medium text-danger"
            >
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}

          <section
            aria-labelledby="t3-connection-heading"
            className="flex flex-col gap-5 rounded-lg border border-rule bg-paper p-6 shadow-xs"
          >
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex flex-col gap-1">
                <h2
                  id="t3-connection-heading"
                  className="m-0 flex items-center gap-2 font-display text-lg font-bold text-ink"
                >
                  <Server size={18} aria-hidden="true" className="text-accent-ink" />
                  T3 Code Host
                </h2>
                <p className="m-0 text-xs text-ink-2">
                  Authorize Bitig as an OAuth 2.1 PKCE client against your T3 Code{" "}
                  <code className="font-mono">/mcp</code> endpoint. Tokens are encrypted with
                  AES-256-GCM at rest in D1.
                </p>
              </div>

              {connection?.connected ? (
                connection.expired ? (
                  <span className="inline-flex items-center gap-1.5 rounded-pill border border-danger/30 bg-danger-soft px-3 py-1 text-xs font-semibold text-danger">
                    <AlertTriangle size={13} aria-hidden="true" />
                    Token expired
                  </span>
                ) : connection.expiringSoon ? (
                  <span className="inline-flex items-center gap-1.5 rounded-pill border border-danger/30 bg-danger-soft px-3 py-1 text-xs font-semibold text-danger">
                    <AlertTriangle size={13} aria-hidden="true" />
                    Expiring in {String(connection.expiresInDays ?? 0)}d
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-pill border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-ink">
                    <CheckCircle2 size={13} aria-hidden="true" />
                    Connected ({String(connection.expiresInDays ?? 0)}d left)
                  </span>
                )
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-pill border border-rule bg-paper-2 px-3 py-1 text-xs font-medium text-ink-3">
                  Not connected
                </span>
              )}
            </div>

            {connection?.connected && (Boolean(connection.expiringSoon) || Boolean(connection.expired)) && (
              <div
                role="alert"
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-xs text-danger"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle size={15} aria-hidden="true" />
                  <span>
                    {connection.expired
                      ? "Your T3 OAuth token has expired. Reconnect to launch or control T3 threads."
                      : `Your T3 OAuth token expires in ${String(connection.expiresInDays ?? 0)} day(s) (${formatExpiryDate(connection.expiresAt)}). Reconnect soon to avoid interruption.`}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void handleReconnect();
                  }}
                  disabled={isSubmitting}
                  className="rounded-md border border-danger/40 bg-paper px-3 py-1.5 text-xs font-semibold text-danger hover:bg-paper-2 disabled:opacity-50"
                >
                  Reconnect now
                </button>
              </div>
            )}

            <form
              onSubmit={(e) => {
                void handleConnect(e);
              }}
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
            >
              <div className="flex flex-1 flex-col gap-1">
                <label
                  htmlFor="t3-mcp-url-input"
                  className="text-xs font-semibold text-ink-2"
                >
                  T3 MCP Endpoint URL
                </label>
                <input
                  id="t3-mcp-url-input"
                  type="url"
                  required
                  placeholder="https://t3.example.com/mcp"
                  value={mcpUrlInput}
                  onChange={(e) => {
                    setMcpUrlInput(e.target.value);
                  }}
                  className="w-full rounded-md border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink focus-visible:outline-focus"
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {connection?.connected ? (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        void handleReconnect();
                      }}
                      disabled={isSubmitting}
                      className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:opacity-50"
                    >
                      <RefreshCw size={14} aria-hidden="true" />
                      Reconnect
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        void handleDisconnect();
                      }}
                      disabled={isSubmitting}
                      className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-semibold text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
                    >
                      <Unlink size={14} aria-hidden="true" />
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="submit"
                    disabled={isSubmitting || isLoading}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:opacity-50"
                  >
                    <ExternalLink size={14} aria-hidden="true" />
                    Connect T3
                  </button>
                )}
              </div>
            </form>

            {connection?.connected && (
              <dl className="m-0 grid grid-cols-1 gap-3 border-t border-rule pt-4 text-xs sm:grid-cols-3">
                <div>
                  <dt className="font-semibold text-ink-3">Connected Endpoint</dt>
                  <dd className="m-0 mt-0.5 font-mono text-ink">{connection.mcpUrl}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-3">Token Expires</dt>
                  <dd className="m-0 mt-0.5 text-ink">{formatExpiryDate(connection.expiresAt)}</dd>
                </div>
                <div>
                  <dt className="font-semibold text-ink-3">Granted Scope</dt>
                  <dd className="m-0 mt-0.5 font-mono text-ink">{connection.scope ?? "mcp:tools"}</dd>
                </div>
              </dl>
            )}
          </section>

          <section
            aria-labelledby="t3-mapping-heading"
            className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2
                  id="t3-mapping-heading"
                  className="m-0 flex items-center gap-2 font-display text-lg font-bold text-ink"
                >
                  <Link2 size={18} aria-hidden="true" className="text-accent-ink" />
                  Project Mapping
                </h2>
                <p className="m-0 text-xs text-ink-2">
                  Link each Bitig project to an existing T3 project from{" "}
                  <code className="font-mono">t3_project_list</code>. To register a new folder on the
                  host, open the project and use its T3 panel (owners only). Bitig never edits or clones
                  T3 projects, and never creates or deletes files on the host.
                </p>
              </div>

              {connection?.connected && !connection.expired && (
                <button
                  type="button"
                  onClick={() => {
                    void loadRemoteProjects();
                  }}
                  disabled={isProjectsLoading}
                  className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-paper-3 disabled:opacity-50"
                >
                  <RefreshCw size={13} aria-hidden="true" />
                  Refresh T3 projects
                </button>
              )}
            </div>

            {activeProjects.length === 0 ? (
              <p className="m-0 text-sm text-ink-3">No active Bitig projects to map.</p>
            ) : (
              <div className="divide-y divide-rule rounded-md border border-rule">
                {activeProjects.map((project) => {
                  const currentMapping = mappings.find((m) => m.projectId === project.id);
                  const selectId = `t3-project-select-${project.id}`;
                  return (
                    <div
                      key={project.id}
                      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex flex-col">
                        <label htmlFor={selectId} className="text-sm font-semibold text-ink">
                          {project.name}
                          {project.key && (
                            <span className="ml-2 rounded-xs bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3">
                              {project.key}
                            </span>
                          )}
                        </label>
                        {currentMapping && (
                          <span className="text-2xs text-ink-3">
                            Mapped to <strong className="text-ink-2">{currentMapping.t3ProjectTitle}</strong>
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        <select
                          id={selectId}
                          aria-label={`T3 project for ${project.name}`}
                          value={currentMapping?.t3ProjectId ?? ""}
                          disabled={
                            savingProjectId === project.id ||
                            !connection?.connected ||
                            Boolean(connection.expired)
                          }
                          onChange={(e) => {
                            void handleMappingChange(project.id, e.target.value);
                          }}
                          className="min-w-56 rounded-md border border-rule bg-paper px-3 py-1.5 text-xs text-ink focus-visible:outline-focus disabled:opacity-50"
                        >
                          <option value="">Not mapped</option>
                          {currentMapping &&
                            !remoteProjects.some((rp) => rp.id === currentMapping.t3ProjectId) && (
                              <option value={currentMapping.t3ProjectId}>
                                {currentMapping.t3ProjectTitle} ({currentMapping.t3ProjectId})
                              </option>
                            )}
                          {remoteProjects.map((remote) => (
                            <option key={remote.id} value={remote.id}>
                              {remote.displayName ?? remote.title}
                              {remote.workspaceRoot ? ` — ${remote.workspaceRoot}` : ""}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
