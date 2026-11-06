import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FolderOpen, Unlink } from "lucide-react";
import {
  HOST_PROJECTS_ROOT_CONTAINER,
  HOST_PROJECTS_ROOT_USER,
  findHostFolderPathIssue,
  hostFolderPathIssueMessage,
  suggestHostFolderPath,
  type Project,
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
}

function describeFailure(err: unknown, fallback: string): string {
  if (err instanceof T3ApiError) return err.message;
  console.error(fallback, err);
  return fallback;
}

/**
 * Owner controls for the project's folder on the connected T3 host (#BIT-148): register an
 * existing folder as the project's T3 project, or unregister it. Bitig never creates or
 * deletes files on the host; T3 keeps the folder when a project is unregistered.
 */
export function ProjectHostFolder({ project, mapping, onMappingChange }: ProjectHostFolderProps) {
  const [path, setPath] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingUnregister, setConfirmingUnregister] = useState(false);
  const [force, setForce] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

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

  async function register() {
    const issue = findHostFolderPathIssue(path);
    if (issue) {
      setError(hostFolderPathIssueMessage(issue));
      return;
    }
    const signal = beginRequest();
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await registerT3HostFolder(project.id, path, signal);
      if (signal.aborted) return;
      setPath("");
      setNotice(result.created ? `Registered ${path} in T3.` : `${path} was already registered in T3; linked it.`);
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

  const inputId = `project-host-folder-${project.id}`;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-rule bg-paper p-2.5">
      {mapping ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-2">
            <span className="inline-flex items-center gap-1.5">
              <FolderOpen size={ICON_SIZE} aria-hidden="true" />
              Linked to T3 project <strong className="font-semibold text-ink">{mapping.t3ProjectTitle}</strong>
            </span>
            {!confirmingUnregister && (
              <button
                type="button"
                onClick={() => {
                  setConfirmingUnregister(true);
                  setNotice(null);
                }}
                disabled={isBusy}
                className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 text-2xs text-ink-2 hover:bg-paper-2 disabled:opacity-50"
              >
                <Unlink size={11} aria-hidden="true" />
                Unregister folder
              </button>
            )}
          </div>
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
                  {isBusy ? "Unregistering…" : "Unregister"}
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
        </div>
      ) : (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void register();
          }}
        >
          <label htmlFor={inputId} className="text-xs font-semibold text-ink-2">
            Folder on T3 host
          </label>
          <div className="flex gap-2">
            <input
              id={inputId}
              type="text"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
              }}
              placeholder={suggestHostFolderPath(HOST_PROJECTS_ROOT_USER, project.name) || "e.g. ~/www/my-project"}
              spellCheck={false}
              autoComplete="off"
              disabled={isBusy}
              className="min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
            />
            <button
              type="submit"
              disabled={isBusy || path === ""}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isBusy ? "Registering…" : "Register"}
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {HOST_FOLDER_ROOTS.map((root) => {
              const suggestion = suggestHostFolderPath(root, project.name);
              if (suggestion === "") return null;
              return (
                <button
                  key={root}
                  type="button"
                  onClick={() => {
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
            The folder must already exist on the host. Bitig registers it with T3 and never creates or deletes files.
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
