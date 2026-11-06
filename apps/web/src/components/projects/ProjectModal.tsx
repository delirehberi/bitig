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
  type Project,
  type ProjectKind,
} from "@bitig/core";
import { FolderKanban, X } from "lucide-react";
import { toResources, type ResourceDraft } from "./resource-drafts";
import { ResourcesEditor } from "./Resources";

export interface ProjectModalSubmitExtras {
  /** Existing folder on the connected T3 host to register for the new project (#BIT-148). */
  readonly hostFolderPath?: string;
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

export function ProjectModal({ isOpen, onClose, onSubmit, project, hostFolderEnabled = false }: ProjectModalProps) {
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [kind, setKind] = useState<ProjectKind>(project?.kind ?? "hobby");
  // Empty means "derive from the name" for a new project and "keep" for one without a key yet.
  const [key, setKey] = useState(project?.key ?? "");
  const [resources, setResources] = useState<ResourceDraft[]>(
    () => project?.resources?.map((resource) => ({ ...resource })) ?? [],
  );
  const [hostFolderPath, setHostFolderPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  const isEditing = Boolean(project);
  const showHostFolder = hostFolderEnabled && !isEditing;

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
    const folder = showHostFolder ? hostFolderPath : "";
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
      await (folder !== "" ? onSubmit(input, { hostFolderPath: folder }) : onSubmit(input));
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
                ? "Tasks are named KEY-1, KEY-2… Leave empty to use the first letters of the name."
                : project?.key
                  ? `Tasks are named ${project.key}-1, ${project.key}-2… Changing the key renames them all.`
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
            <div>
              <label htmlFor="project-host-folder" className="block text-xs font-semibold text-ink-2">
                Folder on T3 host
              </label>
              <input
                id="project-host-folder"
                type="text"
                value={hostFolderPath}
                onChange={(e) => {
                  setHostFolderPath(e.target.value);
                }}
                placeholder={suggestHostFolderPath(HOST_PROJECTS_ROOT_USER, name) || "e.g. ~/www/website-redesign"}
                spellCheck={false}
                autoComplete="off"
                aria-describedby="project-host-folder-hint"
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                disabled={isSubmitting}
              />
              {name.trim() !== "" && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {HOST_FOLDER_ROOTS.map((root) => {
                    const suggestion = suggestHostFolderPath(root, name);
                    if (suggestion === "") return null;
                    return (
                      <button
                        key={root}
                        type="button"
                        onClick={() => {
                          setHostFolderPath(suggestion);
                        }}
                        disabled={isSubmitting}
                        className="rounded-sm border border-rule px-2 py-0.5 font-mono text-xs text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
                      >
                        {suggestion}
                      </button>
                    );
                  })}
                </div>
              )}
              <p id="project-host-folder-hint" className="m-0 mt-1 text-xs text-ink-3">
                An existing folder on the host, as an absolute or ~/ path ({HOST_PROJECTS_ROOT_USER} on
                your own host, {HOST_PROJECTS_ROOT_CONTAINER} on containers). Bitig registers it with T3
                and never creates or deletes files. Leave empty to link it later.
              </p>
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
              {isSubmitting ? "Saving…" : isEditing ? "Save Changes" : "Create Project"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
