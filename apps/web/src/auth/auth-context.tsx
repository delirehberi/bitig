import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as sessionApi from "../services/session";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./auth-types";

interface AuthProviderProps {
  /** Whether this deployment signs in with a password (the passwordLogin feature flag). */
  readonly enabled: boolean;
  readonly children: ReactNode;
}

export function AuthProvider({ enabled, children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>(enabled ? "checking" : "disabled");
  const [user, setUser] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    sessionApi.checkSession(controller.signal).then(
      (result) => {
        if (result.kind === "signed_in") {
          setUser(result.user);
          setStatus("authenticated");
        } else {
          setStatus(result.kind === "signed_out" ? "unauthenticated" : "unknown");
        }
      },
      (error: unknown) => {
        // Unmount cancelled the request; there is no UI left to update.
        if (controller.signal.aborted) return;
        console.error("unexpected session check failure", error);
        setStatus("unknown");
      },
    );

    return () => {
      controller.abort();
    };
  }, [enabled]);

  const login = useCallback(async (username: string, password: string) => {
    const result = await sessionApi.login(username, password);
    if (result.ok) {
      setUser(result.user);
      setStatus("authenticated");
    }
    return result;
  }, []);

  const expire = useCallback(() => {
    setUser(null);
    setStatus((current) => (current === "disabled" ? current : "unauthenticated"));
  }, []);

  const logout = useCallback(async () => {
    await sessionApi.logout();
    expire();
  }, [expire]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, login, logout, expire }),
    [status, user, login, logout, expire],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
