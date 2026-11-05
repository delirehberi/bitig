/**
 * Client for the Worker's dashboard sign-in routes (apps/worker/src/routes/session.ts).
 * The session lives in an HttpOnly cookie, so the browser sends it on every
 * same-origin request and no credential is ever readable from JavaScript.
 */
import type { User, UserOrganisationMembership } from "@bitig/core";

const SESSION_PATH = "/api/auth/session";
const ME_PATH = "/api/auth/me";
const CODE_PATH = "/api/auth/code";
const REGISTER_PATH = "/api/auth/register";
const VERIFY_PATH = "/api/auth/verify";
const PASSWORD_LOGIN_PATH = "/api/auth/login";
const CHALLENGE_PATH = "/api/auth/challenge";
const NOSTR_LOGIN_PATH = "/api/auth/nostr";
const LOGOUT_PATH = "/api/auth/logout";

const HTTP_UNAUTHORIZED = 401;
const HTTP_CONFLICT = 409;
const HTTP_SERVICE_UNAVAILABLE = 503;

export type SessionCheck =
  | {
      readonly kind: "signed_in";
      readonly user: string;
      readonly profile?: User | undefined;
      readonly memberships?: readonly UserOrganisationMembership[] | undefined;
      readonly needsOnboarding?: boolean | undefined;
    }
  | { readonly kind: "signed_out" }
  /** The Worker could not be asked (offline, 5xx); the caller decides what to show. */
  | { readonly kind: "unknown" };

export type LoginResult =
  | {
      readonly ok: true;
      readonly user: string;
      readonly profile?: User | undefined;
      readonly memberships?: readonly UserOrganisationMembership[] | undefined;
      readonly needsOnboarding?: boolean | undefined;
    }
  | { readonly ok: false; readonly error: string; readonly field?: string | undefined };

export type CodeSendResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly field?: string | undefined };

/* The X-Bitig-Request header matches ApiStorage, marking these as script requests rather than form posts. */
const BASE_HEADERS = { Accept: "application/json", "X-Bitig-Request": "true" } as const;

interface AuthPayload {
  readonly user?: string;
  readonly profile?: User;
  readonly memberships?: UserOrganisationMembership[];
  readonly needsOnboarding?: boolean;
}

async function readAuthPayload(response: Response): Promise<AuthPayload | null> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null && typeof (body as { user?: unknown }).user === "string") {
      const obj = body as {
        user: string;
        profile?: User;
        memberships?: UserOrganisationMembership[];
        needsOnboarding?: boolean;
      };
      return {
        user: obj.user,
        ...(obj.profile ? { profile: obj.profile } : {}),
        ...(Array.isArray(obj.memberships) ? { memberships: obj.memberships } : {}),
        ...(typeof obj.needsOnboarding === "boolean" ? { needsOnboarding: obj.needsOnboarding } : {}),
      };
    }
  } catch {
    // Fall through: an unreadable body is treated like a missing user.
  }
  return null;
}

export async function fetchAuthMe(signal?: AbortSignal): Promise<{
  readonly profile: User;
  readonly memberships: UserOrganisationMembership[];
  readonly needsOnboarding: boolean;
} | null> {
  try {
    const response = await fetch(ME_PATH, {
      headers: BASE_HEADERS,
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    if (
      typeof body === "object" &&
      body !== null &&
      typeof (body as { user?: unknown }).user === "object" &&
      (body as { user: unknown }).user !== null &&
      Array.isArray((body as { memberships?: unknown }).memberships)
    ) {
      const typed = body as {
        user: User;
        memberships: UserOrganisationMembership[];
        needsOnboarding?: boolean;
      };
      return {
        profile: typed.user,
        memberships: typed.memberships,
        needsOnboarding: typed.needsOnboarding ?? typed.memberships.length === 0,
      };
    }
  } catch {
    // Ignore when /api/auth/me is not mocked in unit tests
  }
  return null;
}

export async function checkSession(signal?: AbortSignal): Promise<SessionCheck> {
  let response: Response;
  try {
    response = await fetch(SESSION_PATH, {
      headers: BASE_HEADERS,
      credentials: "same-origin",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { kind: "unknown" };
  }
  if (response.status === HTTP_UNAUTHORIZED) return { kind: "signed_out" };
  if (!response.ok) return { kind: "unknown" };
  const payload = await readAuthPayload(response);
  if (!payload?.user) return { kind: "unknown" };

  const me = await fetchAuthMe(signal);
  return {
    kind: "signed_in",
    user: payload.user,
    ...(me
      ? {
          profile: me.profile,
          memberships: me.memberships,
          needsOnboarding: me.needsOnboarding,
        }
      : {
          ...(payload.profile ? { profile: payload.profile } : {}),
          ...(payload.memberships ? { memberships: payload.memberships } : {}),
          ...(payload.needsOnboarding !== undefined ? { needsOnboarding: payload.needsOnboarding } : {}),
        }),
  };
}

interface NostrProvider {
  signEvent(event: {
    readonly kind: number;
    readonly created_at: number;
    readonly content: string;
    readonly tags: string[][];
  }): Promise<unknown>;
}

interface ChallengeResponse {
  readonly event: {
    readonly kind: number;
    readonly created_at: number;
    readonly content: string;
    readonly tags: string[][];
  };
}

async function readErrorDetails(
  response: Response,
): Promise<{ readonly message: string | null; readonly errorCode: string | null }> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null) {
      const obj = body as { message?: unknown; error?: unknown };
      return {
        message: typeof obj.message === "string" ? obj.message : null,
        errorCode: typeof obj.error === "string" ? obj.error : null,
      };
    }
  } catch {
    // Fall through
  }
  return { message: null, errorCode: null };
}

export async function requestSignInCode(email: string): Promise<CodeSendResult> {
  let response: Response;
  try {
    response = await fetch(CODE_PATH, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ email }),
    });
  } catch {
    return { ok: false, error: "Could not reach the Worker. Check your connection and try again." };
  }

  if (response.ok) return { ok: true };
  const { message } = await readErrorDetails(response);
  if (response.status === 429) {
    return { ok: false, error: message ?? "Too many requests. Please wait a few minutes and try again." };
  }
  if (response.status === HTTP_SERVICE_UNAVAILABLE) {
    return { ok: false, error: message ?? "Email sign-in is not configured on this Worker." };
  }
  return { ok: false, error: message ?? `Could not send verification code (HTTP ${String(response.status)})` };
}

export async function requestRegistrationCode(input: {
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly inviteToken?: string | undefined;
  readonly organisationName?: string | undefined;
}): Promise<CodeSendResult> {
  let response: Response;
  try {
    response = await fetch(REGISTER_PATH, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: "Could not reach the Worker. Check your connection and try again." };
  }

  if (response.ok) return { ok: true };
  const { message, errorCode } = await readErrorDetails(response);
  if (response.status === HTTP_CONFLICT || errorCode === "username_taken") {
    return { ok: false, error: message ?? "That username is already taken.", field: "username" };
  }
  if (response.status === 429) {
    return { ok: false, error: message ?? "Too many requests. Please wait a few minutes and try again." };
  }
  if (response.status === HTTP_SERVICE_UNAVAILABLE) {
    return { ok: false, error: message ?? "Registration is not configured on this Worker." };
  }
  return { ok: false, error: message ?? `Registration failed (HTTP ${String(response.status)})` };
}

export async function verifyAuthCode(input: {
  readonly email: string;
  readonly code: string;
  readonly inviteToken?: string | undefined;
  readonly organisationName?: string | undefined;
}): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch(VERIFY_PATH, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(input),
    });
  } catch {
    return { ok: false, error: "Could not reach the Worker. Check your connection and try again." };
  }

  if (response.ok) {
    const payload = await readAuthPayload(response);
    if (!payload?.user) return { ok: false, error: "Unexpected response from the Worker" };
    return {
      ok: true,
      user: payload.user,
      ...(payload.profile ? { profile: payload.profile } : {}),
      ...(payload.memberships ? { memberships: payload.memberships } : {}),
      ...(payload.needsOnboarding !== undefined ? { needsOnboarding: payload.needsOnboarding } : {}),
    };
  }

  const { message, errorCode } = await readErrorDetails(response);
  if (response.status === HTTP_CONFLICT || errorCode === "username_taken") {
    return { ok: false, error: message ?? "That username is already taken.", field: "username" };
  }
  if (response.status === HTTP_UNAUTHORIZED) {
    return { ok: false, error: message ?? "Invalid or expired verification code." };
  }
  if (response.status === 403) {
    return { ok: false, error: message ?? "This account has been disabled." };
  }
  if (response.status === 429) {
    return { ok: false, error: "Too many failed attempts. Try again later." };
  }
  return { ok: false, error: message ?? `Verification failed (HTTP ${String(response.status)})` };
}

export async function loginWithPassword(username: string, password: string): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch(PASSWORD_LOGIN_PATH, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username, password }),
    });
  } catch {
    return { ok: false, error: "Could not reach the Worker. Check your connection and try again." };
  }

  if (response.ok) {
    const payload = await readAuthPayload(response);
    return !payload?.user
      ? { ok: false, error: "Unexpected response from the Worker" }
      : { ok: true, user: payload.user };
  }
  const { message } = await readErrorDetails(response);
  if (response.status === HTTP_UNAUTHORIZED) return { ok: false, error: "Invalid username or password" };
  if (response.status === 429) return { ok: false, error: "Too many failed attempts. Try again later." };
  if (response.status === HTTP_SERVICE_UNAVAILABLE) {
    return { ok: false, error: message ?? "Password sign-in is not configured on this Worker." };
  }
  return { ok: false, error: `Sign-in failed (HTTP ${String(response.status)})` };
}

export async function loginWithNostr(): Promise<LoginResult> {
  const provider = (globalThis as unknown as { nostr?: NostrProvider }).nostr;
  if (!provider) return { ok: false, error: "Install or enable a NIP-07 Nostr extension to sign in." };
  let response: Response;
  try {
    const challenge = await fetch(CHALLENGE_PATH, {
      method: "POST",
      headers: BASE_HEADERS,
      credentials: "same-origin",
    });
    if (!challenge.ok) {
      const { message } = await readErrorDetails(challenge);
      return {
        ok: false,
        error: message ?? `Could not create sign-in challenge (HTTP ${String(challenge.status)})`,
      };
    }
    const body = (await challenge.json()) as ChallengeResponse;
    const signedEvent = await provider.signEvent(body.event);
    response = await fetch(NOSTR_LOGIN_PATH, {
      method: "POST",
      headers: { ...BASE_HEADERS, "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(signedEvent),
    });
  } catch {
    return { ok: false, error: "Nostr sign-in failed. Check your extension and connection, then try again." };
  }

  if (response.ok) {
    const payload = await readAuthPayload(response);
    return !payload?.user
      ? { ok: false, error: "Unexpected response from the Worker" }
      : { ok: true, user: payload.user };
  }
  const { message } = await readErrorDetails(response);
  if (response.status === HTTP_UNAUTHORIZED) {
    return { ok: false, error: "This Nostr identity is not authorized or the challenge expired." };
  }
  if (response.status === 429) return { ok: false, error: "Too many failed attempts. Try again later." };
  if (response.status === HTTP_SERVICE_UNAVAILABLE) {
    return { ok: false, error: message ?? "Nostr sign-in is not configured on this Worker." };
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
