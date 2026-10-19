/**
 * Ticket codes such as `BIT-12`: a project key plus a task number that is unique within the project.
 * Storage adapters assign both; these pure helpers keep the rules in one place.
 */
import { DERIVED_PROJECT_KEY_LENGTH, FALLBACK_PROJECT_KEY, PROJECT_KEY_PATTERN } from "./constants";
import { NotFoundError, ValidationError } from "./errors";
import { BUNDLE_VERSION, IdSchema, ProjectKeySchema } from "./schemas";
import type { BackupBundle, Project, ProjectBundle, Task } from "./types";
import type { OperationOptions, StorageProvider } from "../storage/provider";

const KEY_MAX_LENGTH = 10;
const CODE_PATTERN = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/;

/** Case-insensitive key comparison set; keys are stored uppercase. */
function keySet(keys: Iterable<string>): Set<string> {
  return new Set([...keys].map((key) => key.toUpperCase()));
}

/**
 * A key from the first letters and digits of `name` (`Bitig` → `BIT`, `news.emre.xyz` → `NEW`),
 * made unique against `takenKeys` by appending a counter (`BIT2`, `BIT3`, …).
 */
export function deriveProjectKey(name: string, takenKeys: Iterable<string>): string {
  const letters = name
    .toUpperCase()
    .normalize("NFKD")
    .replace(/[^A-Z0-9]/g, "")
    .replace(/^[0-9]+/, "");
  const base = letters.length >= 2 ? letters.slice(0, DERIVED_PROJECT_KEY_LENGTH) : FALLBACK_PROJECT_KEY;
  const taken = keySet(takenKeys);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = base.slice(0, KEY_MAX_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Rejects `key` when another project already uses it. */
export function assertProjectKeyAvailable(key: string, takenKeys: Iterable<string>, context: string): void {
  if (keySet(takenKeys).has(key.toUpperCase())) {
    throw new ValidationError(context, [
      { code: "custom", path: ["key"], message: `Project key ${key} is already in use`, input: key },
    ]);
  }
}

/** The number for a new task in a project: one past the highest number its tasks have. */
export function nextTaskNumber(projectTasks: Iterable<Pick<Task, "number">>): number {
  let max = 0;
  for (const task of projectTasks) {
    if (task.number !== undefined && task.number > max) max = task.number;
  }
  return max + 1;
}

export function formatTaskCode(key: string, number: number): string {
  return `${key}-${String(number)}`;
}

/** The task's code, or `undefined` while the project or task still lacks a key or number. */
export function taskCode(task: Pick<Task, "number">, project: Pick<Project, "key"> | undefined): string | undefined {
  if (project?.key === undefined || task.number === undefined) return undefined;
  return formatTaskCode(project.key, task.number);
}

export interface ParsedTaskCode {
  readonly key: string;
  readonly number: number;
}

/** Parses `BIT-12`, `bit-12` or `BIT-012`; returns `null` for anything else. */
export function parseTaskCode(code: string): ParsedTaskCode | null {
  const match = CODE_PATTERN.exec(code.trim());
  if (!match?.[1] || !match[2]) return null;
  const key = match[1].toUpperCase();
  const number = Number(match[2]);
  if (!PROJECT_KEY_PATTERN.test(key) || !Number.isSafeInteger(number) || number < 1) return null;
  return { key, number };
}

/** Finds the task a code points at among `projects` and `tasks`. */
export function findTaskByCode(
  code: ParsedTaskCode,
  projects: readonly Project[],
  tasks: readonly Task[],
): Task | undefined {
  const project = projects.find((p) => p.key === code.key);
  if (project === undefined) return undefined;
  return tasks.find((t) => t.projectId === project.id && t.number === code.number);
}

/**
 * Gives projects without a key a derived one and numbers tasks without a number, oldest first
 * after the highest existing number. Returns only the bundles that changed, ready to import.
 *
 * A project without a key has never shown a code, so all of its tasks are renumbered oldest
 * first, including tasks that got a number while the project was still keyless.
 */
export function assignMissingTicketCodes(backup: BackupBundle): ProjectBundle[] {
  const taken = new Set(backup.bundles.flatMap((b) => (b.project.key === undefined ? [] : [b.project.key])));
  const changed: ProjectBundle[] = [];
  for (const bundle of backup.bundles) {
    let project = bundle.project;
    const keyless = project.key === undefined;
    if (project.key === undefined) {
      const key = deriveProjectKey(project.name, taken);
      taken.add(key);
      project = { ...project, key };
    }
    let next = keyless ? 1 : nextTaskNumber(bundle.tasks);
    const toNumber = [...bundle.tasks]
      .filter((t) => keyless || t.number === undefined)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1));
    const numbers = new Map<string, number>();
    for (const task of toNumber) {
      const number = next++;
      if (task.number !== number) numbers.set(task.id, number);
    }
    if (project === bundle.project && numbers.size === 0) continue;
    changed.push({
      version: BUNDLE_VERSION,
      exportedAt: bundle.exportedAt,
      project,
      tasks: bundle.tasks.map((t) => {
        const number = numbers.get(t.id);
        return number === undefined ? t : { ...t, number };
      }),
    });
  }
  return changed;
}

export interface TicketCodeBackfillResult {
  readonly projects: number;
  readonly tasks: number;
}

/** Runs `assignMissingTicketCodes` against stored data and imports the changed projects. */
export async function backfillTicketCodes(
  storage: StorageProvider,
  opts?: OperationOptions,
): Promise<TicketCodeBackfillResult> {
  const backup = await storage.exportAll(opts);
  const before = new Map(backup.bundles.map((b) => [b.project.id, b]));
  let projects = 0;
  let tasks = 0;
  for (const bundle of assignMissingTicketCodes(backup)) {
    const previous = before.get(bundle.project.id);
    if (previous?.project.key === undefined) projects++;
    tasks += bundle.tasks.filter((t, i) => previous?.tasks[i]?.number !== t.number).length;
    await storage.importProject(bundle, opts);
  }
  return { projects, tasks };
}

/** A task with its ticket code, as tools and the CLI show it. */
export type TaskWithCode = Task & { readonly code?: string };

/** Adds `code` to each task whose project has a key and which has a number. */
export function withTaskCodes(tasks: readonly Task[], projects: readonly Project[]): TaskWithCode[] {
  const byId = new Map(projects.map((p) => [p.id, p]));
  return tasks.map((task) => {
    const code = taskCode(task, byId.get(task.projectId));
    return code === undefined ? task : { ...task, code };
  });
}

function invalidReference(context: string, ref: string, expected: string): ValidationError {
  return new ValidationError(context, [{ code: "custom", path: [], message: `Expected ${expected}`, input: ref }]);
}

/** Resolves a task ID or a ticket code (`BIT-12`) to the task's ID. */
export async function resolveTaskRef(storage: StorageProvider, ref: string, opts?: OperationOptions): Promise<string> {
  const trimmed = ref.trim();
  if (IdSchema.safeParse(trimmed).success) return trimmed;
  const code = parseTaskCode(trimmed);
  if (code === null) throw invalidReference("task", ref, "a task ID or a ticket code like BIT-12");
  const project = (await storage.getProjects(opts)).find((p) => p.key === code.key);
  if (project === undefined) throw new NotFoundError("task", formatTaskCode(code.key, code.number));
  const task = (await storage.getTasks({ projectId: project.id }, opts)).find((t) => t.number === code.number);
  if (task === undefined) throw new NotFoundError("task", formatTaskCode(code.key, code.number));
  return task.id;
}

/** Resolves a project ID or a project key (`BIT`) to the project's ID. */
export async function resolveProjectRef(
  storage: StorageProvider,
  ref: string,
  opts?: OperationOptions,
): Promise<string> {
  const trimmed = ref.trim();
  if (IdSchema.safeParse(trimmed).success) return trimmed;
  const key = ProjectKeySchema.safeParse(trimmed);
  if (!key.success) throw invalidReference("project", ref, "a project ID or a project key like BIT");
  const project = (await storage.getProjects(opts)).find((p) => p.key === key.data);
  if (project === undefined) throw new NotFoundError("project", key.data);
  return project.id;
}
