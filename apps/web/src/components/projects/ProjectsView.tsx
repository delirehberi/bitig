import { useState } from "react";
import { FolderPlus, Plus, Search } from "lucide-react";
import type { CreateProjectInput, Project, Task, UpdateProjectInput } from "@bitig/core";
import { ProjectCard } from "./ProjectCard";
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
}

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
}: ProjectsViewProps) {
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

  const filteredProjects = projects.filter((p) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
  });

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
          <h1 className="m-0 font-display text-2xl font-bold tracking-tight text-ink">Projects</h1>
          <p className="m-0 text-sm text-ink-2">Manage your workspaces and high-level goals</p>
        </div>

        <button
          type="button"
          onClick={() => {
            openProjectModal(null);
          }}
          className="inline-flex items-center gap-2 self-start rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 focus-visible:outline-focus"
        >
          <Plus size={ICON_SIZE} />
          New Project
        </button>
      </div>

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
            {searchQuery ? <Search size={24} /> : <FolderPlus size={24} />}
          </div>
          <h3 className="m-0 mt-4 font-display text-base font-bold text-ink">
            {searchQuery ? "No matching projects found" : "No projects yet"}
          </h3>
          <p className="m-0 mt-1 max-w-sm text-xs text-ink-2">
            {searchQuery
              ? `No projects matched "${searchQuery}". Try a different search term.`
              : "Get started by creating your first project to organize your tasks."}
          </p>
          {!searchQuery && (
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
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              tasks={tasks}
              onEdit={(p) => {
                openProjectModal(p);
              }}
              onDelete={(p) => {
                setDeleteTarget(p);
              }}
              onSelect={onSelectProject}
            />
          ))}
        </div>
      )}

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

