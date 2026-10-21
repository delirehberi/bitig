import { useState } from "react";
import { Hand, Kanban, List, Plus, ShieldQuestionMark, X } from "lucide-react";
import {
  blockedByFromError,
  compareTasks,
  type CreateTaskInput,
  type Project,
  type StorageProvider,
  type Task,
  type TaskPriority,
  type TaskStatus,
  type UpdateTaskInput,
} from "@bitig/core";
import { TaskBoard, type TaskMove } from "./TaskBoard";
import { TaskList } from "./TaskList";
import { TaskDetailModal } from "./TaskDetailModal";
import { TaskModal } from "./TaskModal";
import { DeleteTaskDialog } from "./DeleteTaskDialog";
import { BlockedTaskDialog, type BlockedStatusChange } from "./BlockedTaskDialog";
import type { StatusChangeChoice } from "../../hooks/useTasks";
import { findTaskByRef, taskRef } from "../../domain/task-ref";

interface TasksViewProps {
  readonly tasks: Task[];
  readonly projects: Project[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly selectedProjectId?: string | undefined;
  readonly onSelectProject: (id: string | undefined) => void;
  /** Shows only the tasks waiting on a person. */
  readonly needsHumanOnly?: boolean;
  readonly onNeedsHumanOnlyChange?: (only: boolean) => void;
  /** Shows only the tasks an agent or webhook created that wait for approval. */
  readonly awaitingApprovalOnly?: boolean;
  readonly onAwaitingApprovalOnlyChange?: (only: boolean) => void;
  /** The task shown in the detail view, by ticket code or ID; it lives in the URL so it can be shared. */
  readonly viewTaskRef?: string | undefined;
  /** Opens a task's detail view (its code, or ID while it has none), or closes it with `undefined`. */
  readonly onViewTaskChange: (ref: string | undefined) => void;
  readonly onSaveTask: (input: CreateTaskInput) => Promise<Task>;
  /** A change to in_progress or done is refused while dependencies are unfinished, unless `choice` overrides. */
  readonly onUpdateTask: (id: string, patch: UpdateTaskInput, choice?: StatusChangeChoice) => Promise<Task>;
  readonly onCompleteTask: (id: string, choice?: StatusChangeChoice) => Promise<Task>;
  readonly onDeleteTask: (id: string) => Promise<void>;
  readonly searchQuery: string;
  /** Loads and saves comments in the task detail view; omit to hide them. */
  readonly storage?: StorageProvider | undefined;
}

const ICON_SIZE = 16;

export function TasksView({
  tasks,
  projects,
  isLoading,
  error,
  selectedProjectId,
  onSelectProject,
  needsHumanOnly = false,
  onNeedsHumanOnlyChange,
  awaitingApprovalOnly = false,
  onAwaitingApprovalOnlyChange,
  viewTaskRef,
  onViewTaskChange,
  onSaveTask,
  onUpdateTask,
  onCompleteTask,
  onDeleteTask,
  searchQuery,
  storage,
}: TasksViewProps) {
  const [viewMode, setViewMode] = useState<"board" | "list">("board");
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "">("");

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    task: Task | null;
    openKey: number;
  }>({
    isOpen: false,
    task: null,
    openKey: 0,
  });

  function openTaskModal(task: Task | null) {
    setModalState((prev) => ({
      isOpen: true,
      task,
      openKey: prev.openKey + 1,
    }));
  }

  function closeTaskModal() {
    setModalState((prev) => ({
      ...prev,
      isOpen: false,
      task: null,
    }));
  }

  const [deleteTarget, setDeleteTarget] = useState<Task | null>(null);
  const [blockedChange, setBlockedChange] = useState<BlockedStatusChange | null>(null);
  // Resolved on every render so the detail modal follows updates and closes when the task is deleted.
  const viewTask = viewTaskRef === undefined ? null : (findTaskByRef(viewTaskRef, projects, tasks) ?? null);
  const viewTaskMissing = viewTaskRef !== undefined && viewTask === null && !isLoading && error === null;

  function openTask(task: Task) {
    onViewTaskChange(taskRef(task, projects));
  }

  function closeTask() {
    onViewTaskChange(undefined);
  }

  const needsHumanCount = tasks.filter(
    (task) => task.needsHuman !== undefined && (!selectedProjectId || task.projectId === selectedProjectId),
  ).length;
  const awaitingApprovalCount = tasks.filter(
    (task) => task.pendingApproval === true && (!selectedProjectId || task.projectId === selectedProjectId),
  ).length;

  // Sorted here because local updates (a status or order change) don't re-sort `tasks`.
  const filteredTasks = tasks.filter((task) => {
    if (selectedProjectId && task.projectId !== selectedProjectId) {
      return false;
    }
    if (needsHumanOnly && task.needsHuman === undefined) {
      return false;
    }
    if (awaitingApprovalOnly && task.pendingApproval !== true) {
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
  }).sort(compareTasks);

  /**
   * Runs a change that may start or complete `task`. When unfinished dependencies block it, asks
   * the person to confirm and, if they do, runs it again with the override. Other errors propagate.
   */
  async function confirmIfBlocked(
    task: Task,
    status: TaskStatus,
    change: (choice: StatusChangeChoice) => Promise<Task>,
  ): Promise<void> {
    try {
      await change({});
    } catch (err: unknown) {
      const blockedBy = blockedByFromError(err);
      if (blockedBy === undefined) throw err;
      setBlockedChange({ task, status, blockedBy, override: () => change({ overrideBlocked: true }) });
    }
  }

  function handleComplete(task: Task) {
    void confirmIfBlocked(task, "done", (choice) => onCompleteTask(task.id, choice));
  }

  async function handleModalSubmit(input: CreateTaskInput) {
    const editing = modalState.task;
    if (editing) {
      // The form leaves needsHuman out when its field is empty; null clears a flag the task had.
      // Editing never touches approval: only Approve clears it.
      const patch: UpdateTaskInput = {
        ...input,
        needsHuman: input.needsHuman ?? null,
        pendingApproval: undefined,
      };
      await confirmIfBlocked(editing, input.status ?? editing.status, (choice) =>
        onUpdateTask(editing.id, patch, choice),
      );
    } else {
      await onSaveTask(input);
    }
  }

  function handleApprove(task: Task) {
    void onUpdateTask(task.id, { pendingApproval: null });
  }

  async function handleStatusChange(task: Task, status: TaskStatus) {
    await confirmIfBlocked(task, status, (choice) => onUpdateTask(task.id, { status }, choice));
  }

  async function handleMove(moves: readonly TaskMove[]) {
    for (const { task, patch } of moves) {
      await confirmIfBlocked(task, patch.status ?? task.status, (choice) => onUpdateTask(task.id, patch, choice));
    }
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
            openTaskModal(null);
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

          <button
            type="button"
            aria-pressed={needsHumanOnly}
            onClick={() => {
              onNeedsHumanOnlyChange?.(!needsHumanOnly);
            }}
            title="Show only tasks waiting on a person"
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-focus ${
              needsHumanOnly
                ? "border-accent/30 bg-accent-soft text-accent-ink"
                : "border-rule bg-paper-2 text-ink-2 hover:text-ink"
            }`}
          >
            <Hand size={14} aria-hidden="true" />
            Needs you ({needsHumanCount})
          </button>

          <button
            type="button"
            aria-pressed={awaitingApprovalOnly}
            onClick={() => {
              onAwaitingApprovalOnlyChange?.(!awaitingApprovalOnly);
            }}
            title="Show only tasks an agent or webhook created that wait for your approval"
            className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-focus ${
              awaitingApprovalOnly
                ? "border-dashed border-rule-strong bg-paper-3 text-ink"
                : "border-rule bg-paper-2 text-ink-2 hover:text-ink"
            }`}
          >
            <ShieldQuestionMark size={14} aria-hidden="true" />
            Awaiting approval ({awaitingApprovalCount})
          </button>
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

      {viewTaskMissing && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 p-4 text-sm text-ink-2"
        >
          <span>
            No task <span className="font-mono font-semibold text-ink">{viewTaskRef}</span> was found. It may have
            been deleted, or its project key changed.
          </span>
          <button
            type="button"
            onClick={closeTask}
            aria-label="Dismiss"
            className="rounded-md p-1 text-ink-3 hover:text-ink focus-visible:outline-focus"
          >
            <X size={ICON_SIZE} aria-hidden="true" />
          </button>
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
          showProject={!selectedProjectId}
          onView={openTask}
          onEdit={(t) => {
            openTaskModal(t);
          }}
          onDelete={(t) => {
            setDeleteTarget(t);
          }}
          onComplete={handleComplete}
          onStatusChange={(t, s) => {
            void handleStatusChange(t, s);
          }}
          onApprove={handleApprove}
          onMove={(moves) => {
            void handleMove(moves);
          }}
        />
      ) : (
        <TaskList
          tasks={filteredTasks}
          projects={projects}
          showProject={!selectedProjectId}
          onView={openTask}
          onEdit={(t) => {
            openTaskModal(t);
          }}
          onDelete={(t) => {
            setDeleteTarget(t);
          }}
          onComplete={handleComplete}
          onStatusChange={(t, s) => {
            void handleStatusChange(t, s);
          }}
          onApprove={handleApprove}
        />
      )}

      <TaskDetailModal
        task={viewTask}
        projects={projects}
        onClose={closeTask}
        onEdit={(t) => {
          closeTask();
          openTaskModal(t);
        }}
        onDelete={(t) => {
          closeTask();
          setDeleteTarget(t);
        }}
        onComplete={handleComplete}
        onChecklistChange={(t, checklist) => onUpdateTask(t.id, { checklist })}
        onNeedsHumanResolve={(t) => {
          void onUpdateTask(t.id, { needsHuman: null });
        }}
        onApprove={handleApprove}
        storage={storage}
      />

      {/* Keyed so each open remounts the form; its fields are seeded from `task` only on mount. */}
      <TaskModal
        key={`${modalState.task?.id ?? "new"}-${String(modalState.openKey)}`}
        isOpen={modalState.isOpen}
        task={modalState.task}
        projects={projects}
        defaultProjectId={selectedProjectId}
        onClose={closeTaskModal}
        onSubmit={handleModalSubmit}
      />

      <BlockedTaskDialog
        change={blockedChange}
        onClose={() => {
          setBlockedChange(null);
        }}
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
