import type {
  AiRouterApiStyle,
  ProjectRunSettings,
  ResolvedRunSelection,
  RunLevel,
  RunLevelModelBinding,
  T3ModelSelection,
  TaskRunProfile,
} from "@bitig/core";

/**
 * REST client for run orchestration settings (#BIT-188): organisation run levels and their model map
 * (#BIT-186), the organisation AI router (#BIT-187), project run settings, and task run profiles.
 */

const BASE_HEADERS = {
  Accept: "application/json",
  "X-Bitig-Request": "true",
} as const;

const ACTIVE_ORG_STORAGE_KEY = "bitig:active-org";
const HTTP_NO_CONTENT = 204;

/** A validation issue as returned in `details` by the worker's `validation_error` responses. */
export interface ApiIssue {
  readonly message: string;
  readonly path: readonly (string | number)[];
}

export class RunOrchestrationApiError extends Error {
  override readonly name = "RunOrchestrationApiError";
  readonly status: number;
  readonly issues: readonly ApiIssue[];

  constructor(status: number, message: string, issues: readonly ApiIssue[] = []) {
    super(message);
    this.status = status;
    this.issues = issues;
  }

  /** True when the server refused to remove a level that tasks or projects still use. */
  get needsReplacementLevel(): boolean {
    return this.issues.some((issue) => issue.path.includes("replacementKey"));
  }
}

/** Task-scoped calls carry the active organisation like the rest of the T3 client; org-scoped calls name it in the path. */
function headers(withActiveOrg: boolean, json: boolean): Record<string, string> {
  const result: Record<string, string> = { ...BASE_HEADERS };
  if (json) result["Content-Type"] = "application/json";
  if (!withActiveOrg || typeof window === "undefined") return result;
  try {
    const org = window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
    if (org) result["X-Bitig-Org"] = org;
  } catch (err) {
    console.warn("Could not read the active organisation", err);
  }
  return result;
}

function readIssues(details: unknown): ApiIssue[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const { message, path } = raw as { message?: unknown; path?: unknown };
    if (typeof message !== "string") return [];
    const safePath = Array.isArray(path)
      ? path.filter((p): p is string | number => typeof p === "string" || typeof p === "number")
      : [];
    return [{ message, path: safePath }];
  });
}

async function toApiError(response: Response, fallback: string): Promise<RunOrchestrationApiError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    // Not JSON: report the plain HTTP status instead.
    return new RunOrchestrationApiError(response.status, `${fallback} (HTTP ${String(response.status)})`);
  }
  const rec = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const issues = readIssues(rec.details);
  const nonBlank = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  const message =
    nonBlank(rec.message) ??
    nonBlank(issues[0]?.message) ??
    nonBlank(rec.error) ??
    `${fallback} (HTTP ${String(response.status)})`;
  return new RunOrchestrationApiError(response.status, message, issues);
}

/** Checks a response body's shape, so an unexpected answer fails as an error instead of breaking a view. */
type Guard<T> = (body: unknown) => body is T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRunLevelsResponse(body: unknown): body is RunLevelsResponse {
  return isRecord(body) && Array.isArray(body.levels) && Array.isArray(body.models);
}

function isAiRouterSettingsView(body: unknown): body is AiRouterSettingsView {
  return isRecord(body) && typeof body.baseUrl === "string" && typeof body.hasToken === "boolean";
}

function isAiRouterTestResult(body: unknown): body is AiRouterTestResult {
  return isRecord(body) && typeof body.ok === "boolean";
}

function isProjectRunSettings(body: unknown): body is ProjectRunSettings {
  return isRecord(body) && Array.isArray(body.serialPaths) && typeof body.maxParallelChildren === "number";
}

function isTaskRunProfileResponse(body: unknown): body is TaskRunProfileResponse {
  return (
    isRecord(body) &&
    (body.profile === null || isRecord(body.profile)) &&
    isRecord(body.resolved) &&
    typeof body.resolved.source === "string" &&
    typeof body.routerEnabled === "boolean"
  );
}

function isSuggestRunProfileResponse(body: unknown): body is SuggestRunProfileResponse {
  return isTaskRunProfileResponse(body) && typeof (body as unknown as Record<string, unknown>).stored === "boolean";
}

function isRunProfilesListResponse(body: unknown): body is RunProfilesListResponse {
  return isRecord(body) && Array.isArray(body.profiles) && Array.isArray(body.levels);
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "DELETE";
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly withActiveOrg: boolean;
  readonly fallback: string;
}

async function request<T>(path: string, options: RequestOptions, guard: Guard<T>): Promise<T> {
  const hasBody = options.body !== undefined;
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: headers(options.withActiveOrg, hasBody),
    credentials: "same-origin",
    ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw await toApiError(response, options.fallback);
  }
  const body: unknown = response.status === HTTP_NO_CONTENT ? undefined : await response.json();
  if (!guard(body)) {
    throw new RunOrchestrationApiError(response.status, `${options.fallback}: unexpected response`);
  }
  return body;
}

function orgPath(orgIdOrSlug: string, suffix: string): string {
  return `/api/orgs/${encodeURIComponent(orgIdOrSlug)}/${suffix}`;
}

// ---------------------------------------------------------------------------
// Organisation run levels
// ---------------------------------------------------------------------------

export interface RunLevelsResponse {
  readonly levels: RunLevel[];
  readonly models: RunLevelModelBinding[];
}

export interface SaveRunLevelsInput {
  readonly levels: readonly { key: string; label: string; description: string; order: number }[];
  /** The full model map: `hostId: null` is the default for every host, other entries override one host. */
  readonly models: readonly { levelKey: string; hostId: string | null; selection: T3ModelSelection }[];
  /** Removed level key → the kept level that takes over its tasks and projects. */
  readonly replacementKeys?: Readonly<Record<string, string>> | undefined;
}

export function fetchRunLevels(orgIdOrSlug: string, signal?: AbortSignal): Promise<RunLevelsResponse> {
  return request(orgPath(orgIdOrSlug, "run-levels"), {
    signal,
    withActiveOrg: false,
    fallback: "Could not load task levels",
  }, isRunLevelsResponse);
}

export function saveRunLevels(orgIdOrSlug: string, input: SaveRunLevelsInput): Promise<RunLevelsResponse> {
  return request(orgPath(orgIdOrSlug, "run-levels"), {
    method: "PUT",
    body: input,
    withActiveOrg: false,
    fallback: "Could not save task levels",
  }, isRunLevelsResponse);
}

// ---------------------------------------------------------------------------
// Organisation AI router
// ---------------------------------------------------------------------------

/** The router settings as the server shows them: the token is never returned, only whether it is set. */
export interface AiRouterSettingsView {
  readonly orgId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiStyle: AiRouterApiStyle;
  readonly hasToken: boolean;
  readonly tokenLast4?: string | undefined;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly updatedAt?: string | undefined;
}

export interface SaveAiRouterInput {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiStyle: AiRouterApiStyle;
  readonly enabled: boolean;
  /** A new token replaces the stored one; omit to keep it. */
  readonly apiToken?: string | undefined;
  readonly clearToken?: boolean | undefined;
}

export interface AiRouterTestResult {
  readonly ok: boolean;
  readonly status?: number | undefined;
  readonly error?: string | undefined;
  readonly suggestion?: { readonly level: string; readonly reason: string; readonly confidence: number } | undefined;
}

export function fetchAiRouter(orgIdOrSlug: string, signal?: AbortSignal): Promise<AiRouterSettingsView> {
  return request(orgPath(orgIdOrSlug, "ai-router"), {
    signal,
    withActiveOrg: false,
    fallback: "Could not load AI router settings",
  }, isAiRouterSettingsView);
}

export function saveAiRouter(orgIdOrSlug: string, input: SaveAiRouterInput): Promise<AiRouterSettingsView> {
  return request(orgPath(orgIdOrSlug, "ai-router"), {
    method: "PUT",
    body: input,
    withActiveOrg: false,
    fallback: "Could not save AI router settings",
  }, isAiRouterSettingsView);
}

export function deleteAiRouter(orgIdOrSlug: string): Promise<AiRouterSettingsView> {
  return request(orgPath(orgIdOrSlug, "ai-router"), {
    method: "DELETE",
    withActiveOrg: false,
    fallback: "Could not remove AI router settings",
  }, isAiRouterSettingsView);
}

/** Tests the endpoint with the unsaved form values; an omitted token falls back to the stored one. */
export function testAiRouter(
  orgIdOrSlug: string,
  input: { baseUrl: string; model: string; apiStyle: AiRouterApiStyle; apiToken?: string | undefined },
): Promise<AiRouterTestResult> {
  return request(orgPath(orgIdOrSlug, "ai-router/test"), {
    method: "POST",
    body: input,
    withActiveOrg: false,
    fallback: "Could not test the AI router",
  }, isAiRouterTestResult);
}

// ---------------------------------------------------------------------------
// Project run settings
// ---------------------------------------------------------------------------

export interface SaveProjectRunSettingsInput {
  readonly defaultRunLevel: string | null;
  readonly serialPaths: readonly string[];
  readonly maxParallelChildren: number;
}

export function fetchProjectRunSettings(projectId: string, signal?: AbortSignal): Promise<ProjectRunSettings> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/run-settings`, {
    signal,
    withActiveOrg: true,
    fallback: "Could not load project run settings",
  }, isProjectRunSettings);
}

export function saveProjectRunSettings(
  projectId: string,
  input: SaveProjectRunSettingsInput,
): Promise<ProjectRunSettings> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/run-settings`, {
    method: "PUT",
    body: input,
    withActiveOrg: true,
    fallback: "Could not save project run settings",
  }, isProjectRunSettings);
}

// ---------------------------------------------------------------------------
// Task run profiles
// ---------------------------------------------------------------------------

export interface StoredRunProfile extends TaskRunProfile {
  readonly taskId: string;
  readonly updatedBy?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export interface TaskRunProfileResponse {
  readonly profile: StoredRunProfile | null;
  readonly resolved: ResolvedRunSelection;
  readonly nextLevelUp?: RunLevel | undefined;
  readonly routerEnabled: boolean;
}

export interface SuggestRunProfileResponse extends TaskRunProfileResponse {
  /** False when the router answered nothing usable, or when a manual or agent profile is kept. */
  readonly stored: boolean;
  readonly suggestion: { readonly level: string; readonly reason: string } | null;
}

/** Fields a person sets on a task's run profile; `null` clears one. The server records `source: "manual"`. */
export interface SaveTaskRunProfileInput {
  readonly level: string | null;
  readonly selection: T3ModelSelection | null;
  readonly touches: readonly string[] | null;
  readonly parallelSafe: boolean | null;
  /** Cleared when a person changes the level, since the router's effort and reason belonged to the old one. */
  readonly effort?: null | undefined;
  readonly reason?: null | undefined;
  readonly confidence?: null | undefined;
}

export interface RunProfilesListResponse {
  readonly profiles: StoredRunProfile[];
  readonly levels: RunLevel[];
}

function taskPath(taskId: string, suffix: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/${suffix}`;
}

export function fetchTaskRunProfile(taskId: string, signal?: AbortSignal): Promise<TaskRunProfileResponse> {
  return request(taskPath(taskId, "run-profile"), {
    signal,
    withActiveOrg: true,
    fallback: "Could not load the run profile",
  }, isTaskRunProfileResponse);
}

export function saveTaskRunProfile(taskId: string, input: SaveTaskRunProfileInput): Promise<TaskRunProfileResponse> {
  return request(taskPath(taskId, "run-profile"), {
    method: "PUT",
    body: input,
    withActiveOrg: true,
    fallback: "Could not save the run profile",
  }, isTaskRunProfileResponse);
}

export function clearTaskRunProfile(taskId: string): Promise<TaskRunProfileResponse> {
  return request(taskPath(taskId, "run-profile"), {
    method: "DELETE",
    withActiveOrg: true,
    fallback: "Could not clear the run profile",
  }, isTaskRunProfileResponse);
}

export function suggestTaskRunProfile(taskId: string, signal?: AbortSignal): Promise<SuggestRunProfileResponse> {
  return request(taskPath(taskId, "run-profile/suggest"), {
    method: "POST",
    signal,
    withActiveOrg: true,
    fallback: "Could not get a suggestion from the AI router",
  }, isSuggestRunProfileResponse);
}

export function fetchRunProfiles(signal?: AbortSignal): Promise<RunProfilesListResponse> {
  return request("/api/t3/run-profiles", {
    signal,
    withActiveOrg: true,
    fallback: "Could not load run profiles",
  }, isRunProfilesListResponse);
}
