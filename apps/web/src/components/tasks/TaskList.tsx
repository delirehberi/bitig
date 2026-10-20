import { CheckCircle2, Circle, Edit2, Trash2 } from "lucide-react";
import type { Project, Task, TaskPriority, TaskStatus } from "@bitig/core";
import { ChecklistProgressBadge } from "./Checklist";
import { NeedsHumanBadge } from "./NeedsHuman";
import { TaskCode } from "./TaskCode";

interface TaskListProps {
  readonly tasks: Task[];
  readonly projects: Project[];
  readonly onView: (task: Task) => void;
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
}

const PRIORITY_BADGES: Record<TaskPriority, string> = {
  urgent: "bg-danger-soft text-danger border-danger/30 font-bold",
  high: "bg-accent-soft text-accent-ink border-accent/30 font-semibold",
  medium: "bg-rule-strong text-ink border-rule",
  low: "bg-paper-3 text-ink-2 border-rule",
  trivial: "bg-paper-3 text-ink-3 border-rule",
};

const ICON_SIZE = 14;

export function TaskList({
  tasks,
  projects,
  onView,
  onEdit,
  onDelete,
  onComplete,
  onStatusChange,
}: TaskListProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-rule bg-paper-2 p-12 text-center text-xs text-ink-3">
        No tasks found
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-rule bg-paper shadow-xs">
      <table className="w-full text-left text-xs">
        <thead className="border-b border-rule bg-paper-2 font-display text-ink-2">
          <tr>
            <th className="w-10 py-3 pl-4"></th>
            <th className="py-3 px-3">Title</th>
            <th className="py-3 px-3">Project</th>
            <th className="py-3 px-3">Status</th>
            <th className="py-3 px-3">Priority</th>
            <th className="py-3 px-3">Due Date</th>
            <th className="py-3 pr-4 text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule font-body">
          {tasks.map((task) => {
            const project = projects.find((p) => p.id === task.projectId);
            const isDone = task.status === "done";

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
                      <NeedsHumanBadge reason={task.needsHuman} />
                    </span>
                    {task.description && (
                      <span className="line-clamp-1 text-2xs text-ink-3">
                        {task.description}
                      </span>
                    )}
                  </div>
                </td>
                <td className="py-3 px-3 whitespace-nowrap text-ink-2">
                  {project?.name ?? "—"}
                </td>
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

