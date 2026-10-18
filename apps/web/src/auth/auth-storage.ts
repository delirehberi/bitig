export interface StoredAuth {
  readonly username: string;
  readonly authHeader: string;
}

const STORAGE_KEY = "bitig_auth_session";

export function encodeBasicAuth(username: string, password = ""): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export function getStoredAuth(): StoredAuth | null {
  try {
    if (typeof sessionStorage === "undefined") {
      return null;
    }
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "username" in parsed &&
      "authHeader" in parsed &&
      typeof (parsed as StoredAuth).username === "string" &&
      typeof (parsed as StoredAuth).authHeader === "string"
    ) {
      return parsed as StoredAuth;
    }
    return null;
  } catch {
    return null;
  }
}

export function setStoredAuth(username: string, password = ""): StoredAuth {
  const authHeader = encodeBasicAuth(username, password);
  const data: StoredAuth = { username, authHeader };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    }
  } catch {
    // SessionStorage may fail in private browsing mode; gracefully ignore
  }
  return data;
}

export function clearStoredAuth(): void {
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Ignore storage clear failure
  }
}

