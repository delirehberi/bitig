import {
  BackupBundleSchema,
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  IdSchema,
  NotFoundError,
  ProjectBundleSchema,
  ProjectSchema,
  StorageError,
  TaskFilterSchema,
  UpdateProjectInputSchema,
  UpdateTaskInputSchema,
  ValidationError,
  parseOrThrow,
  throwIfAborted,
  type BackupBundle,
  type CreateProjectInput,
  type CreateTaskInput,
  type OperationOptions,
  type Project,
  type ProjectBundle,
  type StorageProvider,
  type Task,
  type TaskFilter,
  type UpdateProjectInput,
  type UpdateTaskInput,
} from "@bitig/core";
import { AuthError } from "./errors";

export interface BasicAuthCredentials {
  readonly username: string;
  readonly password?: string;
}

export type AuthConfig =
  | string
  | BasicAuthCredentials
  | (() => string | null | undefined | Promise<string | null | undefined>);

export interface ApiStorageOptions {
  readonly baseUrl?: string;
  readonly auth?: AuthConfig;
  readonly fetch?: typeof fetch;
}

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;

function encodeBasicAuth(username: string, password = ""): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export class ApiStorage implements StorageProvider {
  private readonly baseUrl: string;
  private readonly authConfig?: AuthConfig | undefined;
  private readonly customFetch?: typeof fetch | undefined;

  constructor(options: ApiStorageOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/+$/, "");
    this.authConfig = options.auth;
    this.customFetch = options.fetch;
  }

  private async getAuthHeader(): Promise<string | undefined> {
    if (!this.authConfig) {
      return undefined;
    }
    if (typeof this.authConfig === "function") {
      const resolved = await this.authConfig();
      if (!resolved) return undefined;
      return resolved.startsWith("Basic ") || resolved.startsWith("Bearer ")
        ? resolved
        : `Basic ${resolved}`;
    }
    if (typeof this.authConfig === "string") {
      return this.authConfig.startsWith("Basic ") || this.authConfig.startsWith("Bearer ")
        ? this.authConfig
        : `Basic ${this.authConfig}`;
    }
    return encodeBasicAuth(this.authConfig.username, this.authConfig.password);
  }

  private async request(
    path: string,
    init: RequestInit,
    opts?: OperationOptions,
  ): Promise<Response> {
    throwIfAborted(opts?.signal);

    const authHeader = await this.getAuthHeader();
    const headers = new Headers(init.headers);
    if (!headers.has("X-Bitig-Request")) {
      headers.set("X-Bitig-Request", "true");
    }
    if (authHeader && !headers.has("Authorization")) {
      headers.set("Authorization", authHeader);
    }

    const fetchFn = this.customFetch ?? globalThis.fetch;
    const url = `${this.baseUrl}${path}`;

    const requestInit: RequestInit = {
      ...init,
      headers,
    };
    if (opts?.signal) {
      requestInit.signal = opts.signal as AbortSignal;
    }

    try {
      const response = await fetchFn(url, requestInit);
      return response;
    } catch (error) {
      throwIfAborted(opts?.signal);
      throw new StorageError("io", error instanceof Error ? error.message : "Network request failed", {
        cause: error,
      });
    }
  }

  private async parseJsonResponse<T>(response: Response): Promise<T> {
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new StorageError("corrupt", "Failed to parse API response as JSON", { cause: error });
    }
  }

  async getProjects(opts?: OperationOptions): Promise<Project[]> {
    throwIfAborted(opts?.signal);
    const res = await this.request("/api/projects", { method: "GET" }, opts);

    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to get projects: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Project[]>(res);
  }

  async getProject(id: string, opts?: OperationOptions): Promise<Project | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getProject id");
    const res = await this.request(`/api/projects/${encodeURIComponent(validId)}`, { method: "GET" }, opts);

    if (res.status === HTTP_NOT_FOUND) {
      return null;
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to get project ${id}: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Project>(res);
  }

  async createProject(input: CreateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(CreateProjectInputSchema, input, "createProject");

    const res = await this.request(
      "/api/projects",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      },
      opts,
    );

    if (res.status === HTTP_BAD_REQUEST) {
      const err = await this.parseJsonResponse<{ details?: readonly [] }>(res);
      throw new ValidationError("createProject", err.details ?? []);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (res.status !== HTTP_CREATED && res.status !== HTTP_OK) {
      throw new StorageError("io", `Failed to create project: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Project>(res);
  }

  async updateProject(id: string, patch: UpdateProjectInput, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateProject id");
    const validated = parseOrThrow(UpdateProjectInputSchema, patch, "updateProject");

    const res = await this.request(
      `/api/projects/${encodeURIComponent(validId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError("project", id);
    }
    if (res.status === HTTP_BAD_REQUEST) {
      const err = await this.parseJsonResponse<{ details?: readonly [] }>(res);
      throw new ValidationError("updateProject", err.details ?? []);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to update project ${id}: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Project>(res);
  }

  async deleteProject(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteProject id");

    const res = await this.request(
      `/api/projects/${encodeURIComponent(validId)}`,
      { method: "DELETE" },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError("project", id);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (res.status !== HTTP_NO_CONTENT && !res.ok) {
      throw new StorageError("io", `Failed to delete project ${id}: HTTP ${res.status.toString()}`);
    }
  }

  async getTasks(filter?: TaskFilter, opts?: OperationOptions): Promise<Task[]> {
    throwIfAborted(opts?.signal);
    const validFilter = filter ? parseOrThrow(TaskFilterSchema, filter, "getTasks filter") : undefined;

    let path = "/api/tasks";
    if (validFilter?.projectId) {
      path += `?projectId=${encodeURIComponent(validFilter.projectId)}`;
    }

    const res = await this.request(path, { method: "GET" }, opts);

    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to get tasks: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Task[]>(res);
  }

  async getTask(id: string, opts?: OperationOptions): Promise<Task | null> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "getTask id");
    const res = await this.request(`/api/tasks/${encodeURIComponent(validId)}`, { method: "GET" }, opts);

    if (res.status === HTTP_NOT_FOUND) {
      return null;
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to get task ${id}: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Task>(res);
  }

  async saveTask(input: CreateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(CreateTaskInputSchema, input, "saveTask");

    const res = await this.request(
      "/api/tasks",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError("project", input.projectId);
    }
    if (res.status === HTTP_BAD_REQUEST) {
      const err = await this.parseJsonResponse<{ details?: readonly [] }>(res);
      throw new ValidationError("saveTask", err.details ?? []);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (res.status !== HTTP_CREATED && res.status !== HTTP_OK) {
      throw new StorageError("io", `Failed to save task: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Task>(res);
  }

  async updateTask(id: string, patch: UpdateTaskInput, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "updateTask id");
    const validated = parseOrThrow(UpdateTaskInputSchema, patch, "updateTask");

    const res = await this.request(
      `/api/tasks/${encodeURIComponent(validId)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError(patch.projectId ? "project" : "task", id);
    }
    if (res.status === HTTP_BAD_REQUEST) {
      const err = await this.parseJsonResponse<{ details?: readonly [] }>(res);
      throw new ValidationError("updateTask", err.details ?? []);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to update task ${id}: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Task>(res);
  }

  async deleteTask(id: string, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "deleteTask id");

    const res = await this.request(
      `/api/tasks/${encodeURIComponent(validId)}`,
      { method: "DELETE" },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError("task", id);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (res.status !== HTTP_NO_CONTENT && !res.ok) {
      throw new StorageError("io", `Failed to delete task ${id}: HTTP ${res.status.toString()}`);
    }
  }

  async completeTask(id: string, opts?: OperationOptions): Promise<Task> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "completeTask id");

    const res = await this.request(
      `/api/tasks/${encodeURIComponent(validId)}/complete`,
      { method: "POST" },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError("task", id);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to complete task ${id}: HTTP ${res.status.toString()}`);
    }

    return this.parseJsonResponse<Task>(res);
  }

  async exportProject(id: string, opts?: OperationOptions): Promise<ProjectBundle> {
    throwIfAborted(opts?.signal);
    const validId = parseOrThrow(IdSchema, id, "exportProject id");

    const res = await this.request(
      `/api/projects/${encodeURIComponent(validId)}/export`,
      { method: "GET" },
      opts,
    );

    if (res.status === HTTP_NOT_FOUND) {
      throw new NotFoundError("project", id);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to export project ${id}: HTTP ${res.status.toString()}`);
    }

    const data = await this.parseJsonResponse<unknown>(res);
    return parseOrThrow(ProjectBundleSchema, data, "exportProject response");
  }

  async importProject(bundle: ProjectBundle, opts?: OperationOptions): Promise<Project> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(ProjectBundleSchema, bundle, "importProject");

    const res = await this.request(
      "/api/projects/import",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      },
      opts,
    );

    if (res.status === HTTP_BAD_REQUEST) {
      const err = await this.parseJsonResponse<{ details?: readonly [] }>(res);
      throw new ValidationError("importProject", err.details ?? []);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (res.status !== HTTP_CREATED && res.status !== HTTP_OK) {
      throw new StorageError("io", `Failed to import project: HTTP ${res.status.toString()}`);
    }

    const data = await this.parseJsonResponse<unknown>(res);
    return parseOrThrow(ProjectSchema, data, "importProject response");
  }

  async exportAll(opts?: OperationOptions): Promise<BackupBundle> {
    throwIfAborted(opts?.signal);

    const res = await this.request(
      "/api/backup",
      { method: "GET" },
      opts,
    );

    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok) {
      throw new StorageError("io", `Failed to export backup: HTTP ${res.status.toString()}`);
    }

    const data = await this.parseJsonResponse<unknown>(res);
    return parseOrThrow(BackupBundleSchema, data, "exportAll response");
  }

  async importBackup(backup: BackupBundle, opts?: OperationOptions): Promise<void> {
    throwIfAborted(opts?.signal);
    const validated = parseOrThrow(BackupBundleSchema, backup, "importBackup");

    const res = await this.request(
      "/api/backup/restore",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(validated),
      },
      opts,
    );

    if (res.status === HTTP_BAD_REQUEST) {
      const err = await this.parseJsonResponse<{ details?: readonly [] }>(res);
      throw new ValidationError("importBackup", err.details ?? []);
    }
    if (res.status === HTTP_UNAUTHORIZED) {
      throw new AuthError();
    }
    if (!res.ok && res.status !== HTTP_NO_CONTENT) {
      throw new StorageError("io", `Failed to restore backup: HTTP ${res.status.toString()}`);
    }
  }
}

