import { useEffect, useRef, useState, type DragEvent } from "react";
import { Archive, X } from "lucide-react";
import {
  TASK_STATUSES,
  type Project,
  type Task,
  type TaskStatus,
  type UpdateTaskInput,
} from "@bitig/core";
import { TaskCard } from "./TaskCard";
import { planMove } from "./reorder";

export interface TaskMove {
  readonly task: Task;
  readonly patch: UpdateTaskInput;
}

interface TaskBoardProps {
  /** In `compareTasks` order; each column keeps it. */
  readonly tasks: Task[];
  readonly projects: Project[];
  readonly onView: (task: Task) => void;
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
  /** Approves a task an agent or webhook created; omit to show the flag read-only. */
  readonly onApprove?: ((task: Task) => void) | undefined;
  /** Writes for a drag-and-drop or keyboard move; the moved task comes first. */
  readonly onMove: (moves: readonly TaskMove[]) => void;
  /** Whether to show the project name badge on each card; defaults to true. */
  readonly showProject?: boolean;
}

const ACTIVE_STATUSES: readonly TaskStatus[] = ["todo", "in_progress", "blocked", "done"];
const ARCHIVE_ICON_SIZE = 15;

const COLUMN_CONFIG: Record<
  TaskStatus,
  { label: string; dotClass: string }
> = {
  blocked: { label: "Blocked", dotClass: "bg-danger" },
  todo: { label: "To Do", dotClass: "bg-rule-strong" },
  in_progress: { label: "In Progress", dotClass: "bg-accent" },
  done: { label: "Done", dotClass: "bg-ok" },
  archived: { label: "Archived", dotClass: "bg-ink-3" },
};

interface DropTarget {
  readonly status: TaskStatus;
  /** Position among the column's cards, not counting the dragged one. */
  readonly index: number;
}

export function TaskBoard({
  tasks,
  projects,
  onView,
  onEdit,
  onDelete,
  onComplete,
  onStatusChange,
  onApprove,
  onMove,
  showProject = true,
}: TaskBoardProps) {
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // A keyboard move re-renders the card elsewhere; keep focus on its handle.
  const refocusId = useRef<string | null>(null);
  const boardRef = useRef<HTMLDivElement>(null);

  const columns = new Map(
    TASK_STATUSES.map((status) => [
      status,
      tasks.filter((t) => t.status === status),
    ]),
  );
  const archivedTasks = columns.get("archived") ?? [];

  useEffect(() => {
    const id = refocusId.current;
    if (!id) return;
    const handle = boardRef.current?.querySelector<HTMLElement>(
      `[data-reorder-handle="${id}"]`,
    );
    if (!handle) return;
    handle.focus();
    refocusId.current = null;
  }, [tasks]);

  function move(task: Task, status: TaskStatus, index: number) {
    const column = columns.get(status) ?? [];
    const changes = planMove(column, task, index);
    const statusChanged = task.status !== status;
    if (changes.length === 0 && !statusChanged) return;
    const moves = changes.map(({ task: t, order }): TaskMove => ({
      task: t,
      patch: t.id === task.id && statusChanged ? { status, order } : { order },
    }));
    onMove(moves);
  }

  function dropIndex(event: DragEvent<HTMLElement>, status: TaskStatus): number {
    const cards = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>("[data-task-id]"),
    ).filter((el) => el.dataset.taskId !== draggedId);
    const below = cards.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    return below === -1 ? (columns.get(status) ?? []).filter((t) => t.id !== draggedId).length : below;
  }

  function endDrag() {
    setDraggedId(null);
    setDropTarget(null);
  }

  return (
    <div ref={boardRef} className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
        {ACTIVE_STATUSES.map((status) => {
          const colTasks = columns.get(status) ?? [];
          const config = COLUMN_CONFIG[status];
          const visible = colTasks.filter((t) => t.id !== draggedId);
          const indicatorAt = dropTarget?.status === status ? dropTarget.index : null;

          return (
            <div
              key={status}
              data-testid={`column-${status}`}
              onDragOver={(e) => {
                if (!draggedId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const index = dropIndex(e, status);
                if (dropTarget?.status !== status || dropTarget.index !== index) {
                  setDropTarget({ status, index });
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const task = tasks.find((t) => t.id === draggedId);
                if (task) move(task, status, dropIndex(e, status));
                endDrag();
              }}
              className={`flex flex-col rounded-lg border bg-paper-2/60 p-4 transition-colors ${
                indicatorAt !== null ? "border-accent/50" : "border-rule"
              }`}
            >
              <div className="mb-3 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span aria-hidden="true" className={`size-2 rounded-full ${config.dotClass}`} />
                  <h3 className="m-0 font-display text-sm font-bold text-ink">{config.label}</h3>
                </div>
                <div className="flex items-center gap-2">
                  {status === "done" && colTasks.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        for (const task of colTasks) {
                          onStatusChange(task, "archived");
                        }
                      }}
                      className="rounded-md border border-rule bg-paper px-2 py-0.5 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
                    >
                      Archive all
                    </button>
                  )}
                  <span className="rounded-pill bg-paper px-2 py-0.5 font-mono text-2xs font-semibold text-ink-2">
                    {colTasks.length}
                  </span>
                  {status === "done" && (
                    <button
                      type="button"
                      data-testid="toggle-archived-tasks"
                      aria-label={`Archived tasks (${String(archivedTasks.length)})`}
                      aria-pressed={showArchived}
                      title={
                        showArchived
                          ? "Hide archived tasks"
                          : `Show archived tasks (${String(archivedTasks.length)})`
                      }
                      onClick={() => {
                        setShowArchived((prev) => !prev);
                      }}
                      onDragOver={(e) => {
                        if (!draggedId) return;
                        e.preventDefault();
                        e.stopPropagation();
                        e.dataTransfer.dropEffect = "move";
                        if (dropTarget?.status !== "archived") {
                          setDropTarget({ status: "archived", index: archivedTasks.length });
                        }
                      }}
                      onDragLeave={(e) => {
                        e.stopPropagation();
                        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                          setDropTarget(null);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const task = tasks.find((t) => t.id === draggedId);
                        if (task) move(task, "archived", archivedTasks.length);
                        endDrag();
                      }}
                      className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-2xs font-semibold transition-colors focus-visible:outline-focus ${
                        dropTarget?.status === "archived"
                          ? "border-accent bg-accent-soft text-accent-ink"
                          : showArchived
                            ? "border-rule-strong bg-paper-3 text-ink"
                            : "border-rule bg-paper text-ink-3 hover:bg-paper-2 hover:text-ink"
                      }`}
                    >
                      <Archive size={ARCHIVE_ICON_SIZE} aria-hidden="true" />
                      {archivedTasks.length > 0 && (
                        <span className="font-mono">{archivedTasks.length}</span>
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-3 min-h-[120px]">
                {colTasks.length === 0 ? (
                  <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-rule p-4 text-center text-xs text-ink-3">
                    {indicatorAt !== null ? "Drop here" : "No tasks"}
                  </div>
                ) : (
                  colTasks.map((task) => {
                    const position = visible.indexOf(task);
                    return (
                      <div
                        key={task.id}
                        data-task-id={task.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.effectAllowed = "move";
                          // Firefox only starts a drag when some data is set.
                          e.dataTransfer.setData("text/plain", task.title);
                          setDraggedId(task.id);
                        }}
                        onDragEnd={endDrag}
                        className={`relative ${task.id === draggedId ? "opacity-40" : ""}`}
                      >
                        {indicatorAt !== null && position === indicatorAt && <DropIndicator />}
                        <TaskCard
                          task={task}
                          projects={projects}
                          showProject={showProject}
                          onView={onView}
                          onEdit={onEdit}
                          onDelete={onDelete}
                          onComplete={onComplete}
                          onStatusChange={onStatusChange}
                          onApprove={onApprove}
                          onReorder={(direction) => {
                            const index = colTasks.indexOf(task) + direction;
                            if (index < 0 || index >= colTasks.length) return;
                            refocusId.current = task.id;
                            move(task, status, index);
                          }}
                        />
                      </div>
                    );
                  })
                )}
                {indicatorAt !== null && indicatorAt === visible.length && visible.length > 0 && (
                  <div className="relative">
                    <DropIndicator />
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {showArchived && (
        <div
          data-testid="column-archived"
          className="flex flex-col rounded-lg border border-rule bg-paper-2/60 p-4"
        >
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Archive size={ARCHIVE_ICON_SIZE} className="text-ink-3" aria-hidden="true" />
              <h3 className="m-0 font-display text-sm font-bold text-ink">
                {COLUMN_CONFIG.archived.label}
              </h3>
              <span className="rounded-pill bg-paper px-2 py-0.5 font-mono text-2xs font-semibold text-ink-2">
                {archivedTasks.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowArchived(false);
              }}
              aria-label="Hide archived tasks"
              className="rounded-md p-1 text-ink-3 transition-colors hover:bg-paper hover:text-ink focus-visible:outline-focus"
            >
              <X size={ARCHIVE_ICON_SIZE} aria-hidden="true" />
            </button>
          </div>

          {archivedTasks.length === 0 ? (
            <div className="flex items-center justify-center rounded-md border border-dashed border-rule p-4 text-center text-xs text-ink-3">
              No archived tasks
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {archivedTasks.map((task) => (
                <div key={task.id} data-task-id={task.id}>
                  <TaskCard
                    task={task}
                    projects={projects}
                    showProject={showProject}
                    onView={onView}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onComplete={onComplete}
                    onStatusChange={onStatusChange}
                    onApprove={onApprove}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DropIndicator() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 -top-2 h-0.5 rounded-pill bg-accent"
    />
  );
}
