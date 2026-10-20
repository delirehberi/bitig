import { useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Circle,
  Clock,
  Edit2,
  Trash2,
} from "lucide-react";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  compareTasks,
  formatDuration,
  getTaskTiming,
  type Project,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@bitig/core";
import { ChecklistProgressBadge } from "./Checklist";
import { NeedsHumanBadge } from "./NeedsHuman";
import { TaskCode } from "./TaskCode";

export type SortColumn = "title" | "project" | "status" | "priority" | "dueDate";
export type SortDirection = "asc" | "desc";

interface SortState {
  readonly column: SortColumn;
  readonly direction: SortDirection;
}

interface TaskListProps {
  readonly tasks: Task[];
  readonly projects: Project[];
  readonly onView: (task: Task) => void;
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
  /** Whether to show the Project column; defaults to true. */
  readonly showProject?: boolean;
}

const PRIORITY_BADGES: Record<TaskPriority, string> = {
  urgent: "bg-danger-soft text-danger border-danger/30 font-bold",
  high: "bg-accent-soft text-accent-ink border-accent/30 font-semibold",
  medium: "bg-rule-strong text-ink border-rule",
  low: "bg-paper-3 text-ink-2 border-rule",
  trivial: "bg-paper-3 text-ink-3 border-rule",
};

const ICON_SIZE = 14;
const SORT_ICON_SIZE = 12;

function compareOptionalStrings(
  a: string | undefined,
  b: string | undefined,
  direction: SortDirection,
): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const cmp = a.localeCompare(b, undefined, { sensitivity: "base" });
  return direction === "asc" ? cmp : -cmp;
}

function compareOptionalNumbers(
  a: number | undefined,
  b: number | undefined,
  direction: SortDirection,
): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const cmp = a - b;
  return direction === "asc" ? cmp : -cmp;
}

function sortTasksByColumn(
  tasks: readonly Task[],
  projectsById: ReadonlyMap<string, Project>,
  sort: SortState | null,
  showProject: boolean,
): Task[] {
  if (!sort || (sort.column === "project" && !showProject)) {
    return [...tasks];
  }

  const { column, direction } = sort;
  const mult = direction === "asc" ? 1 : -1;

  return [...tasks].sort((a, b) => {
    let cmp = 0;
    switch (column) {
      case "title":
        cmp = a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) * mult;
        break;
      case "project": {
        const nameA = projectsById.get(a.projectId)?.name;
        const nameB = projectsById.get(b.projectId)?.name;
        cmp = compareOptionalStrings(nameA, nameB, direction);
        break;
      }
      case "status": {
        const idxA = TASK_STATUSES.indexOf(a.status);
        const idxB = TASK_STATUSES.indexOf(b.status);
        cmp = (idxA - idxB) * mult;
        break;
      }
      case "priority": {
        const idxA = a.priority !== undefined ? TASK_PRIORITIES.indexOf(a.priority) : undefined;
        const idxB = b.priority !== undefined ? TASK_PRIORITIES.indexOf(b.priority) : undefined;
        cmp = compareOptionalNumbers(idxA, idxB, direction);
        break;
      }
      case "dueDate":
        cmp = compareOptionalStrings(a.dueDate, b.dueDate, direction);
        break;
    }
    return cmp !== 0 ? cmp : compareTasks(a, b);
  });
}

export function TaskList({
  tasks,
  projects,
  onView,
  onEdit,
  onDelete,
  onComplete,
  onStatusChange,
  showProject = true,
}: TaskListProps) {
  const [sort, setSort] = useState<SortState | null>(null);

  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-rule bg-paper-2 p-12 text-center text-xs text-ink-3">
        No tasks found
      </div>
    );
  }

  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const sortedTasks = sortTasksByColumn(tasks, projectsById, sort, showProject);

  function handleSort(column: SortColumn) {
    setSort((prev) => {
      if (prev?.column === column) {
        return { column, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { column, direction: "asc" };
    });
  }

  function ariaSortFor(column: SortColumn): "ascending" | "descending" | "none" {
    if (sort?.column !== column) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

  function renderSortHeader(column: SortColumn, label: string) {
    const active = sort?.column === column;
    const direction = active ? sort.direction : null;
    return (
      <th scope="col" aria-sort={ariaSortFor(column)} className="py-3 px-3">
        <button
          type="button"
          onClick={() => {
            handleSort(column);
          }}
          className="inline-flex cursor-pointer items-center gap-1 font-[inherit] text-[inherit] transition-colors hover:text-ink focus-visible:outline-focus"
        >
          <span>{label}</span>
          {direction === "asc" ? (
            <ArrowUp size={SORT_ICON_SIZE} aria-hidden="true" className="text-ink" />
          ) : direction === "desc" ? (
            <ArrowDown size={SORT_ICON_SIZE} aria-hidden="true" className="text-ink" />
          ) : (
            <ArrowUpDown size={SORT_ICON_SIZE} aria-hidden="true" className="text-ink-3 opacity-60" />
          )}
        </button>
      </th>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-paper shadow-xs">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-rule bg-paper-2 font-display text-ink-2">
          <tr>
            <th scope="col" className="w-10 py-3 pl-4"></th>
            {renderSortHeader("title", "Title")}
            {showProject && renderSortHeader("project", "Project")}
            {renderSortHeader("status", "Status")}
            {renderSortHeader("priority", "Priority")}
            {renderSortHeader("dueDate", "Due Date")}
            <th scope="col" className="py-3 pr-4 text-right">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule font-body">
          {sortedTasks.map((task) => {
            const project = projectsById.get(task.projectId);
            const isDone = task.status === "done";
            const hasRecordedTime =
              task.startedAt !== undefined || task.completedAt !== undefined;
            const spentMs = hasRecordedTime ? getTaskTiming(task).spentMs : undefined;

            return (
              <tr
                key={task.id}
                className={`transition-colors hover:bg-paper-2/50 ${
                  isDone ? "opacity-75" : ""
                }`}
              >
                <td className="py-3 pl-4">
                  <button
                    type="button"
                    onClick={() => {
                      if (task.status !== "done") {
                        onComplete(task);
                      } else {
                        onStatusChange(task, "todo");
                      }
                    }}
                    title={isDone ? "Mark as To Do" : "Mark as Done"}
                    aria-label={isDone ? "Mark as To Do" : "Mark as Done"}
                    className="text-ink-3 hover:text-ok focus-visible:outline-focus"
                  >
                    {isDone ? (
                      <CheckCircle2 size={16} className="text-ok" />
                    ) : (
                      <Circle size={16} className="text-ink-3 hover:text-ok" />
                    )}
                  </button>
                </td>
                <td className="py-3 px-3 min-w-[200px]">
                  <div className="flex flex-col">
                    <span className="flex items-center gap-2">
                      <TaskCode task={task} project={project} />
                      <button
                        type="button"
                        onClick={() => {
                          onView(task);
                        }}
                        title="View task details"
                        className={`cursor-pointer self-start text-left font-semibold text-ink hover:underline focus-visible:outline-focus ${
                          isDone ? "line-through text-ink-3" : ""
                        }`}
                      >
                        {task.title}
                      </button>
                      <ChecklistProgressBadge checklist={task.checklist} />
                      {spentMs !== undefined && (
                        <span
                          className="inline-flex items-center gap-1 rounded-pill bg-paper-2 px-2 py-0.5 font-mono text-2xs font-medium text-ink-2"
                          title="Time spent"
                        >
                          <Clock size={11} aria-hidden="true" />
                          <span>{formatDuration(spentMs)}</span>
                        </span>
                      )}
                      <NeedsHumanBadge reason={task.needsHuman} />
                    </span>
                    {task.description && (
                      <span className="line-clamp-1 text-2xs text-ink-3">
                        {task.description}
                      </span>
                    )}
                  </div>
                </td>
                {showProject && (
                  <td className="py-3 px-3 whitespace-nowrap text-ink-2">
                    {project?.name ?? "—"}
                  </td>
                )}
                <td className="py-3 px-3 whitespace-nowrap">
                  <select
                    value={task.status}
                    onChange={(e) => {
                      onStatusChange(task, e.target.value as TaskStatus);
                    }}
                    aria-label="Change status"
                    className="rounded-md border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink focus-visible:outline-focus"
                  >
                    <option value="todo">To Do</option>
                    <option value="in_progress">In Progress</option>
                    <option value="done">Done</option>
                    <option value="archived">Archived</option>
                  </select>
                </td>
                <td className="py-3 px-3 whitespace-nowrap">
                  {task.priority ? (
                    <span
                      className={`rounded-pill border px-2 py-0.5 text-2xs uppercase tracking-wider ${
                        PRIORITY_BADGES[task.priority]
                      }`}
                    >
                      {task.priority}
                    </span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="py-3 px-3 whitespace-nowrap font-mono text-ink-2">
                  {task.dueDate ?? "—"}
                </td>
                <td className="py-3 pr-4 text-right whitespace-nowrap">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        onEdit(task);
                      }}
                      title="Edit task"
                      aria-label={`Edit ${task.title}`}
                      className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
                    >
                      <Edit2 size={ICON_SIZE} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onDelete(task);
                      }}
                      title="Delete task"
                      aria-label={`Delete ${task.title}`}
                      className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
                    >
                      <Trash2 size={ICON_SIZE} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
