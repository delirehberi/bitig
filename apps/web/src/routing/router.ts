import { useSyncExternalStore } from "react";

/*
 * A small History API router. The Worker serves index.html for every
 * path that is not /api, /health or /mcp (`not_found_handling` in
 * apps/worker/wrangler.jsonc), so deep links and refreshes land here.
 */

export type Route =
  | { readonly name: "landing" }
  | { readonly name: "overview"; readonly taskRef?: string }
  | { readonly name: "projects"; readonly archived?: true; readonly taskRef?: string }
  | {
      readonly name: "tasks";
      readonly projectId?: string;
      readonly needsHuman?: true;
      readonly awaitingApproval?: true;
      /** Shows only the tasks waiting on unfinished dependencies. */
      readonly blocked?: true;
      /** The task open in the detail view: its ticket code (`BIT-64`), or its ID while it has none. */
      readonly taskRef?: string;
    }
  | {
      /** Full-page task detail view at `/tasks/:ref`, with optional `?task=` modal quick-peek. */
      readonly name: "task";
      readonly ref: string;
      readonly taskRef?: string;
    }
  | { readonly name: "webhooks"; readonly projectId?: string; readonly taskRef?: string }
  | { readonly name: "settings"; readonly taskRef?: string }
  | { readonly name: "reports"; readonly taskRef?: string }
  | { readonly name: "profile"; readonly taskRef?: string }
  | { readonly name: "settings_profile"; readonly taskRef?: string }
  | { readonly name: "settings_security"; readonly taskRef?: string }
  | { readonly name: "org_settings"; readonly slug: string; readonly taskRef?: string }
  | { readonly name: "org_members"; readonly slug: string; readonly taskRef?: string }
  | { readonly name: "admin_users"; readonly taskRef?: string }
  | { readonly name: "login"; readonly next?: string; readonly invite?: string }
  | { readonly name: "register"; readonly next?: string; readonly invite?: string }
  | { readonly name: "not_found" };

const NAVIGATE_EVENT = "bitig:navigate";
const ARCHIVED_PARAM = "archived";
const PROJECT_PARAM = "project";
/** `?needs=human` shows only the tasks waiting on a person. */
const NEEDS_PARAM = "needs";
const NEEDS_HUMAN_VALUE = "human";
/** `?awaiting=approval` shows only the tasks an agent or webhook created that wait for approval. */
const AWAITING_PARAM = "awaiting";
const AWAITING_APPROVAL_VALUE = "approval";
/** `?blocked=true` shows only the tasks waiting on unfinished dependencies. */
const BLOCKED_PARAM = "blocked";
/** `?task=BIT-64` opens that task's detail view. */
const TASK_PARAM = "task";
const NEXT_PARAM = "next";
const INVITE_PARAM = "invite";

export const LOGIN_PATH = "/login";
export const REGISTER_PATH = "/register";
/** The dashboard's home; `/` is the public landing page. */
export const APP_PATH = "/app";
/** Time spent and completion reports, moved off the dashboard (#BIT-140). */
const REPORTS_PATH = "/reports";

function trimTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/**
 * Accepts only same-origin absolute paths, so `?next=` can't send someone to
 * another site after sign-in (`//evil.test` and `/\evil.test` are rejected).
 */
export function safeNextPath(next: string | null | undefined): string | undefined {
  if (!next?.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return undefined;
  return next;
}

export function parseRoute(pathname: string, search: string): Route {
  const params = new URLSearchParams(search);
  const taskRef = params.get(TASK_PARAM)?.trim();
  const task = taskRef ? { taskRef } : {};
  const trimmed = trimTrailingSlash(pathname);

  const taskPageMatch = /^\/tasks\/([^/]+)$/.exec(trimmed);
  if (taskPageMatch) {
    let ref: string;
    try {
      ref = decodeURIComponent(taskPageMatch[1] ?? "").trim();
    } catch {
      ref = "";
    }
    if (ref) {
      return { name: "task", ref, ...task };
    }
  }

  const orgMatch = /^\/orgs\/([^/]+)\/(settings|members)$/.exec(trimmed);
  if (orgMatch) {
    const slug = decodeURIComponent(orgMatch[1] ?? "");
    const sub = orgMatch[2];
    if (slug && sub === "settings") {
      return { name: "org_settings", slug, ...task };
    }
    if (slug && sub === "members") {
      return { name: "org_members", slug, ...task };
    }
  }

  switch (trimmed) {
    case "/":
      return { name: "landing" };
    case APP_PATH:
      return { name: "overview", ...task };
    case "/projects":
      return {
        name: "projects",
        ...(params.get(ARCHIVED_PARAM) === "true" ? { archived: true as const } : {}),
        ...task,
      };
    case "/tasks": {
      const projectId = params.get(PROJECT_PARAM);
      return {
        name: "tasks",
        ...(projectId ? { projectId } : {}),
        ...(params.get(NEEDS_PARAM) === NEEDS_HUMAN_VALUE ? { needsHuman: true as const } : {}),
        ...(params.get(AWAITING_PARAM) === AWAITING_APPROVAL_VALUE ? { awaitingApproval: true as const } : {}),
        ...(params.get(BLOCKED_PARAM) === "true" ? { blocked: true as const } : {}),
        ...task,
      };
    }
    case "/webhooks": {
      const projectId = params.get(PROJECT_PARAM);
      return {
        name: "webhooks",
        ...(projectId ? { projectId } : {}),
        ...task,
      };
    }
    case "/settings":
      return { name: "settings", ...task };
    case "/profile":
      return { name: "profile", ...task };
    case "/settings/profile":
      return { name: "settings_profile", ...task };
    case "/settings/security":
      return { name: "settings_security", ...task };
    case "/admin/users":
      return { name: "admin_users", ...task };
    case REPORTS_PATH:
      return { name: "reports", ...task };
    case LOGIN_PATH: {
      const next = safeNextPath(params.get(NEXT_PARAM));
      const invite = params.get(INVITE_PARAM)?.trim();
      return {
        name: "login",
        ...(next ? { next } : {}),
        ...(invite ? { invite } : {}),
      };
    }
    case REGISTER_PATH: {
      const next = safeNextPath(params.get(NEXT_PARAM));
      const invite = params.get(INVITE_PARAM)?.trim();
      return {
        name: "register",
        ...(next ? { next } : {}),
        ...(invite ? { invite } : {}),
      };
    }
    default:
      return { name: "not_found" };
  }
}

function withQuery(pathname: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "landing":
      return "/";
    case "not_found":
      return APP_PATH;
    case "overview": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery(APP_PATH, params);
    }
    case "projects": {
      const params = new URLSearchParams();
      if (route.archived) params.set(ARCHIVED_PARAM, "true");
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/projects", params);
    }
    case "tasks": {
      const params = new URLSearchParams();
      if (route.projectId) params.set(PROJECT_PARAM, route.projectId);
      if (route.needsHuman) params.set(NEEDS_PARAM, NEEDS_HUMAN_VALUE);
      if (route.awaitingApproval) params.set(AWAITING_PARAM, AWAITING_APPROVAL_VALUE);
      if (route.blocked) params.set(BLOCKED_PARAM, "true");
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/tasks", params);
    }
    case "task": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery(`/tasks/${encodeURIComponent(route.ref)}`, params);
    }
    case "webhooks": {
      const params = new URLSearchParams();
      if (route.projectId) params.set(PROJECT_PARAM, route.projectId);
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/webhooks", params);
    }
    case "settings": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/settings", params);
    }
    case "profile": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/profile", params);
    }
    case "settings_profile": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/settings/profile", params);
    }
    case "settings_security": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/settings/security", params);
    }
    case "org_settings": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery(`/orgs/${encodeURIComponent(route.slug)}/settings`, params);
    }
    case "org_members": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery(`/orgs/${encodeURIComponent(route.slug)}/members`, params);
    }
    case "admin_users": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery("/admin/users", params);
    }
    case "reports": {
      const params = new URLSearchParams();
      if (route.taskRef) params.set(TASK_PARAM, route.taskRef);
      return withQuery(REPORTS_PATH, params);
    }
    case "login": {
      const params = new URLSearchParams();
      if (route.next) params.set(NEXT_PARAM, route.next);
      if (route.invite) params.set(INVITE_PARAM, route.invite);
      return withQuery(LOGIN_PATH, params);
    }
    case "register": {
      const params = new URLSearchParams();
      if (route.next) params.set(NEXT_PARAM, route.next);
      if (route.invite) params.set(INVITE_PARAM, route.invite);
      return withQuery(REGISTER_PATH, params);
    }
  }
}

/** Builds an href to a task's dedicated full-page detail route (`/tasks/BIT-123`). */
export function taskPageHref(ref: string): string {
  return hrefFor({ name: "task", ref });
}

/**
 * Builds an href that opens (or closes when `taskRef` is `undefined`) the task detail modal on
 * the current workspace page while keeping the current route and query filters intact.
 */
export function taskHref(
  taskRef: string | undefined,
  locationHref = `${window.location.pathname}${window.location.search}`,
): string {
  const url = new URL(locationHref, "http://bitig.local");
  const route = parseRoute(url.pathname, url.search);
  if (
    route.name === "overview" ||
    route.name === "projects" ||
    route.name === "tasks" ||
    route.name === "task" ||
    route.name === "webhooks" ||
    route.name === "settings" ||
    route.name === "reports" ||
    route.name === "profile" ||
    route.name === "settings_profile" ||
    route.name === "settings_security" ||
    route.name === "org_settings" ||
    route.name === "org_members" ||
    route.name === "admin_users"
  ) {
    const params = new URLSearchParams(url.search);
    if (taskRef) params.set(TASK_PARAM, taskRef);
    else params.delete(TASK_PARAM);
    return withQuery(trimTrailingSlash(url.pathname), params);
  }
  return hrefFor(taskRef ? { name: "tasks", taskRef } : { name: "tasks" });
}

export function navigate(href: string, options: { readonly replace?: boolean } = {}): void {
  const current = `${window.location.pathname}${window.location.search}`;
  if (href === current) return;
  if (options.replace) {
    window.history.replaceState(null, "", href);
  } else {
    window.history.pushState(null, "", href);
  }
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATE_EVENT, onChange);
  };
}

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}`;
}

/** The current path plus query string; re-renders on navigate() and back/forward. */
export function useLocationHref(): string {
  return useSyncExternalStore(subscribe, currentHref);
}

export function useRoute(): Route {
  const href = useLocationHref();
  const url = new URL(href, window.location.origin);
  return parseRoute(url.pathname, url.search);
}
