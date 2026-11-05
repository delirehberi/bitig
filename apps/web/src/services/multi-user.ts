import type {
  BackupBundle,
  Organisation,
  OrganisationRole,
  PlatformRole,
  User,
  UserOrganisationMembership,
  UserStatus,
} from "@bitig/core";

const BASE_HEADERS = {
  Accept: "application/json",
  "X-Bitig-Request": "true",
} as const;

export interface SessionDeviceInfo {
  readonly id: string;
  readonly userId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
  readonly current: boolean;
}

export interface AccessTokenItem {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly name: string;
  readonly prefix: string;
  readonly createdAt: string;
  readonly lastUsedAt?: string | undefined;
  readonly expiresAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export interface OrganisationMemberItem {
  readonly orgId: string;
  readonly userId: string;
  readonly role: OrganisationRole;
  readonly createdAt: string;
  readonly email: string;
  readonly username: string;
  readonly displayName: string;
  readonly avatarUrl?: string | undefined;
}

export interface OrganisationInvitationItem {
  readonly id: string;
  readonly orgId: string;
  readonly email: string;
  readonly role: OrganisationRole;
  readonly invitedBy: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface PublicInvitationPreview {
  readonly id: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly orgSlug: string;
  readonly email: string;
  readonly role: OrganisationRole;
  readonly expiresAt: string;
}

export interface AdminUserItem extends User {
  readonly orgCount: number;
}

export interface AdminOrganisationItem extends Organisation {
  readonly memberCount: number;
  readonly projectCount: number;
}

async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    let message = `Request failed (HTTP ${String(response.status)})`;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      if (body.message) message = body.message;
      else if (body.error) message = body.error;
    } catch {
      // ignore
    }
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function getMeProfile(): Promise<{
  readonly user: User;
  readonly memberships: UserOrganisationMembership[];
  readonly stats: { readonly openTasks: number; readonly completedTasks: number };
}> {
  return apiJson("/api/me");
}

export async function updateMyProfile(patch: {
  readonly displayName?: string;
  readonly username?: string;
  readonly avatarUrl?: string | null;
}): Promise<{ readonly user: User }> {
  return apiJson("/api/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function requestEmailChange(email: string): Promise<{ readonly status: string }> {
  return apiJson("/api/me/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function verifyEmailChange(
  email: string,
  code: string,
): Promise<{ readonly user: User }> {
  return apiJson("/api/me/email/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, code }),
  });
}

export async function listMySessions(): Promise<SessionDeviceInfo[]> {
  return apiJson("/api/me/sessions");
}

export async function revokeMySession(id: string): Promise<void> {
  return apiJson(`/api/me/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeOtherSessions(): Promise<{ readonly revokedCount: number }> {
  return apiJson("/api/me/sessions/revoke-others", { method: "POST" });
}

export async function listMyTokens(): Promise<AccessTokenItem[]> {
  return apiJson("/api/me/tokens");
}

export async function createMyToken(input: {
  readonly orgId: string;
  readonly name: string;
  readonly expiresAt?: string | null;
}): Promise<{ readonly token: string; readonly credential: AccessTokenItem }> {
  return apiJson("/api/me/tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function revokeMyToken(id: string): Promise<void> {
  return apiJson(`/api/me/tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function requestAccountDeleteCode(): Promise<{ readonly status: string }> {
  return apiJson("/api/me/delete/code", { method: "POST" });
}

export async function confirmAccountDelete(code: string): Promise<void> {
  return apiJson("/api/me/delete/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

export async function listMyOrganisations(): Promise<{
  readonly organisations: UserOrganisationMembership[];
}> {
  return apiJson("/api/orgs");
}

export async function createOrganisation(input: {
  readonly name: string;
  readonly slug?: string;
}): Promise<{ readonly organisation: Organisation; readonly role: OrganisationRole }> {
  return apiJson("/api/orgs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getOrganisation(
  idOrSlug: string,
): Promise<{ readonly organisation: Organisation; readonly role: OrganisationRole }> {
  return apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}`);
}

export async function updateOrganisation(
  idOrSlug: string,
  patch: { readonly name?: string; readonly slug?: string },
): Promise<{ readonly organisation: Organisation; readonly role: OrganisationRole }> {
  return apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteOrganisation(idOrSlug: string): Promise<void> {
  await apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}`, { method: "DELETE" });
}

export async function exportOrganisationData(idOrSlug: string): Promise<{
  readonly organisation: { readonly id: string; readonly name: string; readonly slug: string };
  readonly backup: BackupBundle;
}> {
  return apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}/export`);
}

export async function listOrganisationMembers(idOrSlug: string): Promise<{
  readonly members: OrganisationMemberItem[];
  readonly invitations: OrganisationInvitationItem[];
}> {
  return apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}/members`);
}

export async function updateOrganisationMemberRole(
  idOrSlug: string,
  userId: string,
  role: OrganisationRole,
): Promise<void> {
  await apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}/members/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export async function removeOrganisationMember(idOrSlug: string, userId: string): Promise<void> {
  await apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}/members/${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

export async function inviteOrganisationMember(
  idOrSlug: string,
  input: { readonly email: string; readonly role: OrganisationRole },
): Promise<{
  readonly invitation: OrganisationInvitationItem;
  readonly token: string;
  readonly acceptUrl: string;
}> {
  return apiJson(`/api/orgs/${encodeURIComponent(idOrSlug)}/invitations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function revokeOrganisationInvitation(idOrSlug: string, invId: string): Promise<void> {
  await apiJson(
    `/api/orgs/${encodeURIComponent(idOrSlug)}/invitations/${encodeURIComponent(invId)}`,
    { method: "DELETE" },
  );
}

export async function getPublicInvitationInfo(token: string): Promise<{
  readonly invitation: PublicInvitationPreview;
}> {
  return apiJson(`/api/invitations/info?token=${encodeURIComponent(token)}`);
}

export async function acceptInvitation(token: string): Promise<{
  readonly ok: boolean;
  readonly orgId: string;
  readonly role: OrganisationRole;
  readonly organisation: Organisation;
}> {
  return apiJson("/api/invitations/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

export async function listAdminUsers(params?: {
  readonly search?: string;
  readonly platformRole?: PlatformRole;
  readonly status?: UserStatus;
}): Promise<{
  readonly users: AdminUserItem[];
  readonly total: number;
}> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set("search", params.search);
  if (params?.platformRole) qs.set("platformRole", params.platformRole);
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiJson(`/api/admin/users${suffix}`);
}

export async function createAdminUser(input: {
  readonly email: string;
  readonly username?: string;
  readonly displayName?: string;
  readonly platformRole?: PlatformRole;
}): Promise<{ readonly user: User }> {
  return apiJson("/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateAdminUser(
  userId: string,
  patch: {
    readonly displayName?: string;
    readonly username?: string;
    readonly platformRole?: PlatformRole;
    readonly status?: UserStatus;
  },
): Promise<{ readonly user: User }> {
  return apiJson(`/api/admin/users/${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteAdminUser(userId: string): Promise<void> {
  await apiJson(`/api/admin/users/${encodeURIComponent(userId)}`, { method: "DELETE" });
}

export async function listAdminOrganisations(): Promise<{
  readonly organisations: AdminOrganisationItem[];
}> {
  return apiJson("/api/admin/orgs");
}
