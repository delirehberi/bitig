import { TASK_STATUSES, type Project, type Task, type TaskStatus } from "@bitig/core";
import { TaskCard } from "./TaskCard";

interface TaskBoardProps {
  readonly tasks: Task[];
  readonly projects: Project[];
  readonly onEdit: (task: Task) => void;
  readonly onDelete: (task: Task) => void;
  readonly onComplete: (task: Task) => void;
  readonly onStatusChange: (task: Task, status: TaskStatus) => void;
}

const COLUMN_CONFIG: Record<
  TaskStatus,
  { label: string; dotClass: string }
> = {
  todo: { label: "To Do", dotClass: "bg-rule-strong" },
  in_progress: { label: "In Progress", dotClass: "bg-accent" },
  done: { label: "Done", dotClass: "bg-ok" },
  archived: { label: "Archived", dotClass: "bg-ink-3" },
};

export function TaskBoard({
  tasks,
  projects,
  onEdit,
  onDelete,
  onComplete,
  onStatusChange,
}: TaskBoardProps) {
  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
      {TASK_STATUSES.map((status) => {
        const colTasks = tasks.filter((t) => t.status === status);
        const config = COLUMN_CONFIG[status];

        return (
          <div
            key={status}
            className="flex flex-col rounded-lg border border-rule bg-paper-2/60 p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className={`size-2 rounded-full ${config.dotClass}`} />
                <h3 className="m-0 font-display text-sm font-bold text-ink">{config.label}</h3>
              </div>
              <span className="rounded-pill bg-paper px-2 py-0.5 font-mono text-2xs font-semibold text-ink-2">
                {colTasks.length}
              </span>
            </div>

            <div className="flex flex-col gap-3 min-h-[120px]">
              {colTasks.length === 0 ? (
                <div className="flex flex-1 items-center justify-center rounded-md border border-dashed border-rule p-4 text-center text-xs text-ink-3">
                  No tasks
                </div>
              ) : (
                colTasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    projects={projects}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onComplete={onComplete}
                    onStatusChange={onStatusChange}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

