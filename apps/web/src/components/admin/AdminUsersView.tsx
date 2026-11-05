import { useEffect, useState, type SyntheticEvent } from "react";
import type { PlatformRole, UserStatus } from "@bitig/core";
import { Building2, Search, Shield, Trash2, UserPlus } from "lucide-react";
import { useAuth } from "../../auth/useAuth";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import {
  createAdminUser,
  deleteAdminUser,
  listAdminOrganisations,
  listAdminUsers,
  updateAdminUser,
  type AdminOrganisationItem,
  type AdminUserItem,
} from "../../services/multi-user";

export function AdminUsersView() {
  const { isAdmin, profile } = useAuth();
  const [users, setUsers] = useState<AdminUserItem[]>([]);
  const [orgs, setOrgs] = useState<AdminOrganisationItem[]>([]);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState<"" | PlatformRole>("");
  const [statusFilter, setStatusFilter] = useState<"" | UserStatus>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<PlatformRole>("user");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    Promise.all([
      listAdminUsers({
        ...(search.trim() ? { search: search.trim() } : {}),
        ...(roleFilter ? { platformRole: roleFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      }),
      listAdminOrganisations(),
    ]).then(
      ([userRes, orgRes]) => {
        if (!active) return;
        setUsers(userRes.users);
        setOrgs(orgRes.organisations);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load platform users");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [isAdmin, search, roleFilter, statusFilter]);

  if (!isAdmin) {
    return (
      <div role="alert" className="rounded-lg border border-danger/30 bg-danger-soft p-6 text-sm text-danger">
        Platform administrator privileges are required to view this page.
      </div>
    );
  }

  async function handleCreateUser(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newEmail.trim() || !newUsername.trim() || !newDisplayName.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createAdminUser({
        email: newEmail.trim(),
        username: newUsername.trim(),
        displayName: newDisplayName.trim(),
        platformRole: newRole,
      });
      setUsers((prev) => [{ ...created.user, orgCount: 0 }, ...prev]);
      setNewEmail("");
      setNewUsername("");
      setNewDisplayName("");
      setNewRole("user");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create user");
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateUser(id: string, patch: { platformRole?: PlatformRole; status?: UserStatus }) {
    setError(null);
    try {
      const updated = await updateAdminUser(id, patch);
      setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, ...updated.user } : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update user");
    }
  }

  async function handleDeleteUser(id: string) {
    setError(null);
    try {
      await deleteAdminUser(id);
      setUsers((prev) => prev.filter((u) => u.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete user");
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6">
        <h1 className="m-0 flex items-center gap-2 font-display text-2xl font-bold text-ink">
          <Shield size={22} aria-hidden="true" className="text-accent-ink" />
          Platform Administration
        </h1>
        <p className="m-0 mt-1 text-sm text-ink-3">
          Manage platform users, administrator roles, account status, and organisations.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <section className="mb-6 rounded-lg border border-rule bg-paper p-5 shadow-xs">
        <h2 className="m-0 mb-3 flex items-center gap-2 font-display text-base font-bold text-ink">
          <UserPlus size={16} aria-hidden="true" className="text-accent-ink" />
          Create User
        </h2>
        <form onSubmit={(e) => void handleCreateUser(e)} className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          <input
            type="email"
            required
            aria-label="New user email"
            placeholder="email@example.com"
            value={newEmail}
            onChange={(e) => {
              setNewEmail(e.target.value);
            }}
            className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink"
            disabled={creating}
          />
          <input
            type="text"
            required
            aria-label="New user username"
            placeholder="username"
            value={newUsername}
            onChange={(e) => {
              setNewUsername(e.target.value);
            }}
            className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 font-mono text-xs text-ink"
            disabled={creating}
          />
          <input
            type="text"
            required
            aria-label="New user display name"
            placeholder="Display Name"
            value={newDisplayName}
            onChange={(e) => {
              setNewDisplayName(e.target.value);
            }}
            className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink"
            disabled={creating}
          />
          <select
            aria-label="New user platform role"
            value={newRole}
            onChange={(e) => {
              setNewRole(e.target.value as PlatformRole);
            }}
            className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink"
            disabled={creating}
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
          >
            {creating ? "Creating\u2026" : "Create user"}
          </button>
        </form>
      </section>

      <section aria-labelledby="admin-users-heading" className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 id="admin-users-heading" className="m-0 font-display text-base font-bold text-ink">
            Users ({String(users.length)})
          </h2>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative flex items-center">
              <Search size={13} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-ink-3" />
              <input
                type="search"
                placeholder="Filter users\u2026"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                }}
                className="rounded-md border border-rule bg-paper-2 py-1 pr-3 pl-7 text-xs text-ink"
              />
            </label>
            <select
              aria-label="Filter by platform role"
              value={roleFilter}
              onChange={(e) => {
                setRoleFilter(e.target.value as "" | PlatformRole);
              }}
              className="rounded-md border border-rule bg-paper-2 px-2.5 py-1 text-xs text-ink"
            >
              <option value="">All roles</option>
              <option value="admin">admin</option>
              <option value="user">user</option>
            </select>
            <select
              aria-label="Filter by account status"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value as "" | UserStatus);
              }}
              className="rounded-md border border-rule bg-paper-2 px-2.5 py-1 text-xs text-ink"
            >
              <option value="">All statuses</option>
              <option value="active">active</option>
              <option value="disabled">disabled</option>
            </select>
          </div>
        </div>

        {loading ? (
          <p className="m-0 text-xs text-ink-3">Loading users\u2026</p>
        ) : users.length === 0 ? (
          <p className="m-0 text-xs text-ink-3">No matching users found.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {users.map((u) => {
              const isSelf = u.id === profile?.id;
              return (
                <li
                  key={u.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-3 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{u.displayName}</span>
                      <span className="font-mono text-2xs text-ink-3">@{u.username}</span>
                      <span className="text-2xs text-ink-3">{u.email}</span>
                    </div>
                    <div className="mt-0.5 text-2xs text-ink-3">
                      Created{" "}
                      <time dateTime={u.createdAt} title={formatFullTimestamp(u.createdAt)}>
                        {formatTimeAgo(u.createdAt)}
                      </time>
                      {u.lastLoginAt && (
                        <>
                          {" \u00b7 Last login "}
                          <time dateTime={u.lastLoginAt} title={formatFullTimestamp(u.lastLoginAt)}>
                            {formatTimeAgo(u.lastLoginAt)}
                          </time>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Platform role for ${u.username}`}
                      value={u.platformRole}
                      disabled={isSelf}
                      onChange={(e) =>
                        void handleUpdateUser(u.id, { platformRole: e.target.value as PlatformRole })
                      }
                      className="rounded border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
                    >
                      <option value="user">user</option>
                      <option value="admin">admin</option>
                    </select>

                    <select
                      aria-label={`Status for ${u.username}`}
                      value={u.status}
                      disabled={isSelf}
                      onChange={(e) => void handleUpdateUser(u.id, { status: e.target.value as UserStatus })}
                      className="rounded border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
                    >
                      <option value="active">active</option>
                      <option value="disabled">disabled</option>
                    </select>

                    {!isSelf && (
                      <button
                        type="button"
                        onClick={() => void handleDeleteUser(u.id)}
                        aria-label={`Delete user ${u.username}`}
                        className="inline-flex items-center gap-1 rounded border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                        Delete
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-labelledby="admin-orgs-heading" className="rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2
          id="admin-orgs-heading"
          className="m-0 mb-4 flex items-center gap-2 font-display text-base font-bold text-ink"
        >
          <Building2 size={16} aria-hidden="true" className="text-accent-ink" />
          All Organisations ({String(orgs.length)})
        </h2>
        {orgs.length === 0 ? (
          <p className="m-0 text-xs text-ink-3">No organisations found.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {orgs.map((org) => (
              <li
                key={org.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-2.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-ink">{org.name}</span>
                  <span className="font-mono text-2xs text-ink-3">/{org.slug}</span>
                </div>
                <span className="text-2xs text-ink-3">
                  Created{" "}
                  <time dateTime={org.createdAt} title={formatFullTimestamp(org.createdAt)}>
                    {formatTimeAgo(org.createdAt)}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
