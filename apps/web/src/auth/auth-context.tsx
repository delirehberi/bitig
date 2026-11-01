import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import * as sessionApi from "../services/session";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./auth-types";

interface AuthProviderProps {
  /** Whether this deployment requires dashboard sign-in. */
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

  const applyLogin = useCallback((result: sessionApi.LoginResult) => {
    if (result.ok) {
      setUser(result.user);
      setStatus("authenticated");
    }
    return result;
  }, []);

  const loginWithPassword = useCallback(
    async (username: string, password: string) => applyLogin(await sessionApi.loginWithPassword(username, password)),
    [applyLogin],
  );

  const loginWithNostr = useCallback(async () => applyLogin(await sessionApi.loginWithNostr()), [applyLogin]);

  const expire = useCallback(() => {
    setUser(null);
    setStatus((current) => (current === "disabled" ? current : "unauthenticated"));
  }, []);

  const logout = useCallback(async () => {
    await sessionApi.logout();
    expire();
  }, [expire]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, loginWithPassword, loginWithNostr, logout, expire }),
    [status, user, loginWithPassword, loginWithNostr, logout, expire],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
