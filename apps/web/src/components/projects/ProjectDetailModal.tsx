import { useEffect, useRef } from "react";
import {
  Archive,
  ArchiveRestore,
  Edit2,
  FolderKanban,
  Hand,
  KeyRound,
  ListTodo,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import type { Project, ProjectKind, Task } from "@bitig/core";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Markdown } from "../Markdown";
import { ResourceLinks } from "./Resources";

interface ProjectDetailModalProps {
  readonly project: Project | null;
  readonly tasks: readonly Task[];
  readonly onClose: () => void;
  readonly onEdit: (project: Project) => void;
  readonly onDelete: (project: Project) => void;
  readonly onSelectTasks: (projectId: string) => void;
  readonly onArchive?: (project: Project) => void;
  readonly onRecover?: (project: Project) => void;
}

const ICON_SIZE = 16;

const KIND_COLORS: Record<ProjectKind, string> = {
  hobby: "bg-paper-3 text-ink-2",
  paid: "bg-ok-soft text-ok",
  open_source: "bg-accent-soft text-accent-ink",
  personal: "bg-paper-3 text-ink",
  internal: "bg-rule-strong text-ink",
};

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function Field({
  label,
  icon: Icon,
  children,
}: {
  readonly label: string;
  readonly icon?: LucideIcon;
  readonly children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
        {Icon && <Icon size={12} aria-hidden="true" />}
        {label}
      </dt>
      <dd className="m-0 mt-1 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function ProjectDetailModal({
  project,
  tasks,
  onClose,
  onEdit,
  onDelete,
  onSelectTasks,
  onArchive,
  onRecover,
}: ProjectDetailModalProps) {
  const isOpen = project !== null;
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!project) return null;

  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const doneTasks = projectTasks.filter((t) => t.status === "done" || t.status === "archived");
  const openTasks = projectTasks.filter((t) => t.status !== "done" && t.status !== "archived");
  const needsHumanTasks = projectTasks.filter((t) => t.needsHuman !== undefined);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-detail-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-rule bg-paper p-6 shadow-lg outline-none"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-4 pr-6">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span
              className={`rounded-pill px-2.5 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
                KIND_COLORS[project.kind]
              }`}
            >
              {project.kind.replace("_", " ")}
            </span>
            {project.key && (
              <span className="font-mono text-xs font-semibold text-ink-3" title="Key for ticket codes">
                {project.key}
              </span>
            )}
          </div>
          <h2 id="project-detail-title" className="m-0 font-display text-lg font-bold text-ink">
            {project.name}
          </h2>
        </div>

        <div className="mb-5">
          {project.description ? (
            <Markdown content={project.description} />
          ) : (
            <p className="m-0 text-sm text-ink-3">No description</p>
          )}
        </div>

        {project.resources && project.resources.length > 0 && (
          <section aria-labelledby="project-detail-links" className="mb-5">
            <h3
              id="project-detail-links"
              className="m-0 mb-2 text-2xs font-semibold uppercase tracking-wider text-ink-3"
            >
              Links
            </h3>
            <ResourceLinks resources={project.resources} />
          </section>
        )}

        <dl className="m-0 mb-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Tasks" icon={ListTodo}>
            <span>
              <strong className="font-semibold text-ink">{doneTasks.length}</strong> /{" "}
              {projectTasks.length} done ({openTasks.length} open)
            </span>
          </Field>
          <Field label="Key" icon={KeyRound}>
            {project.key ? <span className="font-mono">{project.key}</span> : "—"}
          </Field>
          {needsHumanTasks.length > 0 && (
            <Field label="Needs you" icon={Hand}>
              <span className="font-semibold text-accent-ink">
                {needsHumanTasks.length} {needsHumanTasks.length === 1 ? "task" : "tasks"}
              </span>
            </Field>
          )}
          <Field label="Created">
            <span className="text-xs">{formatTimestamp(project.createdAt)}</span>
          </Field>
          <Field label="Updated">
            <span className="text-xs">{formatTimestamp(project.updatedAt)}</span>
          </Field>
        </dl>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-rule pt-4">
          <button
            type="button"
            onClick={() => {
              onDelete(project);
            }}
            className="mr-auto inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-medium text-danger transition-colors hover:bg-danger-soft"
          >
            <Trash2 size={14} aria-hidden="true" />
            Delete
          </button>
          {project.archived ? (
            onRecover && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onRecover(project);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
              >
                <ArchiveRestore size={14} aria-hidden="true" />
                Recover
              </button>
            )
          ) : (
            onArchive && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onArchive(project);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
              >
                <Archive size={14} aria-hidden="true" />
                Archive
              </button>
            )
          )}
          <button
            type="button"
            onClick={() => {
              onClose();
              onSelectTasks(project.id);
            }}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
          >
            <FolderKanban size={14} aria-hidden="true" />
            View tasks
          </button>
          <button
            type="button"
            onClick={() => {
              onEdit(project);
            }}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90"
          >
            <Edit2 size={14} aria-hidden="true" />
            Edit
          </button>
        </div>
      </div>
    </div>
  );
}

