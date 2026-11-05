import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Organisation, OrganisationRole, User, UserOrganisationMembership } from "@bitig/core";
import * as sessionApi from "../services/session";
import { AuthContext, type AuthContextValue, type AuthStatus } from "./auth-types";

const ACTIVE_ORG_STORAGE_KEY = "bitig:active-org";

function readStoredOrgRef(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredOrgRef(orgRef: string | null): void {
  try {
    if (orgRef) {
      window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgRef);
    } else {
      window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
    }
  } catch {
    // ignore storage errors
  }
}

interface AuthProviderProps {
  /** Whether this deployment requires dashboard sign-in. */
  readonly enabled: boolean;
  readonly children: ReactNode;
}

export function AuthProvider({ enabled, children }: AuthProviderProps) {
  const [status, setStatus] = useState<AuthStatus>(enabled ? "checking" : "disabled");
  const [user, setUser] = useState<string | null>(null);
  const [profile, setProfile] = useState<User | null>(null);
  const [memberships, setMemberships] = useState<readonly UserOrganisationMembership[]>([]);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [selectedOrgRef, setSelectedOrgRef] = useState<string | null>(() => readStoredOrgRef());

  const applySessionData = useCallback(
    (data: {
      readonly user: string;
      readonly profile?: User | undefined;
      readonly memberships?: readonly UserOrganisationMembership[] | undefined;
      readonly needsOnboarding?: boolean | undefined;
    }) => {
      setUser(data.user);
      if (data.profile !== undefined) setProfile(data.profile);
      if (data.memberships !== undefined) {
        const membershipsList = data.memberships;
        setMemberships(membershipsList);
        const firstOrg = membershipsList[0]?.organisation;
        if (firstOrg) {
          setSelectedOrgRef((prev) => {
            const stillMember =
              prev !== null &&
              membershipsList.some(
                (m) => m.organisation.id === prev || m.organisation.slug === prev,
              );
            const next = stillMember ? prev : firstOrg.slug;
            writeStoredOrgRef(next);
            return next;
          });
        }
      }
      if (data.needsOnboarding !== undefined) {
        setNeedsOnboarding(data.needsOnboarding);
      } else if (data.memberships !== undefined) {
        setNeedsOnboarding(data.memberships.length === 0);
      }
      setStatus("authenticated");
    },
    [],
  );

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    sessionApi.checkSession(controller.signal).then(
      (result) => {
        if (result.kind === "signed_in") {
          applySessionData(result);
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
  }, [enabled, applySessionData]);

  const refreshAuth = useCallback(async () => {
    const me = await sessionApi.fetchAuthMe();
    if (me) {
      applySessionData({
        user: me.profile.username,
        profile: me.profile,
        memberships: me.memberships,
        needsOnboarding: me.needsOnboarding,
      });
    }
  }, [applySessionData]);

  const applyLogin = useCallback(
    async (result: sessionApi.LoginResult) => {
      if (result.ok) {
        if (result.profile && result.memberships) {
          applySessionData(result);
        } else {
          const me = await sessionApi.fetchAuthMe();
          applySessionData({
            user: result.user,
            ...(me
              ? {
                  profile: me.profile,
                  memberships: me.memberships,
                  needsOnboarding: me.needsOnboarding,
                }
              : {}),
          });
        }
      }
      return result;
    },
    [applySessionData],
  );

  const requestSignInCode = useCallback(
    async (email: string) => sessionApi.requestSignInCode(email),
    [],
  );

  const requestRegistrationCode = useCallback(
    async (input: {
      readonly email: string;
      readonly username: string;
      readonly displayName: string;
      readonly inviteToken?: string | undefined;
      readonly organisationName?: string | undefined;
    }) => sessionApi.requestRegistrationCode(input),
    [],
  );

  const verifyAuthCode = useCallback(
    async (input: {
      readonly email: string;
      readonly code: string;
      readonly inviteToken?: string | undefined;
      readonly organisationName?: string | undefined;
    }) => applyLogin(await sessionApi.verifyAuthCode(input)),
    [applyLogin],
  );

  const loginWithPassword = useCallback(
    async (username: string, password: string) =>
      applyLogin(await sessionApi.loginWithPassword(username, password)),
    [applyLogin],
  );

  const loginWithNostr = useCallback(
    async () => applyLogin(await sessionApi.loginWithNostr()),
    [applyLogin],
  );

  const selectOrg = useCallback((orgIdOrSlug: string) => {
    setSelectedOrgRef(orgIdOrSlug);
    writeStoredOrgRef(orgIdOrSlug);
  }, []);

  const expire = useCallback(() => {
    setUser(null);
    setProfile(null);
    setMemberships([]);
    setNeedsOnboarding(false);
    setStatus((current) => (current === "disabled" ? current : "unauthenticated"));
  }, []);

  const logout = useCallback(async () => {
    await sessionApi.logout();
    expire();
  }, [expire]);

  const activeMembership = useMemo(() => {
    if (memberships.length === 0) return null;
    if (selectedOrgRef) {
      const found = memberships.find(
        (m) => m.organisation.id === selectedOrgRef || m.organisation.slug === selectedOrgRef,
      );
      if (found) return found;
    }
    return memberships[0] ?? null;
  }, [memberships, selectedOrgRef]);

  const currentOrg: Organisation | null = activeMembership?.organisation ?? null;
  const currentRole: OrganisationRole = activeMembership?.role ?? "owner";
  const isAdmin = profile?.platformRole === "admin";

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      profile,
      memberships,
      needsOnboarding,
      currentOrg,
      currentRole,
      isAdmin,
      selectOrg,
      refreshAuth,
      requestSignInCode,
      requestRegistrationCode,
      verifyAuthCode,
      loginWithPassword,
      loginWithNostr,
      logout,
      expire,
    }),
    [
      status,
      user,
      profile,
      memberships,
      needsOnboarding,
      currentOrg,
      currentRole,
      isAdmin,
      selectOrg,
      refreshAuth,
      requestSignInCode,
      requestRegistrationCode,
      verifyAuthCode,
      loginWithPassword,
      loginWithNostr,
      logout,
      expire,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
