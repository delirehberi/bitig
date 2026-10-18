import { useState } from "react";
import { Kanban, List, Plus } from "lucide-react";
import type {
  CreateTaskInput,
  Project,
  Task,
  TaskPriority,
  TaskStatus,
  UpdateTaskInput,
} from "@bitig/core";
import { TaskBoard } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { TaskModal } from "./TaskModal";
import { DeleteTaskDialog } from "./DeleteTaskDialog";

interface TasksViewProps {
  readonly tasks: Task[];
  readonly projects: Project[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly selectedProjectId?: string | undefined;
  readonly onSelectProject: (id: string | undefined) => void;
  readonly onSaveTask: (input: CreateTaskInput) => Promise<Task>;
  readonly onUpdateTask: (id: string, patch: UpdateTaskInput) => Promise<Task>;
  readonly onCompleteTask: (id: string) => Promise<Task>;
  readonly onDeleteTask: (id: string) => Promise<void>;
  readonly searchQuery: string;
}

const ICON_SIZE = 16;

export function TasksView({
  tasks,
  projects,
  isLoading,
  error,
  selectedProjectId,
  onSelectProject,
  onSaveTask,
  onUpdateTask,
  onCompleteTask,
  onDeleteTask,
  searchQuery,
}: TasksViewProps) {
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "">("");

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    task: Task | null;
  }>({
    isOpen: false,
    task: null,
  });

  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);

  const filteredTasks = tasks.filter((task) => {
    if (selectedProjectId && task.projectId !== selectedProjectId) {
      return false;
    }
    if (priorityFilter && task.priority !== priorityFilter) {
      return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchesTitle = task.title.toLowerCase().includes(q);
      const matchesDesc = task.description.toLowerCase().includes(q);
      const matchesLabel = task.labels?.some((l) => l.toLowerCase().includes(q));
      if (!matchesTitle && !matchesDesc && !matchesLabel) {
        return false;
      }
    }
    return true;
  });

  async function handleModalSubmit(input: CreateTaskInput) {
    if (modalState.task) {
      await onUpdateTask(modalState.task.id, input);
    } else {
      await onSaveTask(input);
    }
  }

  async function handleStatusChange(task: Task, status: TaskStatus) {
    await onUpdateTask(task.id, { status });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold tracking-tight text-ink">Tasks</h1>
          <p className="m-0 text-sm text-ink-2">Keep track of your agent and human tasks</p>
        </div>

        <button
          type="button"
          onClick={() => {
            setModalState({ isOpen: true, task: null });
          }}
          disabled={projects.length === 0}
          title={projects.length === 0 ? "Create a project first" : undefined}
          className="inline-flex items-center gap-2 self-start rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-focus"
        >
          <Plus size={ICON_SIZE} />
          New Task
        </button>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule bg-paper p-3 shadow-xs">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
            <span>Project:</span>
            <select
              value={selectedProjectId ?? ""}
              onChange={(e) => {
                onSelectProject(e.target.value ? e.target.value : undefined);
              }}
              className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
            >
              <option value="">All Projects ({projects.length})</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
            <span>Priority:</span>
            <select
              value={priorityFilter}
              onChange={(e) => {
                setPriorityFilter(e.target.value as TaskPriority | "");
              }}
              className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
            >
              <option value="">All Priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="trivial">Trivial</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-1 border-l border-rule pl-3">
          <button
            type="button"
            onClick={() => {
              setViewMode("board");
            }}
            title="Board view"
            aria-label="Board view"
            className={`rounded-md p-1.5 transition-colors ${
              viewMode === "board"
                ? "bg-paper-2 text-ink shadow-xs"
                : "text-ink-3 hover:text-ink"
            }`}
          >
            <Kanban size={ICON_SIZE} />
          </button>
          <button
            type="button"
            onClick={() => {
              setViewMode("list");
            }}
            title="List view"
            aria-label="List view"
            className={`rounded-md p-1.5 transition-colors ${
              viewMode === "list"
                ? "bg-paper-2 text-ink shadow-xs"
                : "text-ink-3 hover:text-ink"
            }`}
          >
            <List size={ICON_SIZE} />
          </button>
        </div>
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
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-64 animate-pulse rounded-lg border border-rule bg-paper-2"
            />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-rule bg-paper-2 p-12 text-center">
          <h3 className="m-0 font-display text-base font-bold text-ink">No projects yet</h3>
          <p className="m-0 mt-1 max-w-sm text-xs text-ink-2">
            Every task belongs to a project. Please create a project first before adding tasks.
          </p>
        </div>
      ) : viewMode === "board" ? (
        <TaskBoard
          tasks={filteredTasks}
          projects={projects}
          onEdit={(t) => {
            setModalState({ isOpen: true, task: t });
          }}
          onDelete={(t) => {
            setDeleteTarget(t);
          }}
          onComplete={(t) => {
            void onCompleteTask(t.id);
          }}
          onStatusChange={(t, s) => {
            void handleStatusChange(t, s);
          }}
        />
      ) : (
        <TaskList
          tasks={filteredTasks}
          projects={projects}
          onEdit={(t) => {
            setModalState({ isOpen: true, task: t });
          }}
          onDelete={(t) => {
            setDeleteTarget(t);
          }}
          onComplete={(t) => {
            void onCompleteTask(t.id);
          }}
          onStatusChange={(t, s) => {
            void handleStatusChange(t, s);
          }}
        />
      )}

      {/* Keyed so each open remounts the form; its fields are seeded from `task` only on mount. */}
      <TaskModal
        key={modalState.task?.id ?? "new"}
        isOpen={modalState.isOpen}
        task={modalState.task}
        projects={projects}
        defaultProjectId={selectedProjectId}
        onClose={() => {
          setModalState({ isOpen: false, task: null });
        }}
        onSubmit={handleModalSubmit}
      />

      <DeleteTaskDialog
        isOpen={Boolean(deleteTarget)}
        task={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
        }}
        onConfirm={onDeleteTask}
      />
    </div>
  );
}
