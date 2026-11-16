import { pickParallelBatch, type ParallelSkipReason, type TaskRunProfile } from "./run-profile";
import type { WorkQueueItem } from "./work-queue-parse";

export interface WorkQueuePlanTask {
  readonly id: string;
  readonly code: string;
  readonly projectId: string;
  readonly status: "todo" | "in_progress" | "done" | "archived";
  readonly parentId?: string | undefined;
  readonly hasChildren?: boolean | undefined;
  readonly dependsOn?: readonly string[] | undefined;
  readonly blockedBy?: readonly string[] | undefined;
  readonly pendingApproval?: boolean | undefined;
  readonly needsHuman?: string | undefined;
  readonly order?: number | undefined;
  readonly profile?: Pick<TaskRunProfile, "touches" | "parallelSafe"> | null | undefined;
}

export interface WorkQueuePlanProject {
  readonly id: string;
  readonly key: string;
  readonly connected: boolean;
  readonly serialPaths?: readonly string[] | undefined;
  readonly maxParallelChildren?: number | undefined;
}

export interface WorkQueuePlanInput {
  readonly items: readonly WorkQueueItem[];
  readonly tasks: readonly WorkQueuePlanTask[];
  readonly projects: readonly WorkQueuePlanProject[];
  readonly activeTaskIds?: readonly string[] | undefined;
  readonly queuedTaskIds?: readonly string[] | undefined;
}

export type WorkQueueClassification = "ready" | "needs_approval" | "after_queued_task" | "waits_on_unqueued_task" | "already_running" | "already_queued" | "done" | "not_found" | "project_not_connected" | "needs_person" | "unlisted_parent" | "folded" | "dependency_cycle";

export interface WorkQueuePlanItem {
  readonly item: WorkQueueItem;
  readonly code: string;
  readonly classification: WorkQueueClassification;
  readonly task?: WorkQueuePlanTask | undefined;
  readonly isUmbrella?: boolean | undefined;
  readonly related?: readonly string[] | undefined;
}

export interface WorkQueueWaveSkip {
  readonly code: string;
  readonly reason: ParallelSkipReason | "dependency";
  readonly message: string;
}

export interface WorkQueueWave {
  readonly number: number;
  readonly tasks: readonly WorkQueuePlanTask[];
  readonly skipped: readonly WorkQueueWaveSkip[];
}

export interface WorkQueueLane {
  readonly project: WorkQueuePlanProject;
  readonly needsQueueUmbrella: boolean;
  readonly items: readonly WorkQueuePlanItem[];
  readonly waves: readonly WorkQueueWave[];
}

export interface WorkQueuePlan {
  readonly items: readonly WorkQueuePlanItem[];
  readonly lanes: readonly WorkQueueLane[];
}

export function planWorkQueue(input: WorkQueuePlanInput): WorkQueuePlan {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const tasksByCode = new Map(input.tasks.map((task) => [task.code.toUpperCase(), task]));
  const projectsById = new Map(input.projects.map((project) => [project.id, project]));
  const listed = new Set(input.items.map((item) => `${item.key.toUpperCase()}-${String(item.number)}`));
  const active = new Set(input.activeTaskIds ?? []);
  const queued = new Set(input.queuedTaskIds ?? []);
  const parents = new Set(input.tasks.flatMap((task) => task.parentId ? [task.parentId] : []));
  const resolve = (reference: string): WorkQueuePlanTask | undefined => tasksById.get(reference) ?? tasksByCode.get(reference.toUpperCase());
  const label = (reference: string): string => resolve(reference)?.code ?? reference;
  const preliminary = input.items.map((item): WorkQueuePlanItem => {
    const code = `${item.key.toUpperCase()}-${String(item.number)}`;
    const task = tasksByCode.get(code);
    if (!task) return { item, code, classification: "not_found" };
    const result = (classification: WorkQueueClassification, related?: readonly string[]): WorkQueuePlanItem => ({ item, code, task, classification, isUmbrella: task.hasChildren === true || parents.has(task.id) || parents.has(task.code), ...(related ? { related } : {}) });
    if (task.status === "done" || task.status === "archived") return result("done");
    if (task.status === "in_progress" || active.has(task.id)) return result("already_running");
    if (queued.has(task.id)) return result("already_queued");
    if (!projectsById.get(task.projectId)?.connected) return result("project_not_connected");
    if (task.needsHuman) return result("needs_person", [task.needsHuman]);
    if (task.parentId) {
      const parent = resolve(task.parentId);
      return result(parent && listed.has(parent.code.toUpperCase()) ? "folded" : "unlisted_parent", [label(task.parentId)]);
    }
    if (task.pendingApproval) return result("needs_approval");
    return result("ready");
  });
  const eligibleIds = new Set(preliminary.filter((entry) => entry.classification === "ready" || entry.classification === "needs_approval").flatMap((entry) => entry.task ? [entry.task.id] : []));
  const queueOwner = (task: WorkQueuePlanTask): WorkQueuePlanTask => {
    let owner = task;
    const visited = new Set<string>();
    while (owner.parentId && !visited.has(owner.id)) {
      visited.add(owner.id);
      const parent = resolve(owner.parentId);
      if (!parent || !listed.has(parent.code.toUpperCase())) break;
      owner = parent;
    }
    return owner;
  };
  const blockersById = new Map<string, readonly string[]>();
  for (const entry of preliminary) {
    if (!entry.task || !eligibleIds.has(entry.task.id)) continue;
    const blockers = [...new Set([...(entry.task.dependsOn ?? []), ...(entry.task.blockedBy ?? [])])].filter((reference) => {
      const task = resolve(reference);
      return !task || (task.status !== "done" && task.status !== "archived");
    });
    blockersById.set(entry.task.id, blockers);
  }
  const ownerId = (reference: string): string | undefined => {
    const task = resolve(reference);
    return task ? queueOwner(task).id : undefined;
  };
  const cyclicIds = new Set<string>();
  const reaches = (current: string, target: string, visited: Set<string>): boolean => {
    if (visited.has(current)) return false;
    visited.add(current);
    return (blockersById.get(current) ?? []).some((reference) => {
      const dependency = ownerId(reference);
      return dependency === target || (dependency !== undefined && eligibleIds.has(dependency) && reaches(dependency, target, visited));
    });
  };
  for (const id of eligibleIds) {
    if (reaches(id, id, new Set())) cyclicIds.add(id);
  }
  for (const id of cyclicIds) eligibleIds.delete(id);
  let removed = true;
  while (removed) {
    removed = false;
    for (const id of eligibleIds) {
      if ((blockersById.get(id) ?? []).some((reference) => !eligibleIds.has(ownerId(reference) ?? ""))) {
        eligibleIds.delete(id);
        removed = true;
      }
    }
  }
  const items = preliminary.map((entry): WorkQueuePlanItem => {
    if (!entry.task || (entry.classification !== "ready" && entry.classification !== "needs_approval")) return entry;
    const blockers = blockersById.get(entry.task.id) ?? [];
    if (cyclicIds.has(entry.task.id)) return { ...entry, classification: "dependency_cycle", related: blockers.map(label) };
    const outside = blockers.filter((reference) => !eligibleIds.has(ownerId(reference) ?? ""));
    if (outside.length) return { ...entry, classification: "waits_on_unqueued_task", related: outside.map(label) };
    if (entry.classification === "needs_approval" || !blockers.length) return entry;
    return { ...entry, classification: "after_queued_task", related: blockers.map(label) };
  });
  const laneItemsByProject = new Map<string, WorkQueuePlanItem[]>();
  const remainingByProject = new Map<string, WorkQueuePlanTask[]>();
  const wavesByProject = new Map<string, WorkQueueWave[]>();
  for (const project of input.projects) {
    const laneItems = items.filter((entry) => entry.task?.projectId === project.id && (entry.classification === "ready" || entry.classification === "after_queued_task" || entry.classification === "needs_approval"));
    if (!laneItems.length) continue;
    if (project.maxParallelChildren !== undefined && (!Number.isInteger(project.maxParallelChildren) || project.maxParallelChildren < 1)) {
      throw new Error(`Invalid maxParallelChildren for project ${project.key}`);
    }
    const remaining = laneItems.map((entry) => entry.task).filter((task): task is WorkQueuePlanTask => task !== undefined).sort((left, right) => (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER));
    laneItemsByProject.set(project.id, laneItems);
    remainingByProject.set(project.id, remaining);
    wavesByProject.set(project.id, []);
  }
  const completed = new Set<string>();
  let waveNumber = 0;
  while ([...remainingByProject.values()].some((tasks) => tasks.length > 0)) {
    waveNumber += 1;
    const pickedThisWave: string[] = [];
    for (const project of input.projects) {
      const remaining = remainingByProject.get(project.id);
      if (!remaining?.length) continue;
      const available = remaining.filter((task) => (blockersById.get(task.id) ?? []).every((reference) => completed.has(ownerId(reference) ?? "")));
      const candidates = available.map((task) => ({ id: task.id, code: task.code, profile: task.profile }));
      const batch = pickParallelBatch(candidates, { cap: project.maxParallelChildren, serialPaths: project.serialPaths });
      const pickedIds = new Set(batch.picked.map((candidate) => candidate.id));
      const pickedTasks = available.filter((task) => pickedIds.has(task.id));
      const skipped: WorkQueueWaveSkip[] = batch.skipped.map((skip) => ({ code: skip.task.code, reason: skip.reason, message: skip.message }));
      for (const task of remaining.filter((candidate) => !available.includes(candidate))) {
        const waiting = (blockersById.get(task.id) ?? []).filter((reference) => !completed.has(ownerId(reference) ?? ""));
        skipped.push({ code: task.code, reason: "dependency", message: `Waiting for ${waiting.map(label).join(", ")}` });
      }
      wavesByProject.get(project.id)?.push({ number: waveNumber, tasks: pickedTasks, skipped });
      pickedThisWave.push(...pickedIds);
      remainingByProject.set(project.id, remaining.filter((task) => !pickedIds.has(task.id)));
    }
    if (!pickedThisWave.length) break;
    for (const id of pickedThisWave) completed.add(id);
  }
  const lanes = input.projects.flatMap((project): WorkQueueLane[] => {
    const laneItems = laneItemsByProject.get(project.id);
    return laneItems ? [{ project, needsQueueUmbrella: laneItems.length >= 2, items: laneItems, waves: wavesByProject.get(project.id) ?? [] }] : [];
  });
  return { items, lanes };
}
