import type { StorageMode } from "@bitig/core";
import { useEffect, useState } from "react";
import { AuthProvider } from "./auth/auth-context";
import { LoginPage } from "./auth/LoginPage";
import { useAuth } from "./auth/useAuth";
import { Header } from "./components/Header";
import { Overview } from "./components/Overview";
import { ProjectsView } from "./components/projects/ProjectsView";
import { Rail, type NavigationTab } from "./components/Rail";
import { TasksView } from "./components/tasks/TasksView";
import { FeatureFlagsProvider } from "./domain/feature-context";
import { DEFAULT_MODE } from "./domain/modes";
import { useFeatureFlags } from "./hooks/useFeatureFlags";
import { useHealth, type HealthState } from "./hooks/useHealth";
import { useProjects } from "./hooks/useProjects";
import { useStorage } from "./hooks/useStorage";
import { useTasks } from "./hooks/useTasks";
import { hrefFor, navigate, useLocationHref, useRoute, type Route } from "./routing/router";

type WorkspaceRoute = Extract<Route, { name: NavigationTab }>;

interface WorkspaceProps {
  readonly mode: StorageMode;
  readonly health: HealthState;
  readonly route: WorkspaceRoute;
}

function Workspace({ mode, health, route }: WorkspaceProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const activeTab = route.name;
  const selectedProjectId = route.name === "tasks" ? route.projectId : undefined;

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
    navigate(hrefFor(projectId ? { name: "tasks", projectId } : { name: "tasks" }));
  }

  function handleFilterProject(projectId: string | undefined) {
    // Changing the filter refines the current page rather than opening a new one.
    navigate(hrefFor(projectId ? { name: "tasks", projectId } : { name: "tasks" }), { replace: true });
  }

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[var(--rail-width)_minmax(0,1fr)]">
      <Rail health={health} activeTab={activeTab} />

      <div className="flex min-w-0 flex-col">
        <Header
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
                navigate(hrefFor({ name: tab }));
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
              onSelectProject={handleFilterProject}
              onSaveTask={saveTask}
              onUpdateTask={updateTask}
              onCompleteTask={completeTask}
              onDeleteTask={deleteTask}
              searchQuery={searchQuery}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function LoadingScreen({ label }: { readonly label: string }) {
  return (
    <p role="status" className="grid min-h-dvh place-items-center text-sm text-ink-3">
      {label}
    </p>
  );
}

/** Replaces the current history entry; used when a URL can't be shown as is. */
function Redirect({ to }: { readonly to: string }) {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return <LoadingScreen label="Loading workspace…" />;
}

/**
 * Picks the page for the current URL. With password sign-in, every page but
 * /login needs a session: signed-out visitors go to /login?next=<where they were>,
 * and signed-in visitors on /login go on to that page.
 */
function Pages({ mode, health }: { readonly mode: StorageMode; readonly health: HealthState }) {
  const route = useRoute();
  const href = useLocationHref();
  const { status } = useAuth();
  const { passwordLogin } = useFeatureFlags();

  if (route.name === "not_found") return <Redirect to={hrefFor({ name: "overview" })} />;

  if (!passwordLogin) {
    if (route.name === "login") return <Redirect to={route.next ?? hrefFor({ name: "overview" })} />;
    return <Workspace mode={mode} health={health} route={route} />;
  }

  if (status === "checking") return <LoadingScreen label="Checking your session…" />;

  if (route.name === "login") {
    if (status === "authenticated") return <Redirect to={route.next ?? hrefFor({ name: "overview" })} />;
    return <LoginPage next={route.next} />;
  }

  if (status === "unauthenticated") {
    const next = route.name === "overview" ? undefined : href;
    return <Redirect to={hrefFor(next ? { name: "login", next } : { name: "login" })} />;
  }

  return <Workspace mode={mode} health={health} route={route} />;
}

/**
 * The storage mode is chosen per deployment (the Worker's STORAGE_MODE var) and
 * reported by /health. Storage is only built once that answer is known, so no
 * requests go to a guessed backend; an unreachable Worker falls back to the default.
 */
function Dashboard() {
  const health = useHealth();

  if (health.kind === "checking") return <LoadingScreen label="Loading workspace…" />;

  const mode = health.kind === "online" ? health.storageMode : DEFAULT_MODE;

  return (
    <FeatureFlagsProvider mode={mode}>
      <SessionGate mode={mode} health={health} />
    </FeatureFlagsProvider>
  );
}

function SessionGate({ mode, health }: { readonly mode: StorageMode; readonly health: HealthState }) {
  const { passwordLogin } = useFeatureFlags();
  return (
    <AuthProvider enabled={passwordLogin}>
      <Pages mode={mode} health={health} />
    </AuthProvider>
  );
}

export function App() {
  return <Dashboard />;
}
