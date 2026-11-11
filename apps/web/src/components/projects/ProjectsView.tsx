import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowLeft, FolderPlus, Hand, Plus, RefreshCw, Search, X } from "lucide-react";
import {
  PROJECT_KINDS,
  type AgentRun,
  type CreateProjectInput,
  type Project,
  type ProjectKind,
  type T3HostConnectionStatus,
  type T3ProjectActiveSession,
  type T3ProjectMapping,
  type Task,
  type UpdateProjectInput,
} from "@bitig/core";
import { useT3Runs } from "../../hooks/useT3Runs";
import * as t3Service from "../../services/t3";
import {
  T3ApiError,
  fetchT3Connection,
  registerT3HostFolder,
} from "../../services/t3";
import { resolveProjectActiveSessions } from "./activeSessions";
import { ProjectCard, type ProjectBoundHostDisplay } from "./ProjectCard";
import { ProjectDetailModal } from "./ProjectDetailModal";
import { ProjectModal, type ProjectModalSubmitExtras } from "./ProjectModal";
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
  readonly agentRuns?: readonly AgentRun[] | undefined;
  readonly activeSessions?: readonly T3ProjectActiveSession[] | undefined;
  /**
   * Lets the New Project dialog register a folder on the T3 host (#BIT-148). Pass true only
   * for an organisation owner in Cloudflare mode; the field then appears once a T3 host is
   * confirmed connected.
   */
  readonly hostFolderEnabled?: boolean;
}

interface HostFolderNotice {
  readonly tone: "success" | "error";
  readonly text: string;
}

type ProjectTaskFilter = "" | "open" | "done" | "empty";
type ProjectT3Filter = "" | "active" | "idle";

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
  agentRuns: agentRunsProp,
  activeSessions: activeSessionsProp,
  hostFolderEnabled = false,
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
  const [t3Filter, setT3Filter] = useState<ProjectT3Filter>("");
  const [needsHumanOnly, setNeedsHumanOnly] = useState(false);

  const t3Runs = useT3Runs({
    enabled: agentRunsProp === undefined && activeSessionsProp === undefined,
  });

  const effectiveRuns = agentRunsProp ?? t3Runs.runs;
  const effectiveSessions = activeSessionsProp ?? t3Runs.activeSessions;

  const activeSessionsByProject = useMemo(() => {
    const map = new Map<string, ReturnType<typeof resolveProjectActiveSessions>>();
    for (const project of projects) {
      map.set(
        project.id,
        resolveProjectActiveSessions(project, tasks, effectiveRuns, effectiveSessions),
      );
    }
    return map;
  }, [projects, tasks, effectiveRuns, effectiveSessions]);

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    project: Project | null;
    openKey: number;
  }>({
    isOpen: false,
    project: null,
    openKey: 0,
  });

  const [isCreating, setIsCreating] = useState(false);
  const [hostConnected, setHostConnected] = useState(false);
  const [hosts, setHosts] = useState<T3HostConnectionStatus[]>([]);
  const [mappings, setMappings] = useState<T3ProjectMapping[]>([]);
  const [isHostsLoading, setIsHostsLoading] = useState(false);
  const [hostFolderNotice, setHostFolderNotice] = useState<HostFolderNotice | null>(null);

  function openProjectModal(project: Project | null) {
    if (project === null && hostFolderEnabled) {
      setIsHostsLoading(true);
    }
    setIsCreating(project === null);
    setModalState((prev) => ({
      isOpen: true,
      project,
      openKey: prev.openKey + 1,
    }));
  }

  function closeProjectModal() {
    setIsCreating(false);
    setIsHostsLoading(false);
    setModalState((prev) => ({
      ...prev,
      isOpen: false,
      project: null,
    }));
  }

  useEffect(() => {
    if (projects.length === 0) return;
    const controller = new AbortController();
    const loadHosts =
      "fetchT3Hosts" in t3Service && typeof t3Service.fetchT3Hosts === "function"
        ? Promise.resolve(t3Service.fetchT3Hosts(controller.signal)).catch((): T3HostConnectionStatus[] => [])
        : Promise.resolve<T3HostConnectionStatus[]>([]);
    const loadMappings =
      "fetchT3ProjectMappings" in t3Service && typeof t3Service.fetchT3ProjectMappings === "function"
        ? Promise.resolve(t3Service.fetchT3ProjectMappings(controller.signal)).catch((): T3ProjectMapping[] => [])
        : Promise.resolve<T3ProjectMapping[]>([]);

    void Promise.all([loadHosts, loadMappings]).then(([loadedHosts, loadedMappings]) => {
      if (controller.signal.aborted) return;
      if (Array.isArray(loadedHosts) && loadedHosts.length > 0) {
        setHosts(loadedHosts);
        setHostConnected(true);
      }
      if (Array.isArray(loadedMappings)) {
        setMappings(loadedMappings);
      }
    });
    return () => {
      controller.abort();
    };
  }, [projects.length]);

  // Re-checks the T3 connection each time the New Project dialog opens, so a host connected or
  // disconnected in Settings is picked up without a reload.
  useEffect(() => {
    if (!hostFolderEnabled || !isCreating) return;
    const controller = new AbortController();
    const loadHosts =
      "fetchT3Hosts" in t3Service && typeof t3Service.fetchT3Hosts === "function"
        ? Promise.resolve(t3Service.fetchT3Hosts(controller.signal)).catch((): T3HostConnectionStatus[] => [])
        : Promise.resolve<T3HostConnectionStatus[]>([]);

    void loadHosts
      .then(async (loadedHosts) => {
        if (controller.signal.aborted) return;
        const safeHosts = Array.isArray(loadedHosts) ? loadedHosts : [];
        if (safeHosts.length > 0) {
          setHosts(safeHosts);
          setHostConnected(true);
          return;
        }
        const status = await fetchT3Connection(controller.signal);
        setHosts([]);
        setHostConnected(status.connected);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        // The folder field is optional; without a confirmed host the dialog just hides it.
        console.warn("could not check the T3 connection for the New Project dialog", err);
        setHostConnected(false);
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsHostsLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [hostFolderEnabled, isCreating, modalState.openKey]);

  function resolveBoundHostDisplay(projectId: string): ProjectBoundHostDisplay | undefined {
    const mapping = mappings.find((m) => m.projectId === projectId);
    if (!mapping) return undefined;
    const host = mapping.hostId
      ? hosts.find((h) => h.id === mapping.hostId)
      : hosts.length === 1
        ? hosts[0]
        : undefined;
    const hostLabel = host
      ? (host.label?.trim() ? host.label.trim() : host.mcpUrl || host.id)
      : mapping.hostId;
    return {
      ...(hostLabel ? { hostLabel } : {}),
      folder: mapping.workspaceRoot ?? mapping.t3ProjectTitle,
    };
  }

  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [viewProjectId, setViewProjectId] = useState<string | null>(null);
  const [focusT3Composer, setFocusT3Composer] = useState(false);
  const viewProject = projects.find((p) => p.id === viewProjectId) ?? null;

  const activeProjects = projects.filter((p) => !p.archived);
  const archivedProjects = projects.filter((p) => p.archived === true);

  const needsHumanProjectCount = activeProjects.filter((project) =>
    tasks.some((task) => task.projectId === project.id && task.needsHuman !== undefined),
  ).length;

  const activeT3ProjectCount = activeProjects.filter(
    (project) => (activeSessionsByProject.get(project.id)?.length ?? 0) > 0,
  ).length;

  const hasActiveFilters = Boolean(
    (!isArchivedView && (kindFilter || taskFilter || t3Filter || needsHumanOnly)) || searchQuery,
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

      const projectActiveSessions = activeSessionsByProject.get(p.id) ?? [];
      if (t3Filter === "active" && projectActiveSessions.length === 0) {
        return false;
      }
      if (t3Filter === "idle" && projectActiveSessions.length > 0) {
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
    setT3Filter("");
    setNeedsHumanOnly(false);
  }

  async function handleModalSubmit(input: CreateProjectInput, extras?: ProjectModalSubmitExtras) {
    if (modalState.project) {
      await onUpdateProject(modalState.project.id, input);
      return;
    }
    const created = await onCreateProject(input);
    const folder = extras?.hostFolderPath;
    if (!folder) return;
    // The project already exists, so a registration failure is reported as a notice rather
    // than thrown: throwing would keep the dialog open and a resubmit would create a duplicate.
    try {
      const result = extras.hostId
        ? await registerT3HostFolder(created.id, folder, undefined, extras.hostId)
        : await registerT3HostFolder(created.id, folder);
      setMappings((prev) => [
        ...prev.filter((m) => m.projectId !== created.id),
        result.mapping,
      ]);
      setHostFolderNotice({
        tone: "success",
        text: result.created
          ? `Registered ${folder} in T3 for "${created.name}".`
          : `${folder} was already registered in T3; linked it to "${created.name}".`,
      });
    } catch (err: unknown) {
      const reason = err instanceof T3ApiError ? err.message : "T3 could not be reached.";
      if (!(err instanceof T3ApiError)) console.error("unexpected host folder registration failure", err);
      setHostFolderNotice({
        tone: "error",
        text: `"${created.name}" was created, but its folder was not registered: ${reason} You can retry from the project's T3 panel.`,
      });
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

            <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
              <span>T3:</span>
              <select
                value={t3Filter}
                onChange={(e) => {
                  setT3Filter(e.target.value as ProjectT3Filter);
                }}
                className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
              >
                <option value="">All Sessions</option>
                <option value="active">Active in T3 ({activeT3ProjectCount})</option>
                <option value="idle">No active session</option>
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

          <button
            type="button"
            onClick={() => {
              void t3Runs.refresh();
            }}
            disabled={t3Runs.isRefreshing}
            aria-label="Refresh T3 sessions"
            title="Check live T3 Code session status"
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 transition-colors hover:text-ink disabled:opacity-50 focus-visible:outline-focus"
          >
            <RefreshCw size={13} aria-hidden="true" />
            Refresh T3
          </button>
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

      {hostFolderNotice && (
        <div
          role={hostFolderNotice.tone === "error" ? "alert" : "status"}
          className={`flex items-start justify-between gap-3 rounded-md border p-4 text-sm font-medium ${
            hostFolderNotice.tone === "error"
              ? "border-danger/30 bg-danger-soft text-danger"
              : "border-rule bg-paper-2 text-ink"
          }`}
        >
          <span>{hostFolderNotice.text}</span>
          <button
            type="button"
            onClick={() => {
              setHostFolderNotice(null);
            }}
            aria-label="Dismiss"
            className="text-ink-3 transition-colors hover:text-ink"
          >
            <X size={ICON_SIZE} />
          </button>
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
          {!isArchivedView && (kindFilter || taskFilter || t3Filter || needsHumanOnly) && (
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
              activeSessions={activeSessionsByProject.get(project.id) ?? []}
              boundHost={resolveBoundHostDisplay(project.id)}
              onView={(p) => {
                setFocusT3Composer(false);
                setViewProjectId(p.id);
              }}
              onMessage={(p) => {
                setFocusT3Composer(true);
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
        activeSessions={viewProject ? (activeSessionsByProject.get(viewProject.id) ?? []) : []}
        focusT3Composer={focusT3Composer}
        canManageHostFolder={hostFolderEnabled}
        onMappingChange={(projectId, nextMapping) => {
          setMappings((prev) =>
            nextMapping
              ? [...prev.filter((m) => m.projectId !== projectId), nextMapping]
              : prev.filter((m) => m.projectId !== projectId),
          );
        }}
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
        hostFolderEnabled={hostFolderEnabled && hostConnected}
        hosts={hosts.length > 0 ? hosts : undefined}
        isHostsLoading={isHostsLoading}
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
