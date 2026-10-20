import { useState } from "react";
import { Archive, ArrowLeft, FolderPlus, Hand, Plus, Search } from "lucide-react";
import {
  PROJECT_KINDS,
  type CreateProjectInput,
  type Project,
  type ProjectKind,
  type Task,
  type UpdateProjectInput,
} from "@bitig/core";
import { ProjectCard } from "./ProjectCard";
import { ProjectDetailModal } from "./ProjectDetailModal";
import { ProjectModal } from "./ProjectModal";
import { DeleteProjectDialog } from "./DeleteProjectDialog";

interface ProjectsViewProps {
  readonly projects: Project[];
  readonly tasks: Task[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly onCreateProject: (input: CreateProjectInput) => Promise<Project>;
  readonly onUpdateProject: (id: string, patch: UpdateProjectInput) => Promise<Project>;
  readonly onDeleteProject: (id: string) => Promise<void>;
  readonly onSelectProject: (projectId: string) => void;
  readonly searchQuery: string;
  readonly archivedView?: boolean;
  readonly onArchivedViewChange?: (archived: boolean) => void;
}

type ProjectTaskFilter = "" | "open" | "done" | "empty";

const KIND_LABELS: Record<ProjectKind, string> = {
  hobby: "Hobby",
  paid: "Paid",
  open_source: "Open Source",
  personal: "Personal",
  internal: "Internal",
};

const ICON_SIZE = 16;

export function ProjectsView({
  projects,
  tasks,
  isLoading,
  error,
  onCreateProject,
  onUpdateProject,
  onDeleteProject,
  onSelectProject,
  searchQuery,
  archivedView,
  onArchivedViewChange,
}: ProjectsViewProps) {
  const [localArchivedView, setLocalArchivedView] = useState(false);
  const isArchivedView = archivedView ?? localArchivedView;

  function setArchivedView(next: boolean) {
    if (onArchivedViewChange) {
      onArchivedViewChange(next);
    } else {
      setLocalArchivedView(next);
    }
  }

  const [kindFilter, setKindFilter] = useState<ProjectKind | "">("");
  const [taskFilter, setTaskFilter] = useState<ProjectTaskFilter>("");
  const [needsHumanOnly, setNeedsHumanOnly] = useState(false);

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    project: Project | null;
    openKey: number;
  }>({
    isOpen: false,
    project: null,
    openKey: 0,
  });

  function openProjectModal(project: Project | null) {
    setModalState((prev) => ({
      isOpen: true,
      project,
      openKey: prev.openKey + 1,
    }));
  }

  function closeProjectModal() {
    setModalState((prev) => ({
      ...prev,
      isOpen: false,
      project: null,
    }));
  }

  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [viewProjectId, setViewProjectId] = useState<string | null>(null);
  const viewProject = projects.find((p) => p.id === viewProjectId) ?? null;

  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived === true);

  const needsHumanProjectCount = activeProjects.filter((project) =>
    tasks.some((task) => task.projectId === project.id && task.needsHuman !== undefined),
  ).length;

  const hasActiveFilters = Boolean(
    (!isArchivedView && (kindFilter || taskFilter || needsHumanOnly)) || searchQuery,
  );

  const filteredProjects = (isArchivedView ? archivedProjects : activeProjects).filter((p) => {
    if (!isArchivedView) {
      if (kindFilter && p.kind !== kindFilter) {
        return false;
      }

      const projectTasks = tasks.filter((t) => t.projectId === p.id);

      if (needsHumanOnly && !projectTasks.some((t) => t.needsHuman !== undefined)) {
        return false;
      }

      if (taskFilter === "open") {
        if (!projectTasks.some((t) => t.status === "todo" || t.status === "in_progress")) {
          return false;
        }
      } else if (taskFilter === "done") {
        if (projectTasks.length === 0 || !projectTasks.every((t) => t.status === "done" || t.status === "archived")) {
          return false;
        }
      } else if (taskFilter === "empty") {
        if (projectTasks.length > 0) {
          return false;
        }
      }
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    }

    return true;
  });

  function clearFilters() {
    setKindFilter("");
    setTaskFilter("");
    setNeedsHumanOnly(false);
  }

  async function handleModalSubmit(input: CreateProjectInput) {
    if (modalState.project) {
      await onUpdateProject(modalState.project.id, input);
    } else {
      await onCreateProject(input);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold tracking-tight text-ink">
            {isArchivedView ? "Archived Projects" : "Projects"}
          </h1>
          <p className="m-0 text-sm text-ink-2">
            {isArchivedView
              ? "Recover archived workspaces or remove them permanently"
              : "Manage your workspaces and high-level goals"}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start">
          {isArchivedView ? (
            <button
              type="button"
              onClick={() => {
                setArchivedView(false);
              }}
              className="inline-flex items-center gap-2 rounded-md border border-rule bg-paper px-3 py-2 text-sm font-semibold text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              <ArrowLeft size={ICON_SIZE} />
              Back to Projects
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  setArchivedView(true);
                }}
                className="inline-flex items-center gap-2 rounded-md border border-rule bg-paper px-3 py-2 text-sm font-semibold text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
              >
                <Archive size={ICON_SIZE} />
                Archived ({archivedProjects.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  openProjectModal(null);
                }}
                className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 focus-visible:outline-focus"
              >
                <Plus size={ICON_SIZE} />
                New Project
              </button>
            </>
          )}
        </div>
      </div>

      {!isArchivedView && activeProjects.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule bg-paper p-3 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
              <span>Kind:</span>
              <select
                value={kindFilter}
                onChange={(e) => {
                  setKindFilter(e.target.value as ProjectKind | "");
                }}
                className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
              >
                <option value="">All Kinds ({activeProjects.length})</option>
                {PROJECT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
              <span>Tasks:</span>
              <select
                value={taskFilter}
                onChange={(e) => {
                  setTaskFilter(e.target.value as ProjectTaskFilter);
                }}
                className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
              >
                <option value="">All Statuses</option>
                <option value="open">Has open tasks</option>
                <option value="done">All tasks done</option>
                <option value="empty">No tasks</option>
              </select>
            </label>

            <button
              type="button"
              aria-pressed={needsHumanOnly}
              onClick={() => {
                setNeedsHumanOnly(!needsHumanOnly);
              }}
              title="Show only projects with tasks waiting on a person"
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-focus ${
                needsHumanOnly
                  ? "border-accent/30 bg-accent-soft text-accent-ink"
                  : "border-rule bg-paper-2 text-ink-2 hover:text-ink"
              }`}
            >
              <Hand size={14} aria-hidden="true" />
              Needs you ({needsHumanProjectCount})
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-soft p-4 text-sm font-medium text-danger"
        >
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-lg border border-rule bg-paper-2"
            />
          ))}
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-rule bg-paper-2 p-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-paper text-ink-3">
            {hasActiveFilters ? (
              <Search size={24} />
            ) : isArchivedView ? (
              <Archive size={24} />
            ) : (
              <FolderPlus size={24} />
            )}
          </div>
          <h3 className="m-0 mt-4 font-display text-base font-bold text-ink">
            {hasActiveFilters
              ? "No matching projects found"
              : isArchivedView
                ? "No archived projects"
                : "No projects yet"}
          </h3>
          <p className="m-0 mt-1 max-w-sm text-xs text-ink-2">
            {searchQuery
              ? `No projects matched "${searchQuery}". Try a different search term.`
              : hasActiveFilters
                ? "No projects matched the selected filters."
                : isArchivedView
                  ? "Archived projects will appear here so you can recover them anytime."
                  : "Get started by creating your first project to organize your tasks."}
          </p>
          {!hasActiveFilters && !isArchivedView && (
            <button
              type="button"
              onClick={() => {
                openProjectModal(null);
              }}
              className="mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 focus-visible:outline-focus"
            >
              <Plus size={ICON_SIZE} />
              Create your first project
            </button>
          )}
          {!isArchivedView && (kindFilter || taskFilter || needsHumanOnly) && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-rule bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              tasks={tasks}
              onView={(p) => {
                setViewProjectId(p.id);
              }}
              onEdit={(p) => {
                openProjectModal(p);
              }}
              onArchive={(p) => {
                void onUpdateProject(p.id, { archived: true });
              }}
              onRecover={(p) => {
                void onUpdateProject(p.id, { archived: false });
              }}
              onDelete={(p) => {
                setDeleteTarget(p);
              }}
              onSelect={onSelectProject}
            />
          ))}
        </div>
      )}

      <ProjectDetailModal
        project={viewProject}
        tasks={tasks}
        onClose={() => {
          setViewProjectId(null);
        }}
        onEdit={(p) => {
          setViewProjectId(null);
          openProjectModal(p);
        }}
        onArchive={(p) => {
          void onUpdateProject(p.id, { archived: true });
        }}
        onRecover={(p) => {
          void onUpdateProject(p.id, { archived: false });
        }}
        onDelete={(p) => {
          setViewProjectId(null);
          setDeleteTarget(p);
        }}
        onSelectTasks={onSelectProject}
      />

      {/* Keyed so each open remounts the form; its fields are seeded from `project` only on mount. */}
      <ProjectModal
        key={`${modalState.project?.id ?? "new"}-${String(modalState.openKey)}`}
        isOpen={modalState.isOpen}
        project={modalState.project}
        onClose={closeProjectModal}
        onSubmit={handleModalSubmit}
      />

      <DeleteProjectDialog
        isOpen={Boolean(deleteTarget)}
        project={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
        }}
        onConfirm={onDeleteProject}
      />
    </div>
  );
}
