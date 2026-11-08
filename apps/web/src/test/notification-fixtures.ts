import type { AgentRun, Project, Task } from "@bitig/core";
import { vi } from "vitest";

const LONG_AGO = "2026-03-01T00:00:00.000Z";

export const NOTIFY_PROJECT: Project = {
  id: "01940000-0000-7000-8000-000000000001",
  name: "Alpha",
  key: "ALP",
  description: "",
  kind: "paid",
  createdAt: LONG_AGO,
  updatedAt: LONG_AGO,
};

export function notifyTask(number: number, overrides: Partial<Task> = {}): Task {
  return {
    id: `01940000-0000-7000-8000-${String(100 + number).padStart(12, "0")}`,
    projectId: NOTIFY_PROJECT.id,
    title: `Task ${String(number)}`,
    description: "",
    status: "in_progress",
    number,
    isPublic: false,
    createdAt: LONG_AGO,
    updatedAt: LONG_AGO,
    ...overrides,
  };
}

export function notifyRun(forTask: Task, state: AgentRun["state"]): AgentRun {
  return {
    id: `01940000-0000-7000-8000-${String(900 + Number(forTask.number)).padStart(12, "0")}`,
    taskId: forTask.id,
    t3ProjectId: "t3",
    threadId: `thread-${String(forTask.number)}`,
    state,
    startedAt: "2026-03-10T10:00:00.000Z",
    updatedAt: "2026-03-10T11:00:00.000Z",
  };
}

/** A stand-in for the browser `Notification` API, which jsdom does not implement. */
export class FakeNotification {
  static permission: NotificationPermission = "default";
  static nextPermission: NotificationPermission = "granted";
  static instances: FakeNotification[] = [];
  static readonly requestPermission = vi.fn<() => Promise<NotificationPermission>>(() => {
    FakeNotification.permission = FakeNotification.nextPermission;
    return Promise.resolve(FakeNotification.permission);
  });

  readonly title: string;
  readonly options: NotificationOptions | undefined;
  onclick: ((event: Event) => void) | null = null;
  readonly close = vi.fn<() => void>();

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotification.instances.push(this);
  }

  click(): void {
    this.onclick?.(new Event("click", { cancelable: true }));
  }

  static install(permission: NotificationPermission): void {
    FakeNotification.permission = permission;
    FakeNotification.nextPermission = "granted";
    FakeNotification.instances = [];
    FakeNotification.requestPermission.mockClear();
    vi.stubGlobal("Notification", FakeNotification);
  }
}

/** An in-memory `Storage`; the test runtime's global `localStorage` is not usable. */
export class MemoryStorage implements Storage {
  private readonly items = new Map<string, string>();

  get length(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }

  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.items.delete(key);
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }

  static install(): MemoryStorage {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    return storage;
  }
}
