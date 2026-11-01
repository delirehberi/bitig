import { compareCheckpoints } from "./checkpoints";
import { isTaskBlocked } from "./dependencies";
import { compareComments, compareTasks } from "./entities";
import { withTaskCodes, type TaskWithCode } from "./ticket-codes";
import type { Checkpoint, Comment, Project, Task } from "./types";

export const PROJECT_WORK_LIMITS = {
  tasks: 3,
  title: 200,
  description: 1600,
  checklist: 8,
  text: 240,
  comments: 2,
  comment: 600,
  checkpointItems: 4,
  instructions: 800,
} as const;

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function selectProjectWork(project: Project, tasks: readonly Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const open = project.archived === true ? [] : tasks.filter(
    (task) => task.projectId === project.id && (task.status === "todo" || task.status === "in_progress"),
  );
  const gates = (task: Task) => ({
    pendingApproval: task.pendingApproval === true,
    blocked: isTaskBlocked(task, byId),
    needsHuman: task.needsHuman !== undefined,
  });
  const actionable = (task: Task) => !Object.values(gates(task)).some(Boolean);
  const inProgress = open.filter((task) => task.status === "in_progress").sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || compareTasks(left, right),
  );
  const next = open.filter((task) => task.status === "todo" && actionable(task)).sort(compareTasks);
  const primary = inProgress.find(actionable) ?? next[0];
  const summarize = (task: TaskWithCode) => {
    const nextSubtask = task.checklist?.find((item) => !item.done)?.text;
    return {
      id: task.id,
      code: task.code ?? null,
      title: clip(task.title, PROJECT_WORK_LIMITS.title),
      status: task.status,
      priority: task.priority ?? null,
      updatedAt: task.updatedAt,
      nextSubtask: nextSubtask === undefined ? null : clip(nextSubtask, PROJECT_WORK_LIMITS.text),
      gates: gates(task),
    };
  };
  const summaries = (selected: readonly Task[]) => withTaskCodes(selected, [project]).map(summarize);
  return {
    project: { id: project.id, key: project.key ?? null, archived: project.archived === true },
    counts: {
      inProgress: inProgress.length,
      actionableTodo: next.length,
      pendingApproval: open.filter((task) => gates(task).pendingApproval).length,
      blocked: open.filter((task) => gates(task).blocked).length,
      needsHuman: open.filter((task) => gates(task).needsHuman).length,
    },
    inProgress: summaries(inProgress.slice(0, PROJECT_WORK_LIMITS.tasks)),
    next: summaries(next.slice(0, PROJECT_WORK_LIMITS.tasks)),
    primary: primary === undefined ? null : summaries([primary])[0] ?? null,
    omittedInProgressCount: Math.max(0, inProgress.length - PROJECT_WORK_LIMITS.tasks),
    omittedNextCount: Math.max(0, next.length - PROJECT_WORK_LIMITS.tasks),
  };
}

export function buildProjectWorkContext(task: Task, checkpoints: readonly Checkpoint[], comments: readonly Comment[]) {
  const checkpoint = checkpoints.filter((entry) => entry.taskId === task.id).sort(compareCheckpoints).at(-1);
  const recentComments = comments.filter((entry) => entry.taskId === task.id).sort(
    (left, right) => compareComments(right, left),
  );
  const checklist = task.checklist ?? [];
  const snapshot = checkpoint?.stateSnapshot;
  return {
    description: clip(task.description, PROJECT_WORK_LIMITS.description),
    descriptionTruncated: task.description.length > PROJECT_WORK_LIMITS.description,
    checklist: checklist.slice(0, PROJECT_WORK_LIMITS.checklist).map((item) => ({
      text: clip(item.text, PROJECT_WORK_LIMITS.text), done: item.done,
    })),
    omittedChecklistCount: Math.max(0, checklist.length - PROJECT_WORK_LIMITS.checklist),
    comments: recentComments.slice(0, PROJECT_WORK_LIMITS.comments).map((comment) => ({
      id: comment.id, authorType: comment.authorType,
      author: comment.author === undefined ? null : clip(comment.author, PROJECT_WORK_LIMITS.text),
      createdAt: comment.createdAt, body: clip(comment.body, PROJECT_WORK_LIMITS.comment),
    })),
    omittedCommentCount: Math.max(0, recentComments.length - PROJECT_WORK_LIMITS.comments),
    checkpoint: checkpoint === undefined || snapshot === undefined ? null : {
      stepIndex: checkpoint.stepIndex,
      status: checkpoint.status,
      summary: clip(snapshot.summary, PROJECT_WORK_LIMITS.comment),
      modifiedArtifacts: snapshot.modifiedArtifacts.slice(0, PROJECT_WORK_LIMITS.checkpointItems).map(
        (text) => clip(text, PROJECT_WORK_LIMITS.text),
      ),
      omittedArtifactCount: Math.max(0, snapshot.modifiedArtifacts.length - PROJECT_WORK_LIMITS.checkpointItems),
      decisionsMade: snapshot.decisionsMade.slice(0, PROJECT_WORK_LIMITS.checkpointItems).map(
        (text) => clip(text, PROJECT_WORK_LIMITS.text),
      ),
      omittedDecisionCount: Math.max(0, snapshot.decisionsMade.length - PROJECT_WORK_LIMITS.checkpointItems),
      blockersOrErrors: snapshot.blockersOrErrors === undefined ? null : clip(
        typeof snapshot.blockersOrErrors === "string" ? snapshot.blockersOrErrors : JSON.stringify(snapshot.blockersOrErrors),
        PROJECT_WORK_LIMITS.comment,
      ),
      nextStepInstructions: clip(snapshot.nextStepInstructions, PROJECT_WORK_LIMITS.instructions),
    },
  };
}

export type ProjectWorkSummary = ReturnType<typeof selectProjectWork>;
export type ProjectWorkContext = ReturnType<typeof buildProjectWorkContext>;
