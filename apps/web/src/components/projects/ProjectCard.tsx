import { Edit2, FolderKanban, ListTodo, Trash2 } from "lucide-react";
import type { Project, ProjectKind, Task } from "@bitig/core";
import { ResourceLinks } from "./Resources";

interface ProjectCardProps {
  readonly project: Project;
  readonly tasks: Task[];
  readonly onEdit: (project: Project) => void;
  readonly onDelete: (project: Project) => void;
  readonly onSelect: (projectId: string) => void;
  readonly onView?: (project: Project) => void;
}

const KIND_COLORS: Record<ProjectKind, string> = {
  hobby: "bg-paper-3 text-ink-2",
  paid: "bg-ok-soft text-ok",
  open_source: "bg-accent-soft text-accent-ink",
  personal: "bg-paper-3 text-ink",
  internal: "bg-rule-strong text-ink",
};

const ICON_SIZE = 14;

export function ProjectCard({ project, tasks, onEdit, onDelete, onSelect, onView }: ProjectCardProps) {
  const projectTasks = tasks.filter((t) => t.projectId === project.id);
  const doneTasks = projectTasks.filter((t) => t.status === "done");

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

