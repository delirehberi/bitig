import { useSyncExternalStore } from "react";

/*
 * A small History API router. The dashboard has four screens, so a routing
 * library would cost more than it buys. The Worker serves index.html for every
 * path that is not /api, /health or /mcp (`not_found_handling` in
 * apps/worker/wrangler.jsonc), so deep links and refreshes land here.
 */

export type Route =
  | { readonly name: "overview" }
  | { readonly name: "projects" }
  | { readonly name: "tasks"; readonly projectId?: string }
  | { readonly name: "login"; readonly next?: string }
  | { readonly name: "not_found" };

const NAVIGATE_EVENT = "bitig:navigate";
const PROJECT_PARAM = "project";
const NEXT_PARAM = "next";

export const LOGIN_PATH = "/login";

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
  switch (trimTrailingSlash(pathname)) {
    case "/":
      return { name: "overview" };
    case "/projects":
      return { name: "projects" };
    case "/tasks": {
      const projectId = params.get(PROJECT_PARAM);
      return projectId ? { name: "tasks", projectId } : { name: "tasks" };
    }
    case LOGIN_PATH: {
      const next = safeNextPath(params.get(NEXT_PARAM));
      return next ? { name: "login", next } : { name: "login" };
    }
    default:
      return { name: "not_found" };
  }
}

export function hrefFor(route: Route): string {
  switch (route.name) {
    case "overview":
    case "not_found":
      return "/";
    case "projects":
      return "/projects";
    case "tasks":
      return route.projectId
        ? `/tasks?${new URLSearchParams({ [PROJECT_PARAM]: route.projectId }).toString()}`
        : "/tasks";
    case "login":
      return route.next ? `${LOGIN_PATH}?${new URLSearchParams({ [NEXT_PARAM]: route.next }).toString()}` : LOGIN_PATH;
  }
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
