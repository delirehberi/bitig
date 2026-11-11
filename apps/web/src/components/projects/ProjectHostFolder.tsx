import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowRightLeft, FolderOpen, Server, Unlink } from "lucide-react";
import {
  HOST_PROJECTS_ROOT_CONTAINER,
  HOST_PROJECTS_ROOT_USER,
  findHostFolderPathIssue,
  hostFolderPathIssueMessage,
  suggestHostFolderPath,
  type Project,
  type T3HostConnectionStatus,
  type T3ProjectMapping,
} from "@bitig/core";
import { T3ApiError, registerT3HostFolder, unregisterT3HostFolder } from "../../services/t3";

const ICON_SIZE = 12;
const HOST_FOLDER_ROOTS = [HOST_PROJECTS_ROOT_USER, HOST_PROJECTS_ROOT_CONTAINER] as const;

interface ProjectHostFolderProps {
  readonly project: Project;
  readonly mapping: T3ProjectMapping | undefined;
  /** Called with the new link after registering, or `undefined` after unregistering. */
  readonly onMappingChange: (mapping: T3ProjectMapping | undefined) => void;
  /** Connected T3 hosts in the organisation (#BIT-152). */
  readonly hosts?: readonly T3HostConnectionStatus[] | undefined;
  /** Count of active T3 sessions running on this project (#BIT-152). Blocks detach/reattach while > 0. */
  readonly activeSessionsCount?: number | undefined;
}

function describeFailure(err: unknown, fallback: string): string {
  if (err instanceof T3ApiError) return err.message;
  console.error(fallback, err);
  return fallback;
}

function formatHostName(host: Pick<T3HostConnectionStatus, "id" | "label" | "mcpUrl">): string {
  return host.label?.trim() ? host.label.trim() : host.mcpUrl || host.id;
}

/**
 * Owner controls for the project's folder on a connected T3 host (#BIT-148, #BIT-152): register
 * an existing folder as the project's T3 project, detach/unregister it (blocked while sessions
 * run), or reattach it on another host. Bitig never creates or deletes files on the host.
 */
export function ProjectHostFolder({
  project,
  mapping,
  onMappingChange,
  hosts,
  activeSessionsCount = 0,
}: ProjectHostFolderProps) {
  const hasHostList = hosts !== undefined && hosts.length > 0;
  const [selectedHostId, setSelectedHostId] = useState<string>(() => hosts?.[0]?.id ?? "");
  const [path, setPath] = useState("");
  const [pathEdited, setPathEdited] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingUnregister, setConfirmingUnregister] = useState(false);
  const [isReattaching, setIsReattaching] = useState(false);
  const [force, setForce] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const hasActiveSessions = activeSessionsCount > 0;

  // Cancels an in-flight request when the panel closes.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  function beginRequest(): AbortSignal {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    return controller.signal;
  }

  const effectiveHostId =
    hasHostList && selectedHostId === "" ? (hosts[0]?.id ?? "") : selectedHostId;
  const selectedHost = hasHostList
    ? (hosts.find((h) => h.id === effectiveHostId) ?? hosts[0])
    : undefined;

  const displayedPath =
    hasHostList && selectedHost && !pathEdited
      ? suggestHostFolderPath(selectedHost.projectsRoot, project.name)
      : path;

  const boundHost = mapping
    ? mapping.hostId
      ? hosts?.find((h) => h.id === mapping.hostId)
      : hosts?.length === 1
        ? hosts[0]
        : undefined
    : undefined;

  async function register() {
    const targetPath = displayedPath;
    const issue = findHostFolderPathIssue(targetPath);
    if (issue) {
      setError(hostFolderPathIssueMessage(issue));
      return;
    }
    const signal = beginRequest();
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const hostIdToPass =
        selectedHost && selectedHost.id !== "default" ? selectedHost.id : undefined;
      const result = hostIdToPass
        ? await registerT3HostFolder(project.id, targetPath, signal, hostIdToPass)
        : await registerT3HostFolder(project.id, targetPath, signal);
      if (signal.aborted) return;
      setPath("");
      setPathEdited(false);
      setIsReattaching(false);
      setNotice(
        result.created
          ? `Registered ${targetPath} in T3.`
          : `${targetPath} was already registered in T3; linked it.`,
      );
      onMappingChange(result.mapping);
    } catch (err: unknown) {
      if (signal.aborted) return;
      setError(describeFailure(err, "Could not register the folder in T3."));
    } finally {
      if (!signal.aborted) setIsBusy(false);
    }
  }

  async function unregister() {
    const signal = beginRequest();
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unregisterT3HostFolder(project.id, { force, signal });
      if (signal.aborted) return;
      setConfirmingUnregister(false);
      setForce(false);
      setNotice("Unregistered from T3. The folder is still on the host.");
      onMappingChange(undefined);
    } catch (err: unknown) {
      if (signal.aborted) return;
      setError(describeFailure(err, "Could not unregister the folder in T3."));
    } finally {
      if (!signal.aborted) setIsBusy(false);
    }
  }

  function startReattach() {
    const otherHost =
      hosts?.find((h) => h.id !== (boundHost?.id ?? mapping?.hostId)) ?? hosts?.[0];
    if (otherHost) {
      setSelectedHostId(otherHost.id);
    }
    setPathEdited(false);
    setPath("");
    setConfirmingUnregister(false);
    setError(null);
    setNotice(null);
    setIsReattaching(true);
  }

  const inputId = `project-host-folder-${project.id}`;
  const hostSelectId = `project-host-select-${project.id}`;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule bg-paper p-2.5">
      {mapping ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <FolderOpen size={ICON_SIZE} aria-hidden="true" />
              <span>
                Linked to T3 project <strong className="font-semibold text-ink">{mapping.t3ProjectTitle}</strong>
              </span>
              {(boundHost ?? mapping.hostId) && (
                <span
                  data-testid="project-bound-host-badge"
                  className="inline-flex items-center gap-1 rounded-xs border border-rule bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink"
                >
                  <Server size={10} aria-hidden="true" />
                  {boundHost ? formatHostName(boundHost) : mapping.hostId}
                </span>
              )}
              {mapping.workspaceRoot && (
                <code className="rounded-xs bg-paper-2 px-1.5 py-0.5 font-mono text-2xs text-ink-2">
                  {mapping.workspaceRoot}
                </code>
              )}
            </div>
            {!confirmingUnregister && !isReattaching && (
              <div className="flex flex-wrap items-center gap-1.5">
                {hasHostList && (
                  <button
                    type="button"
                    onClick={() => {
                      startReattach();
                    }}
                    disabled={isBusy || hasActiveSessions}
                    className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <ArrowRightLeft size={11} aria-hidden="true" />
                    Reattach on another host
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingUnregister(true);
                    setIsReattaching(false);
                    setNotice(null);
                  }}
                  disabled={isBusy || hasActiveSessions}
                  className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Unlink size={11} aria-hidden="true" />
                  Unregister folder
                </button>
              </div>
            )}
          </div>

          {hasActiveSessions && (
            <p
              data-testid="project-host-busy-notice"
              className="m-0 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-2xs text-ink-2"
            >
              Cannot detach or change host while {String(activeSessionsCount)} T3{" "}
              {activeSessionsCount === 1 ? "session is" : "sessions are"} running on this project.
            </p>
          )}

          {confirmingUnregister && (
            <div className="flex flex-col gap-2 rounded-md border border-rule bg-paper-2 p-2 text-xs text-ink-2">
              <p className="m-0">
                Remove &ldquo;{mapping.t3ProjectTitle}&rdquo; from T3 and unlink it from this project? The folder and its
                files stay on the host.
              </p>
              <label className="inline-flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={force}
                  disabled={isBusy}
                  onChange={(e) => {
                    setForce(e.target.checked);
                  }}
                />
                <span>Also remove it if it still has T3 threads (T3 may drop their history)</span>
              </label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    void unregister();
                  }}
                  disabled={isBusy}
                  className="rounded-md bg-danger px-2.5 py-1 text-2xs font-semibold text-paper disabled:opacity-50"
                >
                  {isBusy ? "Unregistering\u2026" : "Unregister"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingUnregister(false);
                    setForce(false);
                  }}
                  disabled={isBusy}
                  className="rounded-md border border-rule px-2.5 py-1 text-2xs text-ink-2 hover:bg-paper-3"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {isReattaching && (
            <form
              className="flex flex-col gap-2 rounded-md border border-rule bg-paper-2 p-2.5"
              onSubmit={(e) => {
                e.preventDefault();
                void register();
              }}
            >
              {hasHostList && (
                <div className="flex flex-col gap-1">
                  <label htmlFor={hostSelectId} className="text-2xs font-semibold text-ink-2">
                    Target T3 host
                  </label>
                  <select
                    id={hostSelectId}
                    value={effectiveHostId}
                    onChange={(e) => {
                      setSelectedHostId(e.target.value);
                      setError(null);
                    }}
                    disabled={isBusy}
                    className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs text-ink focus-visible:outline-focus"
                  >
                    {hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {formatHostName(host)} ({host.projectsRoot})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex flex-col gap-1">
                <label htmlFor={inputId} className="text-2xs font-semibold text-ink-2">
                  Folder on target host
                </label>
                <div className="flex gap-2">
                  <input
                    id={inputId}
                    type="text"
                    value={displayedPath}
                    onChange={(e) => {
                      setPathEdited(true);
                      setPath(e.target.value);
                    }}
                    placeholder={
                      suggestHostFolderPath(
                        selectedHost?.projectsRoot ?? HOST_PROJECTS_ROOT_USER,
                        project.name,
                      ) || "e.g. ~/www/my-project"
                    }
                    spellCheck={false}
                    autoComplete="off"
                    disabled={isBusy}
                    className="min-w-0 flex-1 rounded-md border border-rule bg-paper px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  />
                  <button
                    type="submit"
                    disabled={isBusy || displayedPath === ""}
                    className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isBusy ? "Reattaching\u2026" : "Reattach"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setIsReattaching(false);
                      setError(null);
                    }}
                    disabled={isBusy}
                    className="rounded-md border border-rule bg-paper px-2.5 py-1.5 text-xs text-ink-2 hover:bg-paper-3"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <p className="m-0 text-2xs text-ink-3">
                The repository must already be cloned at this folder on the target host (Git cloning UI is deferred).
              </p>
            </form>
          )}
        </div>
      ) : (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void register();
          }}
        >
          {hasHostList && (
            <div className="flex flex-col gap-1">
              <label htmlFor={hostSelectId} className="text-xs font-semibold text-ink-2">
                T3 host
              </label>
              <select
                id={hostSelectId}
                value={effectiveHostId}
                onChange={(e) => {
                  setSelectedHostId(e.target.value);
                  setError(null);
                }}
                disabled={isBusy}
                className="rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs text-ink focus-visible:outline-focus"
              >
                {hosts.map((host) => (
                  <option key={host.id} value={host.id}>
                    {formatHostName(host)} ({host.projectsRoot})
                  </option>
                ))}
              </select>
            </div>
          )}

          <label htmlFor={inputId} className="text-xs font-semibold text-ink-2">
            Folder on T3 host
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="text"
              value={displayedPath}
              onChange={(e) => {
                setPathEdited(true);
                setPath(e.target.value);
              }}
              placeholder={
                suggestHostFolderPath(
                  selectedHost?.projectsRoot ?? HOST_PROJECTS_ROOT_USER,
                  project.name,
                ) || "e.g. ~/www/my-project"
              }
              spellCheck={false}
              autoComplete="off"
              disabled={isBusy}
              className="min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
            />
            <button
              type="submit"
              disabled={isBusy || displayedPath === ""}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? "Registering\u2026" : "Register"}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {(selectedHost
              ? Array.from(new Set([selectedHost.projectsRoot, ...HOST_FOLDER_ROOTS]))
              : HOST_FOLDER_ROOTS
            ).map((root) => {
              const suggestion = suggestHostFolderPath(root, project.name);
              if (suggestion === "") return null;
              return (
                <button
                  key={root}
                  type="button"
                  onClick={() => {
                    setPathEdited(true);
                    setPath(suggestion);
                  }}
                  disabled={isBusy}
                  className="rounded-sm border border-rule px-2 py-0.5 font-mono text-2xs text-ink-2 hover:bg-paper-2"
                >
                  {suggestion}
                </button>
              );
            })}
          </div>
          <p className="m-0 text-2xs text-ink-3">
            The repository must already be cloned at this existing folder on the host (Git cloning UI is deferred).
            Bitig registers it with T3 and never creates or deletes files.
          </p>
        </form>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-xs text-danger"
        >
          <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && (
        <p role="status" className="m-0 text-xs text-ink-2">
          {notice}
        </p>
      )}
    </div>
  );
}
