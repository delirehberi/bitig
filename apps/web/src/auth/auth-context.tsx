import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { clearStoredAuth, encodeBasicAuth, getStoredAuth, setStoredAuth } from "./auth-storage";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./auth-types";

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [initialStored] = useState(() => getStoredAuth());
  const [status, setStatus] = useState<AuthStatus>(() =>
    initialStored ? "checking" : "unauthenticated",
  );
  const [user, setUser] = useState<string | null>(() => initialStored?.username ?? null);
  const [authHeader, setAuthHeader] = useState<string | null>(
    () => initialStored?.authHeader ?? null,
  );

  useEffect(() => {
    if (!initialStored) {
      return;
    }

    const controller = new AbortController();
    fetch("/api/projects", {
      headers: { Authorization: initialStored.authHeader },
      signal: controller.signal,
    })
      .then((res) => {
        if (res.status === HTTP_OK) {
          setUser(initialStored.username);
          setAuthHeader(initialStored.authHeader);
          setStatus("authenticated");
        } else if (res.status === HTTP_UNAUTHORIZED) {
          clearStoredAuth();
          setUser(null);
          setAuthHeader(null);
          setStatus("unauthenticated");
        } else {
          setUser(initialStored.username);
          setAuthHeader(initialStored.authHeader);
          setStatus("authenticated");
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        console.warn("Auth check failed during initial load", err);
        setUser(initialStored.username);
        setAuthHeader(initialStored.authHeader);
        setStatus("authenticated");
      });

    return () => {
      controller.abort();
    };
  }, [initialStored]);

  const login = useCallback(
    async (username: string, password = ""): Promise<{ success: boolean; error?: string }> => {
      const header = encodeBasicAuth(username, password);

      try {
        const res = await fetch("/api/projects", {
          headers: { Authorization: header },
        });

        if (res.status === HTTP_OK) {
          setStoredAuth(username, password);
          setUser(username);
          setAuthHeader(header);
          setStatus("authenticated");
          return { success: true };
        }

        if (res.status === HTTP_UNAUTHORIZED) {
          return { success: false, error: "Invalid username or password" };
        }

        return {
          success: false,
          error: `Authentication failed (HTTP ${res.status.toString()})`,
        };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Network error during authentication",
        };
      }
    },
    [],
  );

  const logout = useCallback(() => {
    clearStoredAuth();
    setUser(null);
    setAuthHeader(null);
    setStatus("unauthenticated");
  }, []);

  const value: AuthContextValue = {
    status,
    user,
    authHeader,
    login,
    logout,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

