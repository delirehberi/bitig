/**
 * Task connections derived from mentions: what a task mentions, and which tasks mention it.
 * They are worked out on read from task text rather than stored, so they work the same in every
 * adapter and never go stale when a description or subtask is edited.
 */
import { extractTaskMentions, taskMentions } from "./mentions";
import { withTaskCodes, type TaskWithCode } from "./ticket-codes";
import type { Comment, Project, Task, TaskStatus } from "./types";

/** How a linked task is reported: enough to show and open it. */
export interface TaskLinkSummary {
  readonly id: string;
  /** Missing while the task's project has no key or the task no number. */
  readonly code?: string;
  readonly title: string;
  readonly status: TaskStatus;
}

export interface TaskLinks {
  /** Tasks this task mentions in its description, subtasks or the given comments, in order of appearance. */
  readonly mentions: TaskLinkSummary[];
  /** Tasks whose description or subtasks mention this task, by code. */
  readonly mentionedIn: TaskLinkSummary[];
}

export interface MentionIndex {
  /** The links of `task`; pass its comments to include what they mention. */
  linksFor(task: Task, comments?: readonly Pick<Comment, "body">[]): TaskLinks;
}

function summarize(task: TaskWithCode): TaskLinkSummary {
  return {
    id: task.id,
    ...(task.code === undefined ? {} : { code: task.code }),
    title: task.title,
    status: task.status,
  };
}

/** Indexes `tasks` once by code and by who mentions whom, for any number of `linksFor` calls. */
export function buildMentionIndex(tasks: readonly Task[], projects: readonly Project[]): MentionIndex {
  const coded = withTaskCodes(tasks, projects);
  const byCode = new Map<string, TaskWithCode>();
  const codeById = new Map<string, string>();
  for (const task of coded) {
    if (task.code === undefined) continue;
    byCode.set(task.code, task);
    codeById.set(task.id, task.code);
  }
  const mentioners = new Map<string, TaskWithCode[]>();
  for (const task of coded) {
    for (const code of taskMentions(task)) {
      const list = mentioners.get(code);
      if (list === undefined) mentioners.set(code, [task]);
      else list.push(task);
    }
  }

  return {
    linksFor(task, comments = []) {
      const code = codeById.get(task.id);
      const mentioned = new Set(taskMentions({ ...task, ...(code === undefined ? {} : { code }) }));
      for (const comment of comments) {
        for (const mention of extractTaskMentions(comment.body)) {
          if (mention.code !== code) mentioned.add(mention.code);
        }
      }
      return {
        mentions: [...mentioned].flatMap((c) => {
          const target = byCode.get(c);
          return target === undefined ? [] : [summarize(target)];
        }),
        mentionedIn: code === undefined ? [] : (mentioners.get(code) ?? []).map(summarize),
      };
    },
  };
}

export interface DependencyLinks {
  /** The tasks this task depends on, in `dependsOn` order; IDs of deleted tasks are left out. */
  readonly dependsOn: TaskLinkSummary[];
  /** The tasks that depend on this task. */
  readonly dependents: TaskLinkSummary[];
}

/** Both directions of a task's dependencies, resolved among `tasks`, with ticket codes. */
export function dependencyLinks(task: Task, tasks: readonly Task[], projects: readonly Project[]): DependencyLinks {
  const coded = withTaskCodes(tasks, projects);
  const byId = new Map(coded.map((t) => [t.id, t]));
  return {
    dependsOn: (task.dependsOn ?? []).flatMap((id) => {
      const dependency = byId.get(id);
      return dependency === undefined ? [] : [summarize(dependency)];
    }),
    dependents: coded.filter((t) => t.dependsOn?.includes(task.id) === true).map(summarize),
  };
}
