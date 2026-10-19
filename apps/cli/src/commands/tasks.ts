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
  backfillTicketCodes,
  resolveProjectRef,
  resolveTaskRef,
  setChecklistItemDone,
  withTaskCodes,
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

/** A task's ticket code, or its ID while it has none. */
function label(task: Task & { readonly code?: string }): string {
  return task.code ?? task.id;
}

async function withCode(storage: StorageProvider, task: Task): Promise<Task & { readonly code?: string }> {
  const project = await storage.getProject(task.projectId);
  return withTaskCodes([task], project === null ? [] : [project])[0] ?? task;
}

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

  /** An explicit project ID or key, else the linked `.bitig` project. */
  async function resolveProjectId(storage: StorageProvider, explicit?: string): Promise<string | undefined> {
    if (explicit !== undefined && explicit.trim() !== "") {
      return resolveProjectRef(storage, explicit);
    }
    const found = findProjectLink(process.cwd(), homedir);
    return found?.projectId;
  }

  // list
  tasks
    .command("list")
    .description("List tasks (optionally filtered by project)")
    .option("-p, --project <id>", "Project ID or key (defaults to linked .bitig project)")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; json?: boolean }) => {
      const storage = await getStorage();
      const pId = await resolveProjectId(storage, options.project);
      const list = withTaskCodes(
        await storage.getTasks(pId !== undefined ? { projectId: pId } : undefined),
        await storage.getProjects(),
      );
      const width = Math.max(4, ...list.map((t) => label(t).length));

      const output = formatOutput(
        list,
        () => list.map((t) => `${t.id}\t${t.status}\t${t.priority ?? "-"}\t${t.title}\t${t.code ?? ""}`).join("\n"),
        () => {
          if (list.length === 0) return "No tasks found.";
          const rows = list.map((t) => {
            const progress = progressLabel(t);
            return `${label(t).padEnd(width)}  ${t.status.padEnd(12)}  ${(t.priority ?? "-").padEnd(8)}  ${t.title}${progress ? ` (${progress})` : ""}`;
          });
          return [`${"CODE".padEnd(width)}  STATUS        PRIORITY  TITLE`, ...rows].join("\n");
        },
        options,
      );
      if (output !== "") console.log(output);
    });

  // show
  tasks
    .command("show <id>")
    .description("Show task details (by ID or ticket code, e.g. BIT-12)")
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const found = await storage.getTask(await resolveTaskRef(storage, ref));
      if (found === null) {
        throw new Error(`Task ${ref} not found`);
      }
      const task = await withCode(storage, found);

      const output = formatOutput(
        task,
        () =>
          [
            `Code:        ${task.code ?? "-"}`,
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
    .option("-p, --project <id>", "Project ID or key (defaults to linked .bitig project)")
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
        const storage = await getStorage();
        const projectId = await resolveProjectId(storage, options.project);
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

        const saved = await storage.saveTask({
          projectId,
          title,
          description,
          status: options.status as TaskStatus | undefined,
          priority: options.priority as TaskPriority | undefined,
          dueDate: options.due,
          labels,
          order: options.order,
        });
        const created = await withCode(storage, saved);

        const output = formatOutput(
          created,
          () => `${created.id}\t${created.title}\t${created.code ?? ""}`,
          () => `Created task ${label(created)} '${created.title}'`,
          options,
        );
        console.log(output);
      },
    );

  // update
  tasks
    .command("update <id>")
    .description("Update a task (by ID or ticket code)")
    .option("-t, --title <title>", "New task title")
    .option("-p, --project <id>", "Move task to another project (ID or key); it gets a new code there")
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
        ref: string,
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
        const id = await resolveTaskRef(storage, ref);
        let description = options.description;

        if (options.description === "-") {
          description = await readStdin();
        } else if (options.edit) {
          const current = await storage.getTask(id);
          description = await readFromEditor(current?.description ?? "");
        }

        const labels = options.labels !== undefined ? options.labels.split(",").map((s) => s.trim()) : undefined;

        const projectId =
          options.project === undefined ? undefined : await resolveProjectRef(storage, options.project);
        const saved = await storage.updateTask(id, {
          title: options.title,
          projectId,
          description,
          status: options.status as TaskStatus | undefined,
          priority: options.priority as TaskPriority | undefined,
          dueDate: options.due,
          labels,
          order: options.order,
        });
        const updated = await withCode(storage, saved);

        const output = formatOutput(
          updated,
          () => `${updated.id}\t${updated.title}\t${updated.code ?? ""}`,
          () => `Updated task ${label(updated)} '${updated.title}'`,
          options,
        );
        console.log(output);
      },
    );

  // done
  tasks
    .command("done <id>")
    .description("Mark task as completed (done), by ID or ticket code")
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const completed = await withCode(storage, await storage.completeTask(await resolveTaskRef(storage, ref)));
      const output = formatOutput(
        completed,
        () => `${completed.id}\t${completed.status}`,
        () => `Completed task ${label(completed)} '${completed.title}'`,
        options,
      );
      console.log(output);
    });

  // item: checklist (subtask) editing. Positions are 1-based, as `tasks show` prints them.
  const item = tasks.command("item").description("Edit a task's checklist (subtasks)");

  async function editChecklist(
    taskRef: string,
    options: { json?: boolean },
    edit: (checklist: readonly ChecklistItem[]) => ChecklistItem[],
  ): Promise<void> {
    const storage = await getStorage();
    const taskId = await resolveTaskRef(storage, taskRef);
    const task = await storage.getTask(taskId);
    if (task === null) {
      throw new Error(`Task ${taskRef} not found`);
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
    .description("Permanently delete a task, by ID or ticket code")
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const id = await resolveTaskRef(storage, ref);
      await storage.deleteTask(id);
      const output = formatOutput(
        { deletedTaskId: id },
        () => `Deleted task ${ref}`,
        undefined,
        options,
      );
      console.log(output);
    });

  // backfill-codes
  tasks
    .command("backfill-codes")
    .description("Give projects without a key one and number their tasks, oldest first (safe to rerun)")
    .option("--json", "Output JSON")
    .action(async (options: { json?: boolean }) => {
      const storage = await getStorage();
      const result = await backfillTicketCodes(storage);
      const output = formatOutput(
        { keyedProjects: result.projects, numberedTasks: result.tasks },
        () => `${String(result.projects)}\t${String(result.tasks)}`,
        () => `Keyed ${String(result.projects)} project(s) and numbered ${String(result.tasks)} task(s)`,
        options,
      );
      console.log(output);
    });
}

