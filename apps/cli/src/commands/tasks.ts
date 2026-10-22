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
  blockingTasks,
  checkNewTaskStatus,
  checkStatusChange,
  dependencyLinks,
  resolveProjectRef,
  resolveTaskRef,
  resolveTaskRefs,
  setChecklistItemDone,
  withTaskCodes,
  type ChecklistItem,
  type Comment,
  type OperationOptions,
  type StorageProvider,
  type Task,
  type TaskPriority,
  type TaskLinkSummary,
  type TaskStatus,
  type TaskWithCode,
} from "@bitig/core";
import type { Command } from "commander";
import { readFromEditor, readStdin } from "../io/input";
import { formatOutput } from "../io/output";
import { findProjectLink } from "../project-link";

const OVERRIDE_BLOCKED_OPTION = "--override-blocked";
const OVERRIDE_BLOCKED_DESCRIPTION = "Start or complete the task although tasks it depends on are unfinished (logged)";
const DEPENDS_ON_OPTION = "--depends-on <refs>";

/** Comma-separated task IDs or ticket codes, as typed after --depends-on. */
function splitRefs(raw: string): string[] {
  return raw
    .split(",")
    .map((ref) => ref.trim())
    .filter((ref) => ref !== "");
}

/**
 * Refuses to start or complete a task with unfinished dependencies unless the person passed
 * --override-blocked, which then records the override in the task's activity.
 */
async function statusChangeOptions(
  storage: StorageProvider,
  id: string,
  status: TaskStatus | undefined,
  context: string,
  overrideBlocked: boolean | undefined,
  dependsOn?: readonly string[] | null,
): Promise<OperationOptions | undefined> {
  if (status === undefined) return undefined;
  const overrideBlockedBy = await checkStatusChange(storage, id, status, context, {
    overrideBlocked: overrideBlocked === true,
    dependsOn,
  });
  return overrideBlockedBy.length > 0 ? { overrideBlockedBy } : undefined;
}

/** A task's ticket code, or its ID while it has none. */
function label(task: Task & { readonly code?: string }): string {
  return task.code ?? task.id;
}

async function withCode(storage: StorageProvider, task: Task): Promise<Task & { readonly code?: string }> {
  const project = await storage.getProject(task.projectId);
  return withTaskCodes([task], project === null ? [] : [project])[0] ?? task;
}

/** `BIT-63 Schema (done)`, one per line, or `(none)`. */
function formatLinks(tasks: readonly TaskLinkSummary[]): string {
  if (tasks.length === 0) return "(none)";
  return tasks.map((t) => `${t.code ?? t.id} ${t.title} (${t.status})`).join("\n");
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

function formatComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return "(none)";
  return comments
    .map((c) => `${c.createdAt}  ${c.author ?? c.authorType}${c.author === undefined ? "" : ` (${c.authorType})`}  ${c.id}\n${c.body}`)
    .join("\n\n");
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
    .option("--needs-human", "Only tasks waiting on a person")
    .option("--awaiting-approval", "Only tasks an agent or webhook created that wait for your approval")
    .option("--json", "Output JSON")
    .action(async (options: { project?: string; needsHuman?: boolean; awaitingApproval?: boolean; json?: boolean }) => {
      const storage = await getStorage();
      const pId = await resolveProjectId(storage, options.project);
      const found = await storage.getTasks(pId !== undefined ? { projectId: pId } : undefined);
      const projects = await storage.getProjects();
      // Dependencies may sit in another project, so blockers are looked up among all tasks.
      const all = pId === undefined ? found : await storage.getTasks();
      const codedById = new Map(withTaskCodes(all, projects).map((t) => [t.id, t]));
      const blockedBy = (task: Task): string[] => blockingTasks(task, codedById).map((t) => label(t));
      const list = withTaskCodes(
        found.filter(
          (t) =>
            (options.needsHuman !== true || t.needsHuman !== undefined) &&
            (options.awaitingApproval !== true || t.pendingApproval === true),
        ),
        projects,
      ).map((t): TaskWithCode & { readonly blockedBy?: string[] } => {
        const blockers = blockedBy(t);
        return blockers.length > 0 ? { ...t, blockedBy: blockers } : t;
      });
      const width = Math.max(4, ...list.map((t) => label(t).length));

      const output = formatOutput(
        list,
        () =>
          list
            .map((t) => `${t.id}\t${t.status}\t${t.priority ?? "-"}\t${t.title}\t${t.code ?? ""}\t${t.blockedBy?.join(",") ?? ""}`)
            .join("\n"),
        () => {
          if (list.length === 0) return "No tasks found.";
          const rows = list.map((t) => {
            const progress = progressLabel(t);
            const flag =
              (t.needsHuman === undefined ? "" : " [needs human]") +
              (t.pendingApproval === true ? " [awaiting approval]" : "") +
              (t.blockedBy === undefined ? "" : ` [blocked by ${t.blockedBy.join(", ")}]`);
            return `${label(t).padEnd(width)}  ${t.status.padEnd(12)}  ${(t.priority ?? "-").padEnd(8)}  ${t.title}${progress ? ` (${progress})` : ""}${flag}`;
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
      const comments = await storage.getComments(task.id);
      const dependencies = dependencyLinks(task, await storage.getTasks(), await storage.getProjects());
      const blockers = dependencies.dependsOn.filter((t) => t.status !== "done" && t.status !== "archived");

      const output = formatOutput(
        {
          ...task,
          comments,
          ...dependencies,
          ...(blockers.length > 0 ? { blockedBy: blockers.map((t) => t.code ?? t.id) } : {}),
        },
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
            `Needs human: ${task.needsHuman ?? "-"}`,
            `Approval:    ${task.pendingApproval === true ? "awaiting approval" : "approved"}`,
            `Blocked by:  ${blockers.length > 0 ? blockers.map((t) => t.code ?? t.id).join(", ") : "-"}`,
            `Created:     ${task.createdAt}`,
            `Updated:     ${task.updatedAt}`,
            "",
            "Description:",
            task.description === "" ? "(none)" : task.description,
            "",
            `Checklist:${task.checklist ? ` ${progressLabel(task)}` : ""}`,
            formatChecklist(task.checklist),
            "",
            "Depends on:",
            formatLinks(dependencies.dependsOn),
            "",
            "Blocks:",
            formatLinks(dependencies.dependents),
            "",
            `Comments:${comments.length > 0 ? ` ${String(comments.length)}` : ""}`,
            formatComments(comments),
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
    .option("--needs-human <reason>", "Flag the task as waiting on a person, saying what it needs")
    .option(DEPENDS_ON_OPTION, "Comma-separated tasks (IDs or codes, e.g. BIT-63,BIT-62) it waits on")
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
          needsHuman?: string;
          dependsOn?: string;
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

        const status = options.status as TaskStatus | undefined;
        const dependsOn =
          options.dependsOn === undefined ? [] : await resolveTaskRefs(storage, splitRefs(options.dependsOn));
        await checkNewTaskStatus(storage, { status, dependsOn }, "saveTask");
        const saved = await storage.saveTask({
          projectId,
          title,
          description,
          status,
          ...(dependsOn.length > 0 ? { dependsOn } : {}),
          priority: options.priority as TaskPriority | undefined,
          dueDate: options.due,
          labels,
          order: options.order,
          needsHuman: options.needsHuman,
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
    .option("--needs-human <reason>", "Flag the task as waiting on a person, saying what it needs")
    .option("--clear-needs-human", "Clear the flag once the person has answered")
    .option(DEPENDS_ON_OPTION, "Replace the tasks it waits on (comma-separated IDs or codes)")
    .option("--clear-depends-on", "Remove all of its dependencies")
    .option(OVERRIDE_BLOCKED_OPTION, OVERRIDE_BLOCKED_DESCRIPTION)
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
          needsHuman?: string;
          clearNeedsHuman?: boolean;
          dependsOn?: string;
          clearDependsOn?: boolean;
          overrideBlocked?: boolean;
          json?: boolean;
        },
      ) => {
        const storage = await getStorage();
        if (options.needsHuman !== undefined && options.clearNeedsHuman === true) {
          throw new Error("Use either --needs-human or --clear-needs-human, not both");
        }
        if (options.dependsOn !== undefined && options.clearDependsOn === true) {
          throw new Error("Use either --depends-on or --clear-depends-on, not both");
        }
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
        const status = options.status as TaskStatus | undefined;
        const resolved =
          options.dependsOn === undefined ? undefined : await resolveTaskRefs(storage, splitRefs(options.dependsOn));
        const dependsOn = options.clearDependsOn === true || resolved?.length === 0 ? null : resolved;
        const opts = await statusChangeOptions(storage, id, status, "updateTask", options.overrideBlocked, dependsOn);
        const saved = await storage.updateTask(
          id,
          {
            title: options.title,
            projectId,
            description,
            status,
            priority: options.priority as TaskPriority | undefined,
            dueDate: options.due,
            labels,
            order: options.order,
            needsHuman: options.clearNeedsHuman === true ? null : options.needsHuman,
            dependsOn,
          },
          opts,
        );
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

  // approve
  tasks
    .command("approve <id>")
    .description("Approve a task an agent or webhook created, by ID or ticket code")
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const id = await resolveTaskRef(storage, ref);
      const current = await storage.getTask(id);
      if (current === null) {
        throw new Error(`Task ${ref} not found`);
      }
      // Approving twice is a no-op rather than an error, so scripts can re-run it.
      const saved = current.pendingApproval === true ? await storage.updateTask(id, { pendingApproval: null }) : current;
      const approved = await withCode(storage, saved);
      const output = formatOutput(
        approved,
        () => `${approved.id}\t${approved.status}`,
        () => `Approved task ${label(approved)} '${approved.title}'`,
        options,
      );
      console.log(output);
    });

  // done
  tasks
    .command("done <id>")
    .description("Mark task as completed (done), by ID or ticket code")
    .option(OVERRIDE_BLOCKED_OPTION, OVERRIDE_BLOCKED_DESCRIPTION)
    .option("--json", "Output JSON")
    .action(async (ref: string, options: { overrideBlocked?: boolean; json?: boolean }) => {
      const storage = await getStorage();
      const id = await resolveTaskRef(storage, ref);
      const opts = await statusChangeOptions(storage, id, "done", "completeTask", options.overrideBlocked);
      const completed = await withCode(storage, await storage.completeTask(id, opts));
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

  // comment: notes on a task, oldest first. Agents keep context here; people answer questions here.
  const comment = tasks.command("comment").description("Comment on a task");

  comment
    .command("list <taskId>")
    .description("List a task's comments, oldest first")
    .option("--json", "Output JSON")
    .action(async (taskRef: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      const comments = await storage.getComments(await resolveTaskRef(storage, taskRef));
      const output = formatOutput(
        comments,
        () => comments.map((c) => `${c.id}\t${c.createdAt}\t${c.authorType}\t${c.author ?? ""}\t${JSON.stringify(c.body)}`).join("\n"),
        () => formatComments(comments),
        options,
      );
      if (output !== "") console.log(output);
    });

  comment
    .command("add <taskId> [text]")
    .description("Add a Markdown comment (use '-' for stdin, or --edit)")
    .option("-e, --edit", "Open editor to compose the comment")
    .option("--author <name>", "Name to show as the comment's author")
    .option("--agent", "Mark the comment as written by an agent rather than a person")
    .option("--json", "Output JSON")
    .action(
      async (
        taskRef: string,
        text: string | undefined,
        options: { edit?: boolean; author?: string; agent?: boolean; json?: boolean },
      ) => {
        let body = text ?? "";
        if (text === "-") {
          body = await readStdin();
        } else if (options.edit === true || text === undefined) {
          body = await readFromEditor(body);
        }

        const storage = await getStorage();
        const added = await storage.addComment({
          taskId: await resolveTaskRef(storage, taskRef),
          body,
          authorType: options.agent === true ? "agent" : "human",
          author: options.author,
        });
        const output = formatOutput(
          added,
          () => added.id,
          () => `Added comment ${added.id} to ${taskRef}`,
          options,
        );
        console.log(output);
      },
    );

  comment
    .command("delete <commentId>")
    .description("Permanently delete a comment by its ID")
    .option("--json", "Output JSON")
    .action(async (id: string, options: { json?: boolean }) => {
      const storage = await getStorage();
      await storage.deleteComment(id);
      const output = formatOutput({ deletedCommentId: id }, () => `Deleted comment ${id}`, undefined, options);
      console.log(output);
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

