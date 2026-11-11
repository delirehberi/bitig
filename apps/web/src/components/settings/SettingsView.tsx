import { useCallback, useEffect, useState } from "react";
import { McpTokensPanel } from "./McpTokensPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderGit2,
  Link2,
  Pencil,
  RefreshCw,
  Save,
  Server,
  Unlink,
  X,
} from "lucide-react";
import {
  defaultT3HostProjectsRoot,
  type OrganisationRole,
  type Project,
  type StorageMode,
  type T3ConnectionStatus,
  type T3HostConnectionStatus,
  type T3HostKind,
  type T3ProjectMapping,
  type T3RemoteProject,
} from "@bitig/core";
import { useOptionalAuth } from "../../auth/useAuth";
import {
  deleteT3ProjectMapping,
  disconnectT3,
  disconnectT3Host,
  fetchT3Connection,
  fetchT3Hosts,
  fetchT3ProjectMappings,
  fetchT3RemoteProjects,
  saveT3ProjectMapping,
  startT3OAuth,
  updateT3Host,
} from "../../services/t3";

interface SettingsViewProps {
  readonly mode: StorageMode;
  readonly projects: readonly Project[];
  readonly role?: OrganisationRole | undefined;
}

function formatExpiryDate(iso: string | undefined): string {
  if (iso === undefined) return "\u2014";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "\u2014" : date.toLocaleString();
}

function hostDisplayName(host: Pick<T3HostConnectionStatus, "id" | "label" | "mcpUrl">): string {
  return host.label?.trim() ? host.label.trim() : host.mcpUrl || host.id;
}

function synthesizeHostFromConnection(conn: T3ConnectionStatus): T3HostConnectionStatus | null {
  if (!conn.connected) return null;
  const kind: T3HostKind = conn.kind ?? "user";
  const nowIso = new Date().toISOString();
  return {
    id: conn.id ?? "default",
    ...(conn.label ? { label: conn.label } : {}),
    kind,
    projectsRoot: conn.projectsRoot ?? defaultT3HostProjectsRoot(kind),
    connected: true,
    mcpUrl: conn.mcpUrl ?? "",
    issuer: conn.issuer ?? "",
    ...(conn.scope ? { scope: conn.scope } : {}),
    connectedAt: conn.connectedAt ?? nowIso,
    expiresAt: conn.expiresAt ?? nowIso,
    expiresInDays: conn.expiresInDays ?? 0,
    expiringSoon: Boolean(conn.expiringSoon),
    expired: Boolean(conn.expired),
  };
}

const SETTINGS_TABS = [
  { id: "t3", label: "T3 Code" },
  { id: "mcp", label: "MCP Tokens" },
  { id: "notifications", label: "Notifications" },
] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

/** The tab a Home/End/arrow key moves focus to, wrapping around at either end. */
function adjacentTab(current: SettingsTab, key: string): SettingsTab {
  const ids = SETTINGS_TABS.map((item) => item.id);
  const last = ids.length - 1;
  const index = ids.indexOf(current);
  const nextIndex =
    key === "Home" ? 0 : key === "End" ? last : key === "ArrowRight" ? (index + 1) % ids.length : (index - 1 + ids.length) % ids.length;
  return ids[nextIndex] ?? current;
}

export function SettingsView({ mode, projects, role }: SettingsViewProps) {
  const [tab, setTab] = useState<SettingsTab>("t3");

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="m-0 font-display text-2xl font-bold text-ink">Settings</h1>
        <p className="m-0 text-sm text-ink-2">Manage MCP client access, your T3 Code integration, and browser notifications.</p>
      </header>
      <div role="tablist" aria-label="Settings" className="flex gap-2 border-b border-rule pb-2">
        {SETTINGS_TABS.map((item) => (
          <button key={item.id} id={`settings-tab-${item.id}`} type="button" role="tab"
            aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
            className={`rounded-md px-4 py-2 text-sm font-semibold ${tab === item.id ? "bg-accent-soft text-accent-ink" : "text-ink-2 hover:bg-paper-2"}`}
            onClick={() => { setTab(item.id); }}
            onKeyDown={(event) => {
              if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const next = adjacentTab(tab, event.key);
              setTab(next);
              document.getElementById(`settings-tab-${next}`)?.focus();
            }}>
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`settings-panel-${tab}`} aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
        {tab === "t3" ? <T3SettingsPanel mode={mode} projects={projects} role={role} /> : tab === "notifications" ? <NotificationsPanel /> : mode === "cloudflare" ? <McpTokensPanel /> : (
          <p role="note" className="rounded-lg border border-rule bg-paper-2 p-5 text-sm text-ink-2">MCP token management requires the Cloudflare Worker storage mode.</p>
        )}
      </div>
    </div>
  );
}

function HostStatusBadge({ host }: { readonly host: T3HostConnectionStatus }) {
  if (host.expired) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-danger/30 bg-danger-soft px-3 py-1 text-xs font-semibold text-danger">
        <AlertTriangle size={13} aria-hidden="true" />
        Token expired
      </span>
    );
  }
  if (host.expiringSoon) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-pill border border-danger/30 bg-danger-soft px-3 py-1 text-xs font-semibold text-danger">
        <AlertTriangle size={13} aria-hidden="true" />
        Expiring in {String(host.expiresInDays)}d
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-pill border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-ink">
      <CheckCircle2 size={13} aria-hidden="true" />
      Connected ({String(host.expiresInDays)}d left)
    </span>
  );
}

interface HostCardProps {
  readonly host: T3HostConnectionStatus;
  readonly boundProjects: readonly Project[];
  readonly isSubmitting: boolean;
  readonly onReauthorise: (host: T3HostConnectionStatus) => Promise<void>;
  readonly onDisconnect: (host: T3HostConnectionStatus) => Promise<void>;
  readonly onUpdateHost: (
    hostId: string,
    input: { label?: string | null; kind?: T3HostKind; projectsRoot?: string },
  ) => Promise<void>;
}

function HostCard({
  host,
  boundProjects,
  isSubmitting,
  onReauthorise,
  onDisconnect,
  onUpdateHost,
}: HostCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState(host.label ?? "");
  const [kindDraft, setKindDraft] = useState<T3HostKind>(host.kind);
  const [projectsRootDraft, setProjectsRootDraft] = useState(host.projectsRoot);
  const [projectsRootDirty, setProjectsRootDirty] = useState(false);

  const name = hostDisplayName(host);

  function openEditor() {
    setLabelDraft(host.label ?? "");
    setKindDraft(host.kind);
    setProjectsRootDraft(host.projectsRoot);
    setProjectsRootDirty(false);
    setIsEditing(true);
  }

  async function handleSaveEdit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedRoot = projectsRootDraft.trim() || defaultT3HostProjectsRoot(kindDraft);
    const trimmedLabel = labelDraft.trim();
    await onUpdateHost(host.id, {
      label: trimmedLabel.length > 0 ? trimmedLabel : null,
      kind: kindDraft,
      projectsRoot: trimmedRoot,
    });
    setIsEditing(false);
  }

  return (
    <div
      data-testid={`t3-host-card-${host.id}`}
      className="flex flex-col gap-4 rounded-md border border-rule bg-paper-2 p-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="m-0 font-display text-sm font-bold text-ink">{name}</h3>
            <span className="rounded-xs border border-rule bg-paper px-1.5 py-0.5 font-mono text-2xs text-ink-3">
              {host.kind === "container" ? "Container host" : "User host"}
            </span>
          </div>
          {host.label && (
            <p className="m-0 font-mono text-xs text-ink-2">{host.mcpUrl}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <HostStatusBadge host={host} />
          <button
            type="button"
            onClick={() => {
              openEditor();
            }}
            disabled={isSubmitting}
            aria-label={`Edit ${name}`}
            className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-3 disabled:opacity-50"
          >
            <Pencil size={12} aria-hidden="true" />
            Edit
          </button>
          <button
            type="button"
            onClick={() => {
              void onReauthorise(host);
            }}
            disabled={isSubmitting}
            aria-label={`Reauthorise ${name}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:opacity-50"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Reauthorise
          </button>
          <button
            type="button"
            onClick={() => {
              void onDisconnect(host);
            }}
            disabled={isSubmitting}
            aria-label={`Disconnect ${name}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger-soft disabled:opacity-50"
          >
            <Unlink size={13} aria-hidden="true" />
            Disconnect
          </button>
        </div>
      </div>

      {(host.expiringSoon || host.expired) && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>
              {host.expired
                ? `OAuth token for ${name} has expired. Reauthorise to launch or control T3 threads on this host.`
                : `OAuth token for ${name} expires in ${String(host.expiresInDays)} day(s) (${formatExpiryDate(host.expiresAt)}). Reauthorise soon to avoid interruption.`}
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              void onReauthorise(host);
            }}
            disabled={isSubmitting}
            className="rounded-md border border-danger/40 bg-paper px-2.5 py-1 text-xs font-semibold text-danger hover:bg-paper-2 disabled:opacity-50"
          >
            Reauthorise now
          </button>
        </div>
      )}

      {isEditing && (
        <form
          onSubmit={(e) => {
            void handleSaveEdit(e);
          }}
          className="grid grid-cols-1 gap-3 rounded-md border border-rule bg-paper p-3 sm:grid-cols-3"
        >
          <div className="flex flex-col gap-1">
            <label htmlFor={`host-label-${host.id}`} className="text-2xs font-semibold text-ink-2">
              Host label
            </label>
            <input
              id={`host-label-${host.id}`}
              type="text"
              value={labelDraft}
              onChange={(e) => {
                setLabelDraft(e.target.value);
              }}
              placeholder="Laptop"
              className="rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs text-ink focus-visible:outline-focus"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`host-kind-${host.id}`} className="text-2xs font-semibold text-ink-2">
              Host kind
            </label>
            <select
              id={`host-kind-${host.id}`}
              value={kindDraft}
              onChange={(e) => {
                const nextKind = e.target.value as T3HostKind;
                setKindDraft(nextKind);
                if (!projectsRootDirty) {
                  setProjectsRootDraft(defaultT3HostProjectsRoot(nextKind));
                }
              }}
              className="rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs text-ink focus-visible:outline-focus"
            >
              <option value="user">User host (~/www)</option>
              <option value="container">Container (/var/www)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor={`host-root-${host.id}`} className="text-2xs font-semibold text-ink-2">
              Projects root
            </label>
            <input
              id={`host-root-${host.id}`}
              type="text"
              required
              value={projectsRootDraft}
              onChange={(e) => {
                setProjectsRootDraft(e.target.value);
                setProjectsRootDirty(true);
              }}
              className="rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 font-mono text-xs text-ink focus-visible:outline-focus"
            />
          </div>

          <div className="flex items-center justify-end gap-2 sm:col-span-3">
            <button
              type="button"
              onClick={() => {
                setIsEditing(false);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper-2 px-2.5 py-1 text-xs font-semibold text-ink-2 hover:bg-paper-3"
            >
              <X size={12} aria-hidden="true" />
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1 text-xs font-semibold text-paper hover:bg-accent-ink disabled:opacity-50"
            >
              <Save size={12} aria-hidden="true" />
              Save host
            </button>
          </div>
        </form>
      )}

      <dl className="m-0 grid grid-cols-1 gap-3 border-t border-rule pt-3 text-xs sm:grid-cols-4">
        <div>
          <dt className="font-semibold text-ink-3">Connected Endpoint</dt>
          <dd className="m-0 mt-0.5 break-all font-mono text-ink">{host.mcpUrl}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink-3">Projects Root</dt>
          <dd className="m-0 mt-0.5 font-mono text-ink">{host.projectsRoot}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink-3">Token Expires</dt>
          <dd className="m-0 mt-0.5 text-ink">{formatExpiryDate(host.expiresAt)}</dd>
        </div>
        <div>
          <dt className="font-semibold text-ink-3">Granted Scope</dt>
          <dd className="m-0 mt-0.5 font-mono text-ink">{host.scope ?? "mcp:tools"}</dd>
        </div>
      </dl>

      {boundProjects.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-rule pt-2.5 text-2xs text-ink-3">
          <FolderGit2 size={12} aria-hidden="true" />
          <span>Bound projects:</span>
          {boundProjects.map((project) => (
            <span
              key={project.id}
              className="rounded-xs border border-rule bg-paper px-1.5 py-0.5 font-medium text-ink-2"
            >
              {project.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function T3SettingsPanel({ mode, projects, role }: SettingsViewProps) {
  const auth = useOptionalAuth();
  const effectiveRole: OrganisationRole = role ?? auth?.currentRole ?? "owner";
  const isOwner = effectiveRole === "owner";

  const [hosts, setHosts] = useState<T3HostConnectionStatus[]>([]);
  const [mcpUrlInput, setMcpUrlInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [kindInput, setKindInput] = useState<T3HostKind>("user");
  const [projectsRootInput, setProjectsRootInput] = useState(() => defaultT3HostProjectsRoot("user"));
  const [projectsRootEdited, setProjectsRootEdited] = useState(false);

  const [mappings, setMappings] = useState<T3ProjectMapping[]>([]);
  const [remoteProjectsByHost, setRemoteProjectsByHost] = useState<Record<string, T3RemoteProject[]>>({});
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

  const loadRemoteProjectsForHosts = useCallback(
    async (targetHosts: readonly T3HostConnectionStatus[], signal?: AbortSignal) => {
      const activeHosts = targetHosts.filter((h) => !h.expired);
      if (activeHosts.length === 0) {
        setRemoteProjectsByHost({});
        return;
      }
      setIsProjectsLoading(true);
      try {
        const entries = await Promise.all(
          activeHosts.map(async (host) => {
            const list = await fetchT3RemoteProjects(signal, host.id === "default" ? undefined : host.id).catch(
              (): T3RemoteProject[] => [],
            );
            return [host.id, list] as const;
          }),
        );
        if (signal?.aborted) return;
        setRemoteProjectsByHost(Object.fromEntries(entries));
      } finally {
        if (!signal?.aborted) {
          setIsProjectsLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (mode !== "cloudflare") {
      return;
    }
    const controller = new AbortController();

    Promise.all([
      fetchT3Hosts(controller.signal).catch((): T3HostConnectionStatus[] => []),
      fetchT3ProjectMappings(controller.signal),
    ])
      .then(async ([loadedHosts, currentMappings]) => {
        let resolvedHosts = loadedHosts;
        if (resolvedHosts.length === 0) {
          const fallbackConn = await fetchT3Connection(controller.signal).catch(
            (): T3ConnectionStatus => ({ connected: false }),
          );
          const synthesized = synthesizeHostFromConnection(fallbackConn);
          if (synthesized) {
            resolvedHosts = [synthesized];
          }
        }
        if (controller.signal.aborted) return;
        setHosts(resolvedHosts);
        setMappings(currentMappings);
        if (isOwner && resolvedHosts.length > 0) {
          await loadRemoteProjectsForHosts(resolvedHosts, controller.signal);
        }
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
  }, [isOwner, loadRemoteProjectsForHosts, mode]);

  async function handleConnect(e: React.SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    const typedUrl = mcpUrlInput.trim();
    if (!typedUrl) {
      setError("Enter your T3 Code /mcp URL first.");
      return;
    }
    const trimmedLabel = labelInput.trim();
    const trimmedRoot = projectsRootInput.trim() || defaultT3HostProjectsRoot(kindInput);
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      const { authorizationUrl } = await startT3OAuth({
        mcpUrl: typedUrl,
        ...(trimmedLabel ? { label: trimmedLabel } : {}),
        kind: kindInput,
        projectsRoot: trimmedRoot,
      });
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start T3 OAuth.");
      setIsSubmitting(false);
    }
  }

  async function handleReauthorise(host: T3HostConnectionStatus) {
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      const { authorizationUrl } = await startT3OAuth({
        mcpUrl: host.mcpUrl,
        ...(host.id !== "default" ? { hostId: host.id } : {}),
        ...(host.label ? { label: host.label } : {}),
        kind: host.kind,
        projectsRoot: host.projectsRoot,
      });
      window.location.assign(authorizationUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reauthorise T3 host.");
      setIsSubmitting(false);
    }
  }

  async function handleDisconnectHost(host: T3HostConnectionStatus) {
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      if (host.id === "default") {
        await disconnectT3();
      } else {
        await disconnectT3Host(host.id);
      }
      setHosts((prev) => prev.filter((item) => item.id !== host.id));
      setRemoteProjectsByHost((prev) =>
        Object.fromEntries(Object.entries(prev).filter(([key]) => key !== host.id)),
      );
      setBanner(`Disconnected ${hostDisplayName(host)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect T3 host.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleUpdateHost(
    hostId: string,
    input: { label?: string | null; kind?: T3HostKind; projectsRoot?: string },
  ) {
    setIsSubmitting(true);
    setError(null);
    setBanner(null);
    try {
      const updated = await updateT3Host(hostId, input);
      setHosts((prev) => prev.map((item) => (item.id === hostId ? updated : item)));
      setBanner(`Updated host ${hostDisplayName(updated)}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update T3 host.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleMappingChange(projectId: string, encodedSelection: string) {
    setSavingProjectId(projectId);
    setError(null);
    try {
      if (!encodedSelection) {
        await deleteT3ProjectMapping(projectId);
        setMappings((prev) => prev.filter((m) => m.projectId !== projectId));
      } else {
        const separatorIdx = encodedSelection.indexOf("::");
        const selectedHostId = separatorIdx >= 0 ? encodedSelection.slice(0, separatorIdx) : hosts[0]?.id;
        const selectedT3ProjectId =
          separatorIdx >= 0 ? encodedSelection.slice(separatorIdx + 2) : encodedSelection;
        const hostProjects = selectedHostId ? (remoteProjectsByHost[selectedHostId] ?? []) : [];
        const remote = hostProjects.find((p) => p.id === selectedT3ProjectId);
        const t3ProjectTitle = remote?.displayName ?? remote?.title ?? selectedT3ProjectId;
        const saved = await saveT3ProjectMapping(projectId, {
          t3ProjectId: selectedT3ProjectId,
          t3ProjectTitle,
          ...(selectedHostId && selectedHostId !== "default" ? { hostId: selectedHostId } : {}),
          ...(remote?.workspaceRoot ? { workspaceRoot: remote.workspaceRoot } : {}),
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
  const hasConnectedHost = hosts.length > 0;
  const hasUsableHost = hosts.some((h) => !h.expired);

  function resolveHostForMapping(mapping: T3ProjectMapping | undefined): T3HostConnectionStatus | undefined {
    if (!mapping) return undefined;
    if (mapping.hostId) {
      return hosts.find((h) => h.id === mapping.hostId);
    }
    return hosts.length === 1 ? hosts[0] : undefined;
  }

  if (mode !== "cloudflare") {
    return (
      <div
        role="note"
        className="rounded-lg border border-rule bg-paper-2 p-5 text-sm text-ink-2"
      >
        T3 Code OAuth integration requires the Cloudflare Worker storage mode.
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="flex flex-col gap-6">
        <section
          aria-labelledby="t3-member-hosts-heading"
          className="flex flex-col gap-4 rounded-lg border border-rule bg-paper p-6 shadow-xs"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2
                id="t3-member-hosts-heading"
                className="m-0 flex items-center gap-2 font-display text-lg font-bold text-ink"
              >
                <Server size={18} aria-hidden="true" className="text-accent-ink" />
                Project T3 Hosts
              </h2>
              <p className="m-0 text-xs text-ink-2">
                View the T3 Code host bound to each project in this organisation. Only organisation owners
                can connect, reauthorise, or disconnect hosts, or change a project&apos;s bound host folder.
              </p>
            </div>
            <span className="inline-flex items-center rounded-pill border border-rule bg-paper-2 px-3 py-1 text-xs font-medium text-ink-3">
              Read-only ({effectiveRole})
            </span>
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

          {isLoading ? (
            <p role="status" className="m-0 text-sm text-ink-3">
              Loading project T3 hosts…
            </p>
          ) : activeProjects.length === 0 ? (
            <p className="m-0 text-sm text-ink-3">No active projects in this organisation.</p>
          ) : (
            <div className="divide-y divide-rule rounded-md border border-rule">
              {activeProjects.map((project) => {
                const currentMapping = mappings.find((m) => m.projectId === project.id);
                const boundHost = resolveHostForMapping(currentMapping);
                return (
                  <div
                    key={project.id}
                    data-testid={`member-project-host-${project.id}`}
                    className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="flex flex-col">
                      <span className="text-sm font-semibold text-ink">
                        {project.name}
                        {project.key && (
                          <span className="ml-2 rounded-xs bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-3">
                            {project.key}
                          </span>
                        )}
                      </span>
                      {currentMapping ? (
                        <span className="text-xs text-ink-2">
                          Folder:{" "}
                          <code className="font-mono text-ink">
                            {currentMapping.workspaceRoot ?? currentMapping.t3ProjectTitle}
                          </code>
                        </span>
                      ) : (
                        <span className="text-xs text-ink-3">Not bound to a T3 host</span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {boundHost ? (
                        <>
                          <span className="rounded-md border border-rule bg-paper-2 px-2.5 py-1 font-mono text-xs text-ink">
                            {hostDisplayName(boundHost)}
                          </span>
                          <HostStatusBadge host={boundHost} />
                        </>
                      ) : currentMapping?.hostId ? (
                        <span className="rounded-md border border-rule bg-paper-2 px-2.5 py-1 font-mono text-xs text-ink-3">
                          Host {currentMapping.hostId} (disconnected)
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
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
              Authorize Bitig as an OAuth 2.1 PKCE client against each T3 Code{" "}
              <code className="font-mono">/mcp</code> endpoint in your organisation. Tokens are encrypted with
              AES-256-GCM at rest in D1. Disconnecting a host is refused while sessions run on it.
            </p>
          </div>

          {hasConnectedHost ? (
            hosts.length === 1 && hosts[0] ? (
              <HostStatusBadge host={hosts[0]} />
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-pill border border-accent/30 bg-accent-soft px-3 py-1 text-xs font-semibold text-accent-ink">
                <CheckCircle2 size={13} aria-hidden="true" />
                {String(hosts.length)} hosts connected
              </span>
            )
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-pill border border-rule bg-paper-2 px-3 py-1 text-xs font-medium text-ink-3">
              Not connected
            </span>
          )}
        </div>

        {isLoading ? (
          <p role="status" className="m-0 text-sm text-ink-3">
            Loading T3 Code hosts…
          </p>
        ) : hosts.length === 0 ? (
          <p className="m-0 rounded-md border border-rule bg-paper-2 px-4 py-3 text-xs text-ink-2">
            No T3 Code hosts connected yet. Connect a host below to bind project folders and launch T3 sessions.
          </p>
        ) : (
          <div className="flex flex-col gap-3" aria-label="Connected T3 hosts">
            {hosts.map((host) => {
              const boundProjects = activeProjects.filter((project) => {
                const m = mappings.find((item) => item.projectId === project.id);
                if (!m) return false;
                return m.hostId === host.id || (!m.hostId && hosts.length === 1);
              });
              return (
                <HostCard
                  key={host.id}
                  host={host}
                  boundProjects={boundProjects}
                  isSubmitting={isSubmitting}
                  onReauthorise={handleReauthorise}
                  onDisconnect={handleDisconnectHost}
                  onUpdateHost={handleUpdateHost}
                />
              );
            })}
          </div>
        )}

        <form
          onSubmit={(e) => {
            void handleConnect(e);
          }}
          className="flex flex-col gap-3 border-t border-rule pt-4"
        >
          <h3 className="m-0 font-display text-xs font-bold uppercase tracking-wider text-ink-2">
            {hasConnectedHost ? "Connect another T3 host" : "Connect a T3 host"}
          </h3>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1 sm:col-span-2">
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

            <div className="flex flex-col gap-1">
              <label
                htmlFor="t3-host-label-input"
                className="text-xs font-semibold text-ink-2"
              >
                Host label <span className="font-normal text-ink-3">(optional)</span>
              </label>
              <input
                id="t3-host-label-input"
                type="text"
                placeholder="Laptop or Build server"
                value={labelInput}
                onChange={(e) => {
                  setLabelInput(e.target.value);
                }}
                className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-focus"
              />
            </div>

            <div className="flex flex-col gap-1">
              <label
                htmlFor="t3-host-kind-select"
                className="text-xs font-semibold text-ink-2"
              >
                Host kind
              </label>
              <select
                id="t3-host-kind-select"
                value={kindInput}
                onChange={(e) => {
                  const nextKind = e.target.value as T3HostKind;
                  setKindInput(nextKind);
                  if (!projectsRootEdited) {
                    setProjectsRootInput(defaultT3HostProjectsRoot(nextKind));
                  }
                }}
                className="w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink focus-visible:outline-focus"
              >
                <option value="user">User host (~/www)</option>
                <option value="container">Container (/var/www)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1 sm:col-span-2">
              <label
                htmlFor="t3-host-projects-root-input"
                className="text-xs font-semibold text-ink-2"
              >
                Projects root on host
              </label>
              <input
                id="t3-host-projects-root-input"
                type="text"
                required
                placeholder="~/www"
                value={projectsRootInput}
                onChange={(e) => {
                  setProjectsRootInput(e.target.value);
                  setProjectsRootEdited(true);
                }}
                className="w-full rounded-md border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink focus-visible:outline-focus"
              />
              <span className="text-2xs text-ink-3">
                Default parent folder suggested when creating host-bound projects (<code className="font-mono">&lt;projects root&gt;/&lt;project-slug&gt;</code>).
              </span>
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={isSubmitting || isLoading}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-colors hover:bg-accent-ink disabled:opacity-50"
            >
              <ExternalLink size={14} aria-hidden="true" />
              Connect T3
            </button>
          </div>
        </form>
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
              <code className="font-mono">t3_project_list</code>. To register a new folder on a
              host, create a project or open the project&apos;s T3 panel (owners only). Bitig never edits or clones
              T3 projects, and never creates or deletes files on the host.
            </p>
          </div>

          {hasUsableHost && (
            <button
              type="button"
              onClick={() => {
                void loadRemoteProjectsForHosts(hosts);
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
              const boundHost = resolveHostForMapping(currentMapping);
              const selectId = `t3-project-select-${project.id}`;
              const currentValue = currentMapping
                ? `${boundHost?.id ?? currentMapping.hostId ?? hosts[0]?.id ?? "default"}::${currentMapping.t3ProjectId}`
                : "";
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
                        {boundHost ? ` on ${hostDisplayName(boundHost)}` : ""}
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      id={selectId}
                      aria-label={`T3 project for ${project.name}`}
                      value={currentValue}
                      disabled={savingProjectId === project.id || !hasUsableHost}
                      onChange={(e) => {
                        void handleMappingChange(project.id, e.target.value);
                      }}
                      className="min-w-56 rounded-md border border-rule bg-paper px-3 py-1.5 text-xs text-ink focus-visible:outline-focus disabled:opacity-50"
                    >
                      <option value="">Not mapped</option>
                      {currentMapping &&
                        !hosts.some((h) =>
                          (remoteProjectsByHost[h.id] ?? []).some((rp) => rp.id === currentMapping.t3ProjectId),
                        ) && (
                          <option value={currentValue}>
                            {currentMapping.t3ProjectTitle} ({currentMapping.t3ProjectId})
                          </option>
                        )}
                      {hosts.map((host) => {
                        const hostProjects = remoteProjectsByHost[host.id] ?? [];
                        if (hostProjects.length === 0) return null;
                        return (
                          <optgroup key={host.id} label={hostDisplayName(host)}>
                            {hostProjects.map((remote) => (
                              <option key={`${host.id}::${remote.id}`} value={`${host.id}::${remote.id}`}>
                                {remote.displayName ?? remote.title}
                                {remote.workspaceRoot ? ` \u2014 ${remote.workspaceRoot}` : ""}
                              </option>
                            ))}
                          </optgroup>
                        );
                      })}
                    </select>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

