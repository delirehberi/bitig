import { createContext } from "react";
import type {
  Organisation,
  OrganisationRole,
  User,
  UserOrganisationMembership,
} from "@bitig/core";
import type { CodeSendResult, LoginResult } from "../services/session";

/**
 * - `disabled`: this deployment has no dashboard sign-in (local mode).
 * - `unknown`: the Worker could not be asked; the workspace renders and its own requests report errors.
 */
export type AuthStatus = "disabled" | "checking" | "authenticated" | "unauthenticated" | "unknown";

export interface AuthContextValue {
  readonly status: AuthStatus;
  readonly user: string | null;
  readonly profile: User | null;
  readonly memberships: readonly UserOrganisationMembership[];
  readonly needsOnboarding: boolean;
  readonly currentOrg: Organisation | null;
  readonly currentRole: OrganisationRole;
  readonly isAdmin: boolean;
  selectOrg: (orgIdOrSlug: string) => void;
  refreshAuth: () => Promise<void>;
  requestSignInCode: (email: string) => Promise<CodeSendResult>;
  requestRegistrationCode: (input: {
    readonly email: string;
    readonly username: string;
    readonly displayName: string;
    readonly inviteToken?: string | undefined;
    readonly organisationName?: string | undefined;
  }) => Promise<CodeSendResult>;
  verifyAuthCode: (input: {
    readonly email: string;
    readonly code: string;
    readonly inviteToken?: string | undefined;
    readonly organisationName?: string | undefined;
  }) => Promise<LoginResult>;
  loginWithPassword: (username: string, password: string) => Promise<LoginResult>;
  loginWithNostr: () => Promise<LoginResult>;
  logout: () => Promise<void>;
  /** Marks the session as gone, e.g. after the API answered 401. */
  expire: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
