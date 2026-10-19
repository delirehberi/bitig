/**
 * Client for the Worker's dashboard sign-in routes (apps/worker/src/routes/session.ts).
 * The session lives in an HttpOnly cookie, so the browser sends it on every
 * same-origin request and no credential is ever readable from JavaScript.
 */

const SESSION_PATH = "/api/auth/session";
const LOGIN_PATH = "/api/auth/login";
const LOGOUT_PATH = "/api/auth/logout";

const HTTP_UNAUTHORIZED = 401;
const HTTP_SERVICE_UNAVAILABLE = 503;

export type SessionCheck =
  | { readonly kind: "signed_in"; readonly user: string }
  | { readonly kind: "signed_out" }
  /** The Worker could not be asked (offline, 5xx); the caller decides what to show. */
  | { readonly kind: "unknown" };

export type LoginResult = { readonly ok: true; readonly user: string } | { readonly ok: false; readonly error: string };

/* The X-Bitig-Request header matches ApiStorage, marking these as script requests rather than form posts. */
const BASE_HEADERS = { Accept: "application/json", "X-Bitig-Request": "true" } as const;

async function readUser(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null && typeof (body as { user?: unknown }).user === "string") {
      return (body as { user: string }).user;
    }
  } catch {
    // Fall through: an unreadable body is treated like a missing user.
  }
  return null;
}

export async function checkSession(signal?: AbortSignal): Promise<SessionCheck> {
  let response: Response;
  try {
    response = await fetch(SESSION_PATH, { headers: BASE_HEADERS, credentials: "same-origin", ...(signal ? { signal } : {}) });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unknown" };
  }
  if (response.status === HTTP_UNAUTHORIZED) return { kind: "signed_out" };
  if (!response.ok) return { kind: "unknown" };
  const user = await readUser(response);
  return user === null ? { kind: "unknown" } : { kind: "signed_in", user };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch(LOGIN_PATH, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return { ok: false, error: "Could not reach the Worker. Check your connection and try again." };
  }

  if (response.ok) {
    const user = await readUser(response);
    return user === null ? { ok: false, error: "Unexpected response from the Worker" } : { ok: true, user };
  }
  if (response.status === HTTP_UNAUTHORIZED) return { ok: false, error: "Invalid username or password" };
  if (response.status === 429) return { ok: false, error: "Too many failed attempts. Try again later." };
  if (response.status === HTTP_SERVICE_UNAVAILABLE) {
    return { ok: false, error: "Sign-in is not configured on this Worker (SESSION_SECRET is missing)." };
  }
  return { ok: false, error: `Sign-in failed (HTTP ${String(response.status)})` };
}

export async function logout(): Promise<void> {
  try {
    await fetch(LOGOUT_PATH, { method: "POST", headers: BASE_HEADERS, credentials: "same-origin" });
  } catch (error) {
    // The cookie may outlive a failed request; the UI still signs out locally.
    console.warn("sign-out request failed", error);
  }
}
