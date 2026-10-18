import type { StorageMode } from "@bitig/core";
import { useState } from "react";
import { AuthProvider } from "./auth/auth-context";
import { LoginForm } from "./auth/LoginForm";
import { Header } from "./components/Header";
import { Overview } from "./components/Overview";
import { ProjectsView } from "./components/projects/ProjectsView";
import { Rail, type NavigationTab } from "./components/Rail";
import { TasksView } from "./components/tasks/TasksView";
import { FeatureFlagsProvider } from "./domain/feature-context";
import { DEFAULT_MODE } from "./domain/modes";
import { useHealth, type HealthState } from "./hooks/useHealth";
import { useProjects } from "./hooks/useProjects";
import { useStorage } from "./hooks/useStorage";
import { useTasks } from "./hooks/useTasks";

interface WorkspaceProps {
  readonly mode: StorageMode;
  readonly health: HealthState;
}

function Workspace({ mode, health }: WorkspaceProps) {
  const [activeTab, setActiveTab] = useState<NavigationTab>("overview");
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoginOpen, setIsLoginOpen] = useState(false);

  const storage = useStorage(mode);

  const {
    projects,
    isLoading: isProjectsLoading,
    error: projectsError,
    createProject,
    updateProject,
    deleteProject,
  } = useProjects(storage);

  const {
    tasks,
    isLoading: isTasksLoading,
    error: tasksError,
    saveTask,
    updateTask,
    completeTask,
    deleteTask,
  } = useTasks(storage);

  function handleSelectProject(projectId: string | undefined) {
    setSelectedProjectId(projectId);
    setActiveTab("tasks");
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--rail-width)_minmax(0,1fr)]">
      <Rail
        health={health}
        activeTab={activeTab}
        onTabChange={setActiveTab}
      />

      <div className="flex min-w-0 flex-col">
        <Header
          onOpenLogin={() => {
            setIsLoginOpen(true);
          }}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />

        <main className="px-5 pt-8 pb-16 md:px-10 md:pt-10">
          {activeTab === "overview" && (
            <Overview
              mode={mode}
              health={health}
              projectsCount={projects.length}
              tasksCount={tasks.length}
              onNavigate={(tab) => {
                setActiveTab(tab);
              }}
            />
          )}

          {activeTab === "projects" && (
            <ProjectsView
              projects={projects}
              tasks={tasks}
              isLoading={isProjectsLoading}
              error={projectsError}
              onCreateProject={createProject}
              onUpdateProject={updateProject}
              onDeleteProject={deleteProject}
              onSelectProject={handleSelectProject}
              searchQuery={searchQuery}
            />
          )}

          {activeTab === "tasks" && (
            <TasksView
              tasks={tasks}
              projects={projects}
              isLoading={isTasksLoading}
              error={tasksError}
              selectedProjectId={selectedProjectId}
              onSelectProject={setSelectedProjectId}
              onSaveTask={saveTask}
              onUpdateTask={updateTask}
              onCompleteTask={completeTask}
              onDeleteTask={deleteTask}
              searchQuery={searchQuery}
            />
          )}
        </main>
      </div>

      <LoginForm
        isOpen={isLoginOpen}
        onClose={() => {
          setIsLoginOpen(false);
        }}
      />
    </div>
  );
}

/**
 * The storage mode is chosen per deployment (the Worker's STORAGE_MODE var) and
 * reported by /health. Storage is only built once that answer is known, so no
 * requests go to a guessed backend; an unreachable Worker falls back to the default.
 */
function Dashboard() {
  const health = useHealth();

  if (health.kind === "checking") {
    return (
      <p role="status" className="grid min-h-dvh place-items-center text-sm text-ink-3">
        Loading workspace…
      </p>
    );
  }

  const mode = health.kind === "online" ? health.storageMode : DEFAULT_MODE;

  return (
    <FeatureFlagsProvider mode={mode}>
      <Workspace mode={mode} health={health} />
    </FeatureFlagsProvider>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Dashboard />
    </AuthProvider>
  );
}
