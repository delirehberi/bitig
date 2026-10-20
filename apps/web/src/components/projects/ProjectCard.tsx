import { Archive, ArchiveRestore, Edit2, FolderKanban, ListTodo, Trash2 } from "lucide-react";
import type { Project, ProjectKind, Task } from "@bitig/core";
import { ResourceLinks } from "./Resources";

interface ProjectCardProps {
  readonly project: Project;
  readonly tasks: Task[];
  readonly onEdit: (project: Project) => void;
  readonly onDelete: (project: Project) => void;
  readonly onSelect: (projectId: string) => void;
  readonly onView?: (project: Project) => void;
  readonly onArchive?: (project: Project) => void;
  readonly onRecover?: (project: Project) => void;
}

const KIND_COLORS: Record<ProjectKind, string> = {
  hobby: "bg-paper-3 text-ink-2",
  paid: "bg-ok-soft text-ok",
  open_source: "bg-accent-soft text-accent-ink",
  personal: "bg-paper-3 text-ink",
  internal: "bg-rule-strong text-ink",
};

const ICON_SIZE = 14;

export function ProjectCard({
  project,
  tasks,
  onEdit,
  onDelete,
  onSelect,
  onView,
  onArchive,
  onRecover,
}: ProjectCardProps) {
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const doneTasks = projectTasks.filter((t) => t.status === "done" || t.status === "archived");
  const isArchived = project.archived === true;

  if (isArchived) {
    return (
      <article className="group flex w-4/5 flex-col justify-between rounded-lg border border-rule/60 bg-paper px-3.5 py-2.5 opacity-80 transition-all hover:w-full hover:border-rule-strong hover:p-4 hover:opacity-100 hover:shadow-xs">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={`shrink-0 rounded-pill px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
                KIND_COLORS[project.kind]
              }`}
            >
              {project.kind.replace("_", " ")}
            </span>
            {project.key && (
              <span className="shrink-0 font-mono text-2xs font-semibold text-ink-3" title="Key for ticket codes">
                {project.key}
              </span>
            )}
            <h3 className="m-0 truncate font-display text-sm font-bold text-ink">
              <button
                type="button"
                onClick={() => {
                  onView?.(project);
                }}
                title="View project details"
                className="cursor-pointer truncate text-left font-[inherit] text-[inherit] hover:underline focus-visible:outline-focus"
              >
                {project.name}
              </button>
            </h3>
          </div>

          <div className="flex shrink-0 items-center gap-1 opacity-80 transition-opacity group-hover:opacity-100">
            {onRecover && (
              <button
                type="button"
                onClick={() => {
                  onRecover(project);
                }}
                title="Recover project"
                aria-label={`Recover ${project.name}`}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper-2 px-2 py-1 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus"
              >
                <ArchiveRestore size={ICON_SIZE} />
                <span>Recover</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onDelete(project);
              }}
              title="Delete project"
              aria-label={`Delete ${project.name}`}
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </div>
        </div>

        <div className="mt-2 hidden items-center justify-between border-t border-rule pt-2 text-2xs text-ink-3 group-hover:flex">
          <div className="flex items-center gap-1">
            <ListTodo size={12} />
            <span>
              <strong className="font-semibold text-ink">{doneTasks.length}</strong> / {projectTasks.length} tasks
            </span>
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect(project.id);
            }}
            className="flex items-center gap-1 text-2xs font-semibold text-accent-ink hover:underline focus-visible:outline-focus"
          >
            <FolderKanban size={12} />
            View tasks
          </button>
        </div>
      </article>
    );
  }

  return (
    <article className="flex flex-col justify-between rounded-lg border border-rule bg-paper p-5 transition-all hover:border-rule-strong hover:shadow-xs">
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span
              className={`rounded-pill px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
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
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onEdit(project);
              }}
              title="Edit project"
              aria-label={`Edit ${project.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              <Edit2 size={ICON_SIZE} />
            </button>
            {onArchive && (
              <button
                type="button"
                onClick={() => {
                  onArchive(project);
                }}
                title="Archive project"
                aria-label={`Archive ${project.name}`}
                className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
              >
                <Archive size={ICON_SIZE} />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                onDelete(project);
              }}
              title="Delete project"
              aria-label={`Delete ${project.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </div>
        </div>

        <h3 className="m-0 mt-3 font-display text-base font-bold text-ink">
          <button
            type="button"
            onClick={() => {
              onView?.(project);
            }}
            title="View project details"
            className="cursor-pointer text-left font-[inherit] text-[inherit] hover:underline focus-visible:outline-focus"
          >
            {project.name}
          </button>
        </h3>
        {project.description ? (
          <p className="m-0 mt-1 line-clamp-2 text-xs text-ink-2">{project.description}</p>
        ) : (
          <p className="m-0 mt-1 text-xs italic text-ink-3">No description</p>
        )}
        <ResourceLinks resources={project.resources} />
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-rule pt-3">
        <div className="flex items-center gap-1.5 text-xs text-ink-3">
          <ListTodo size={ICON_SIZE} />
          <span>
            <strong className="text-ink font-semibold">{doneTasks.length}</strong> / {projectTasks.length} tasks
          </span>
        </div>

        <button
          type="button"
          onClick={() => {
            onSelect(project.id);
          }}
          className="flex items-center gap-1 text-xs font-semibold text-accent-ink hover:underline focus-visible:outline-focus"
        >
          <FolderKanban size={ICON_SIZE} />
          View tasks
        </button>
      </div>
    </article>
  );
}

