/**
 * 'bitig tasks' subcommands.
 */
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  addChecklistItem,
  checklistProgress,
  moveChecklistItem,
  removeChecklistItem,
  renameChecklistItem,
  setChecklistItemDone,
  type ChecklistItem,
  type StorageProvider,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@bitig/core";
import type { Command } from "commander";
import { readFromEditor, readStdin } from "../io/input";
import { formatOutput } from "../io/output";
import { findProjectLink } from "../project-link";

/** `2/5` for a task with a checklist, empty otherwise. */
function progressLabel(task: Task): string {
  const { done, total } = checklistProgress(task.checklist);
  return total === 0 ? "" : `${String(done)}/${String(total)}`;
}

function formatChecklist(checklist: readonly ChecklistItem[] | undefined): string {
  if (checklist === undefined) return "(none)";
  return checklist.map((item, i) => `${item.done ? "[x]" : "[ ]"} ${String(i + 1)}. ${item.text}`).join("\n");
}

/** Parses a 1-based position as typed on the command line into a 0-based index. */
function parsePosition(raw: string): number {
  const position = Number(raw);
  if (!Number.isInteger(position) || position < 1) {
    throw new Error(`Invalid position '${raw}': use the item number shown by 'bitig tasks show' (1, 2, ...)`);
  }
  return position - 1;
}

export function registerTasksCommands(
  program: Command,
  getStorage: () => Promise<StorageProvider>,
  homedir: string,
): void {
  const tasks = program.command("tasks").description("Manage tasks");

  function resolveProjectId(explicitId?: string): string | undefined {
    if (explicitId !== undefined && explicitId.trim() !== "") {
      return explicitId;
    }
    const found = findProjectLink(process.cwd(), homedir);
    return found?.projectId;
  }

  // list
  tasks
    .command("list")
    .description("List tasks (optionally filtered by project)")
    .option("-p, --project <id>", "Project ID (defaults to linked .bitig project)")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      const storage = await getStorage();
      const pId = resolveProjectId(options.project);
      const list = await storage.getTasks(pId !== undefined ? { projectId: pId } : undefined);

      const output = formatOutput(
        list,
        () => list.map((t) => `${t.id}\t${t.status}\t${t.priority ?? "-"}\t${t.title}`).join("\n"),
        () => {
          if (list.length === 0) return "No tasks found.";
          const rows = list.map((t) => {
            const progress = progressLabel(t);
            return `${t.id}  ${t.status.padEnd(12)}  ${(t.priority ?? "-").padEnd(8)}  ${t.title}${progress ? ` (${progress})` : ""}`;
          });
          return ["ID                                    STATUS        PRIORITY  TITLE", ...rows].join("\n");
        },
        options,
      );
      if (output !== "") console.log(output);
    });

  // show
  tasks
    .command("show <id>")
    .description("Show task details")
    .option("--json", "Output JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const task = await storage.getTask(id);
      if (task === null) {
        throw new Error(`Task ${id} not found`);
      }

      const output = formatOutput(
        task,
        () =>
          [
            `ID:          ${task.id}`,
            `Project:     ${task.projectId}`,
            `Title:       ${task.title}`,
            `Status:      ${task.status}`,
            `Priority:    ${task.priority ?? "-"}`,
            `Due Date:    ${task.dueDate ?? "-"}`,
            `Labels:      ${task.labels?.join(", ") ?? "-"}`,
            `Created:     ${task.createdAt}`,
            `Updated:     ${task.updatedAt}`,
            "",
            "Description:",
            task.description === "" ? "(none)" : task.description,
            "",
            `Checklist:${task.checklist ? ` ${progressLabel(task)}` : ""}`,
            formatChecklist(task.checklist),
          ].join("\n"),
        undefined,
        options,
      );
      console.log(output);
    });

  // add
  tasks
    .command("add <title>")
    .description("Add a task")
    .option("-p, --project <id>", "Project ID (defaults to linked .bitig project)")
    .option("-d, --description <desc>", "Task description (use '-' for stdin)")
    .option("-e, --edit", "Open editor to compose description")
    .option("-s, --status <status>", `Initial status (${TASK_STATUSES.join(", ")})`)
    .option("--priority <priority>", `Priority (${TASK_PRIORITIES.join(", ")})`)
    .option("--due <date>", "Due date (YYYY-MM-DD)")
    .option("--labels <labels>", "Comma-separated labels")
    .option("--order <num>", "Sort order number", parseFloat)
    .option("--json", "Output JSON")
    .action(
      async (
        title: string,
        options: {
          project?: string;
          description?: string;
          edit?: boolean;
          status?: string;
          priority?: string;
          due?: string;
          labels?: string;
          order?: number;
          json?: boolean;
        },
      ) => {
        const projectId = resolveProjectId(options.project);
        if (projectId === undefined) {
          throw new Error(
            "Project ID is required. Pass --project <id> or run 'bitig init' in your workspace.",
          );
        }

        let description = options.description ?? "";
        if (options.description === "-") {
          description = await readStdin();
        } else if (options.edit) {
          description = await readFromEditor(description);
        }

        const labels = options.labels !== undefined ? options.labels.split(",").map((s) => s.trim()) : undefined;

        const storage = await getStorage();
        const created = await storage.saveTask({
          projectId,
          title,
          description,
          status: options.status as TaskStatus | undefined,
          priority: options.priority as TaskPriority | undefined,
          dueDate: options.due,
          labels,
          order: options.order,
        });

        const output = formatOutput(
          created,
          () => `${created.id}\t${created.title}`,
          () => `Created task '${created.title}' (${created.id})`,
          options,
        );
        console.log(output);
      },
    );

  // update
  tasks
    .command("update <id>")
    .description("Update a task")
    .option("-t, --title <title>", "New task title")
    .option("-p, --project <id>", "Move task to another project")
    .option("-d, --description <desc>", "New description (use '-' for stdin)")
    .option("-e, --edit", "Open editor to edit description")
    .option("-s, --status <status>", `Status (${TASK_STATUSES.join(", ")})`)
    .option("--priority <priority>", `Priority (${TASK_PRIORITIES.join(", ")})`)
    .option("--due <date>", "Due date (YYYY-MM-DD)")
    .option("--labels <labels>", "Comma-separated labels")
    .option("--order <num>", "Sort order", parseFloat)
    .option("--json", "Output JSON")
    .action(
      async (
        id: string,
        options: {
          title?: string;
          project?: string;
          description?: string;
          edit?: boolean;
          status?: string;
          priority?: string;
          due?: string;
          labels?: string;
          order?: number;
          json?: boolean;
        },
      ) => {
        const storage = await getStorage();
        let description = options.description;

        if (options.description === "-") {
          description = await readStdin();
        } else if (options.edit) {
          const current = await storage.getTask(id);
          description = await readFromEditor(current?.description ?? "");
        }

        const labels = options.labels !== undefined ? options.labels.split(",").map((s) => s.trim()) : undefined;

        const updated = await storage.updateTask(id, {
          title: options.title,
          projectId: options.project,
          description,
          status: options.status as TaskStatus | undefined,
          priority: options.priority as TaskPriority | undefined,
          dueDate: options.due,
          labels,
          order: options.order,
        });

        const output = formatOutput(
          updated,
          () => `${updated.id}\t${updated.title}`,
          () => `Updated task '${updated.title}' (${updated.id})`,
          options,
        );
        console.log(output);
      },
    );

  // done
  tasks
    .command("done <id>")
    .description("Mark task as completed (done)")
    .option("--json", "Output JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const completed = await storage.completeTask(id);
      const output = formatOutput(
        completed,
        () => `${completed.id}\t${completed.status}`,
        () => `Completed task '${completed.title}' (${completed.id})`,
        options,
      );
      console.log(output);
    });

  // item: checklist (subtask) editing. Positions are 1-based, as `tasks show` prints them.
  const item = tasks.command("item").description("Edit a task's checklist (subtasks)");

  async function editChecklist(
    taskId: string,
    options: { json?: boolean },
    edit: (checklist: readonly ChecklistItem[]) => ChecklistItem[],
  ): Promise<void> {
    const storage = await getStorage();
    const task = await storage.getTask(taskId);
    if (task === null) {
      throw new Error(`Task ${taskId} not found`);
    }
    const updated = await storage.updateTask(taskId, { checklist: edit(task.checklist ?? []) });
    const output = formatOutput(
      updated,
      () => formatChecklist(updated.checklist),
      () => `Checklist of '${updated.title}' ${progressLabel(updated) || "(empty)"}\n${formatChecklist(updated.checklist)}`,
      options,
    );
    console.log(output);
  }

  item
    .command("add <taskId> <text>")
    .description("Add an unchecked item at the end")
    .option("--json", "Output JSON")
    .action(async (taskId: string, text: string, options: { json?: boolean }) => {
      await editChecklist(taskId, options, (list) => addChecklistItem(list, text));
    });

  item
    .command("check <taskId> <position>")
    .description("Mark an item done")
    .option("--json", "Output JSON")
    .action(async (taskId: string, position: string, options: { json?: boolean }) => {
      await editChecklist(taskId, options, (list) => setChecklistItemDone(list, parsePosition(position), true));
    });

  item
    .command("uncheck <taskId> <position>")
    .description("Mark an item not done")
    .option("--json", "Output JSON")
    .action(async (taskId: string, position: string, options: { json?: boolean }) => {
      await editChecklist(taskId, options, (list) => setChecklistItemDone(list, parsePosition(position), false));
    });

  item
    .command("rename <taskId> <position> <text>")
    .description("Change an item's text")
    .option("--json", "Output JSON")
    .action(async (taskId: string, position: string, text: string, options: { json?: boolean }) => {
      await editChecklist(taskId, options, (list) => renameChecklistItem(list, parsePosition(position), text));
    });

  item
    .command("move <taskId> <from> <to>")
    .description("Move an item to another position")
    .option("--json", "Output JSON")
    .action(async (taskId: string, from: string, to: string, options: { json?: boolean }) => {
      await editChecklist(taskId, options, (list) => moveChecklistItem(list, parsePosition(from), parsePosition(to)));
    });

  item
    .command("remove <taskId> <position>")
    .description("Remove an item")
    .option("--json", "Output JSON")
    .action(async (taskId: string, position: string, options: { json?: boolean }) => {
      await editChecklist(taskId, options, (list) => removeChecklistItem(list, parsePosition(position)));
    });

  // delete
  tasks
    .command("delete <id>")
    .description("Permanently delete a task")
    .option("--json", "Output JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      await storage.deleteTask(id);
      const output = formatOutput(
        { deletedTaskId: id },
        () => `Deleted task ${id}`,
        undefined,
        options,
      );
      console.log(output);
    });
}

