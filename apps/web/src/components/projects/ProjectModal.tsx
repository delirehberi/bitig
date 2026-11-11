import { useState, type SyntheticEvent } from "react";
import {
  HOST_PROJECTS_ROOT_CONTAINER,
  HOST_PROJECTS_ROOT_USER,
  PROJECT_KINDS,
  deriveProjectKey,
  findHostFolderPathIssue,
  hostFolderPathIssueMessage,
  suggestHostFolderPath,
  type CreateProjectInput,
  type HostFolderCheckResult,
  type Project,
  type ProjectKind,
  type T3HostConnectionStatus,
} from "@bitig/core";
import { AlertTriangle, CheckCircle2, FolderKanban, Server, X } from "lucide-react";
import { T3ApiError, checkT3HostFolder } from "../../services/t3";
import { toResources, type ResourceDraft } from "./resource-drafts";
import { ResourcesEditor } from "./Resources";

export interface ProjectModalSubmitExtras {
  /** Existing folder on the connected T3 host to register for the new project (#BIT-148). */
  readonly hostFolderPath?: string;
  /** Selected T3 host ID when binding the new project to a specific host (#BIT-152). */
  readonly hostId?: string;
}

interface ProjectModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateProjectInput, extras?: ProjectModalSubmitExtras) => Promise<void>;
  readonly project?: Project | null;
  /**
   * Shows the optional host folder field when creating a project. Set only for an organisation
   * owner with a connected T3 host.
   */
  readonly hostFolderEnabled?: boolean;
  /** Connected T3 hosts available in the organisation (#BIT-152). */
  readonly hosts?: readonly T3HostConnectionStatus[] | undefined;
  /** True while connected T3 hosts are being loaded (#BIT-152). */
  readonly isHostsLoading?: boolean | undefined;
}

const HOST_FOLDER_ROOTS = [HOST_PROJECTS_ROOT_USER, HOST_PROJECTS_ROOT_CONTAINER] as const;

const ICON_SIZE = 16;

const KIND_LABELS: Record<ProjectKind, string> = {
  hobby: "Hobby",
  paid: "Paid",
  open_source: "Open Source",
  personal: "Personal",
  internal: "Internal",
};

function formatHostOptionLabel(host: T3HostConnectionStatus): string {
  const title = host.label?.trim() ? host.label.trim() : host.mcpUrl || host.id;
  return `${title} (${host.projectsRoot})`;
}

export function ProjectModal({
  isOpen,
  onClose,
  onSubmit,
  project,
  hostFolderEnabled = false,
  hosts,
  isHostsLoading = false,
}: ProjectModalProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [kind, setKind] = useState<ProjectKind>(project?.kind ?? "hobby");
  // Empty means "derive from the name" for a new project and "keep" for one without a key yet.
  const [key, setKey] = useState(project?.key ?? "");
  const [resources, setResources] = useState<ResourceDraft[]>(
    () => project?.resources?.map((resource) => ({ ...resource })) ?? [],
  );
  const [selectedHostId, setSelectedHostId] = useState<string>(() => hosts?.[0]?.id ?? "");
  const [hostFolderPath, setHostFolderPath] = useState("");
  const [folderEdited, setFolderEdited] = useState(false);
  const [isCheckingFolder, setIsCheckingFolder] = useState(false);
  const [folderCheck, setFolderCheck] = useState<HostFolderCheckResult | null>(null);
  const [folderCheckError, setFolderCheckError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const isEditing = Boolean(project);
  const showHostFolder = hostFolderEnabled && !isEditing;
  const hasHostList = hosts !== undefined && hosts.length > 0;
  const effectiveHostId =
    hasHostList && selectedHostId === "" ? (hosts[0]?.id ?? "") : selectedHostId;
  const selectedHost = hasHostList
    ? (hosts.find((h) => h.id === effectiveHostId) ?? hosts[0])
    : undefined;

  const displayedFolderPath =
    showHostFolder && selectedHost && !folderEdited
      ? suggestHostFolderPath(selectedHost.projectsRoot, name)
      : hostFolderPath;

  async function handleCheckFolder() {
    const folder = displayedFolderPath.trim();
    if (!folder) return;
    const issue = findHostFolderPathIssue(folder);
    if (issue) {
      setFolderCheckError(hostFolderPathIssueMessage(issue));
      setFolderCheck(null);
      return;
    }
    setIsCheckingFolder(true);
    setFolderCheckError(null);
    setFolderCheck(null);
    try {
      const hostArg =
        selectedHost && selectedHost.id !== "default" ? selectedHost.id : undefined;
      const res = await checkT3HostFolder(folder, undefined, hostArg);
      setFolderCheck(res);
    } catch (err: unknown) {
      setFolderCheckError(
        err instanceof T3ApiError ? err.message : "Could not check the folder on the T3 host.",
      );
    } finally {
      setIsCheckingFolder(false);
    }
  }

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Project name is required");
      return;
    }

    const links = toResources(resources);
    if (!links.ok) {
      setError(links.error);
      return;
    }

    // Empty means "no folder": the project can be linked to T3 later from its T3 panel.
    const folder = showHostFolder ? displayedFolderPath : "";
    if (folder !== "") {
      const issue = findHostFolderPathIssue(folder);
      if (issue) {
        setError(hostFolderPathIssueMessage(issue));
        return;
      }
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const input: CreateProjectInput = {
        name: name.trim(),
        description: description.trim(),
        kind,
        ...(key.trim() !== "" && key.trim().toUpperCase() !== project?.key ? { key: key.trim() } : {}),
        // When editing, an empty list is sent so removing every link clears them.
        ...(links.resources.length > 0 || isEditing ? { resources: links.resources } : {}),
      };
      const hostIdToPass =
        selectedHost && selectedHost.id !== "default" ? selectedHost.id : undefined;
      await (folder !== ""
        ? onSubmit(input, {
            hostFolderPath: folder,
            ...(hostIdToPass ? { hostId: hostIdToPass } : {}),
          })
        : onSubmit(input));
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save project");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-modal-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <FolderKanban size={18} />
          </div>
          <div>
            <h2 id="project-modal-title" className="m-0 font-display text-lg font-bold text-ink">
              {isEditing ? "Edit Project" : "New Project"}
            </h2>
            <p className="m-0 text-xs text-ink-3">Every task belongs to a project</p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
          >
            {error}
          </div>
        )}

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
          <div>
            <label htmlFor="project-name" className="block text-xs font-semibold text-ink-2">
              Project Name <span className="text-danger">*</span>
            </label>
            <input
              id="project-name"
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setFolderCheck(null);
                setFolderCheckError(null);
              }}
              placeholder="e.g. Website Redesign"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
          </div>

          <div>
            <label htmlFor="project-key" className="block text-xs font-semibold text-ink-2">
              Key
            </label>
            <input
              id="project-key"
              type="text"
              value={key}
              onChange={(e) => {
                setKey(e.target.value.toUpperCase());
              }}
              placeholder={name.trim() === "" ? "e.g. BIT" : deriveProjectKey(name, [])}
              maxLength={10}
              aria-describedby="project-key-hint"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm uppercase text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
            <p id="project-key-hint" className="m-0 mt-1 text-xs text-ink-3">
              {!isEditing
                ? "Tasks are named KEY-1, KEY-2\u2026 Leave empty to use the first letters of the name."
                : project?.key
                  ? `Tasks are named ${project.key}-1, ${project.key}-2\u2026 Changing the key renames them all.`
                  : "No key yet. The ticket-code backfill gives this project a key and numbers its tasks."}
            </p>
          </div>

          <div>
            <label htmlFor="project-kind" className="block text-xs font-semibold text-ink-2">
              Kind
            </label>
            <select
              id="project-kind"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as ProjectKind);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
              disabled={isSubmitting}
            >
              {PROJECT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="project-description" className="block text-xs font-semibold text-ink-2">
              Description
            </label>
            <textarea
              id="project-description"
              rows={3}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="Brief description of the project goals"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
          </div>

          {showHostFolder && (
            <div className="flex flex-col gap-3 rounded-md border border-rule bg-paper-2 p-3">
              {isHostsLoading && (
                <p role="status" className="m-0 text-xs text-ink-3">
                  Loading T3 hosts…
                </p>
              )}

              {hasHostList && (
                <div>
                  <label htmlFor="project-t3-host" className="flex items-center gap-1.5 text-xs font-semibold text-ink-2">
                    <Server size={13} aria-hidden="true" className="text-accent-ink" />
                    T3 host
                  </label>
                  <select
                    id="project-t3-host"
                    value={effectiveHostId}
                    onChange={(e) => {
                      const nextId = e.target.value;
                      setSelectedHostId(nextId);
                      setFolderCheck(null);
                      setFolderCheckError(null);
                    }}
                    disabled={isSubmitting}
                    className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 text-xs text-ink focus-visible:outline-focus"
                  >
                    {hosts.map((host) => (
                      <option key={host.id} value={host.id}>
                        {formatHostOptionLabel(host)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {selectedHost?.expired && (
                <div
                  role="alert"
                  className="flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-xs text-danger"
                >
                  <AlertTriangle size={13} aria-hidden="true" />
                  <span>
                    OAuth token for this host has expired. Reauthorise it in Settings before registering a folder.
                  </span>
                </div>
              )}

              <div>
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="project-host-folder" className="block text-xs font-semibold text-ink-2">
                    Folder on T3 host
                  </label>
                  {displayedFolderPath.trim() !== "" && (
                    <button
                      type="button"
                      onClick={() => {
                        void handleCheckFolder();
                      }}
                      disabled={isSubmitting || isCheckingFolder}
                      className="rounded-sm border border-rule bg-paper px-2 py-0.5 text-2xs font-semibold text-ink-2 hover:bg-paper-3 disabled:opacity-50"
                    >
                      {isCheckingFolder ? "Checking\u2026" : "Check folder"}
                    </button>
                  )}
                </div>
                <input
                  id="project-host-folder"
                  type="text"
                  value={displayedFolderPath}
                  onChange={(e) => {
                    setFolderEdited(true);
                    setHostFolderPath(e.target.value);
                    setFolderCheck(null);
                    setFolderCheckError(null);
                  }}
                  placeholder={
                    suggestHostFolderPath(
                      selectedHost?.projectsRoot ?? HOST_PROJECTS_ROOT_USER,
                      name,
                    ) || "e.g. ~/www/website-redesign"
                  }
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby="project-host-folder-hint"
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  disabled={isSubmitting}
                />
                {name.trim() !== "" && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {(selectedHost
                      ? Array.from(new Set([selectedHost.projectsRoot, ...HOST_FOLDER_ROOTS]))
                      : HOST_FOLDER_ROOTS
                    ).map((root) => {
                      const suggestion = suggestHostFolderPath(root, name);
                      if (suggestion === "") return null;
                      return (
                        <button
                          key={root}
                          type="button"
                          onClick={() => {
                            setFolderEdited(true);
                            setHostFolderPath(suggestion);
                            setFolderCheck(null);
                            setFolderCheckError(null);
                          }}
                          disabled={isSubmitting}
                          className="rounded-sm border border-rule bg-paper px-2 py-0.5 font-mono text-xs text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink"
                        >
                          {suggestion}
                        </button>
                      );
                    })}
                  </div>
                )}

                {folderCheckError && (
                  <div
                    role="alert"
                    className="mt-2 flex items-start gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-1.5 text-xs text-danger"
                  >
                    <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span>{folderCheckError}</span>
                  </div>
                )}

                {folderCheck && (
                  <div
                    role={folderCheck.mappedProjectId ? "alert" : "status"}
                    className={`mt-2 flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs ${
                      folderCheck.mappedProjectId
                        ? "border-danger/30 bg-danger-soft text-danger"
                        : "border-accent/30 bg-accent-soft text-accent-ink"
                    }`}
                  >
                    {folderCheck.mappedProjectId ? (
                      <>
                        <AlertTriangle size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                        <span>
                          This folder is already registered in T3 and bound to another Bitig project. Choose a different folder or detach the other project first.
                        </span>
                      </>
                    ) : folderCheck.t3Project ? (
                      <>
                        <CheckCircle2 size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                        <span>
                          Already registered in T3 as <strong>{folderCheck.t3Project.title}</strong>; creating the project will link to it.
                        </span>
                      </>
                    ) : (
                      <>
                        <CheckCircle2 size={13} aria-hidden="true" className="mt-0.5 shrink-0" />
                        <span>Folder is available to register on the selected host.</span>
                      </>
                    )}
                  </div>
                )}

                <p id="project-host-folder-hint" className="m-0 mt-1.5 text-xs text-ink-3">
                  The repository must already be cloned at an existing folder on the host ({HOST_PROJECTS_ROOT_USER} on
                  your own host, {HOST_PROJECTS_ROOT_CONTAINER} on containers; Git cloning from the web UI is deferred).
                  Bitig registers the folder with T3 and never creates or deletes files. Leave empty to link it later.
                </p>
              </div>
            </div>
          )}

          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-1 block text-xs font-semibold text-ink-2">Links</legend>
            <ResourcesEditor items={resources} onChange={setResources} disabled={isSubmitting} />
          </fieldset>

          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? "Saving\u2026" : isEditing ? "Save Changes" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
