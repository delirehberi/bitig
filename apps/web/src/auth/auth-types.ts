import { createContext } from "react";
import type { LoginResult } from "../services/session";

/**
 * - `disabled`: this deployment has no password sign-in (Nostr or local mode).
 * - `unknown`: the Worker could not be asked; the workspace renders and its own requests report errors.
 */
export type AuthStatus = "disabled" | "checking" | "authenticated" | "unauthenticated" | "unknown";

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: string | null;
  login: (username: string, password: string) => Promise<LoginResult>;
  logout: () => Promise<void>;
  /** Marks the session as gone, e.g. after the API answered 401. */
  expire: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
