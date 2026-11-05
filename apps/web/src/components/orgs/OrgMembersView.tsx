import { useEffect, useState, type SyntheticEvent } from "react";
import type { OrganisationRole } from "@bitig/core";
import { Building2, Copy, MailPlus, Settings, Trash2, Users } from "lucide-react";
import { useAuth } from "../../auth/useAuth";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { hrefFor, navigate } from "../../routing/router";
import {
  inviteOrganisationMember,
  listOrganisationMembers,
  removeOrganisationMember,
  revokeOrganisationInvitation,
  updateOrganisationMemberRole,
  type OrganisationInvitationItem,
  type OrganisationMemberItem,
} from "../../services/multi-user";

interface OrgMembersViewProps {
  readonly slug: string;
}

export function OrgMembersView({ slug }: OrgMembersViewProps) {
  const { profile, memberships, isAdmin, refreshAuth } = useAuth();
  const membership = memberships.find((m) => m.organisation.slug === slug);
  const canManage = isAdmin || membership?.role === "owner";

  const [members, setMembers] = useState<OrganisationMemberItem[]>([]);
  const [invitations, setInvitations] = useState<OrganisationInvitationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrganisationRole>("editor");
  const [inviting, setInviting] = useState(false);
  const [latestInviteUrl, setLatestInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listOrganisationMembers(slug).then(
      (res) => {
        if (!active) return;
        setMembers(res.members);
        setInvitations(res.invitations);
        setError(null);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load organisation members");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [slug]);

  async function handleInvite(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    setError(null);
    try {
      const res = await inviteOrganisationMember(slug, {
        email: inviteEmail.trim(),
        role: inviteRole,
      });
      setLatestInviteUrl(res.acceptUrl || `${window.location.origin}/register?invite=${res.token}`);
      setInviteEmail("");
      setInvitations((prev) => [res.invitation, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send invitation");
    } finally {
      setInviting(false);
    }
  }

  async function handleRoleChange(userId: string, role: OrganisationRole) {
    setError(null);
    try {
      await updateOrganisationMemberRole(slug, userId, role);
      setMembers((prev) => prev.map((m) => (m.userId === userId ? { ...m, role } : m)));
      await refreshAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update member role");
    }
  }

  async function handleRemoveMember(userId: string) {
    setError(null);
    try {
      await removeOrganisationMember(slug, userId);
      if (userId === profile?.id) {
        await refreshAuth();
        navigate(hrefFor({ name: "overview" }), { replace: true });
        return;
      }
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove member");
    }
  }

  async function handleRevokeInvite(id: string) {
    setError(null);
    try {
      await revokeOrganisationInvitation(slug, id);
      setInvitations((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke invitation");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 flex items-center gap-2 font-display text-2xl font-bold text-ink">
            <Users size={22} aria-hidden="true" className="text-accent-ink" />
            Organisation Members
          </h1>
          <p className="m-0 mt-1 text-sm text-ink-3">
            Members and invitations for <span className="font-mono font-semibold text-ink-2">/{slug}</span>.
          </p>
        </div>
        <Link
          href={hrefFor({ name: "org_settings", slug })}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
        >
          <Settings size={14} aria-hidden="true" />
          Organisation settings
        </Link>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      {canManage && (
        <section className="mb-6 rounded-lg border border-rule bg-paper p-5 shadow-xs">
          <h2 className="m-0 mb-2 flex items-center gap-2 font-display text-sm font-bold text-ink">
            <MailPlus size={15} aria-hidden="true" className="text-accent-ink" />
            Invite member by email
          </h2>
          <p className="m-0 mb-3 text-xs text-ink-3">
            Sends an invitation email with a join link (valid for 7 days).
          </p>
          <form onSubmit={(e) => void handleInvite(e)} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="invite-email" className="block text-xs font-semibold text-ink-2">
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                required
                placeholder="teammate@example.com"
                value={inviteEmail}
                onChange={(e) => {
                  setInviteEmail(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-sm text-ink"
                disabled={inviting}
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="block text-xs font-semibold text-ink-2">
                Role
              </label>
              <select
                id="invite-role"
                value={inviteRole}
                onChange={(e) => {
                  setInviteRole(e.target.value as OrganisationRole);
                }}
                className="mt-1 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5 text-xs text-ink"
                disabled={inviting}
              >
                <option value="owner">owner</option>
                <option value="editor">editor</option>
                <option value="viewer">viewer</option>
              </select>
            </div>
            <button
              type="submit"
              disabled={inviting || !inviteEmail.trim()}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              {inviting ? "Sending\u2026" : "Send invite"}
            </button>
          </form>
          {latestInviteUrl && (
            <div className="mt-3 rounded border border-accent/30 bg-accent-soft p-2.5 text-2xs text-accent-ink">
              <div className="font-semibold">Invite link ready:</div>
              <div className="mt-1 flex items-center gap-1.5">
                <code className="flex-1 truncate rounded bg-paper px-2 py-1 font-mono text-ink">
                  {latestInviteUrl}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(latestInviteUrl);
                  }}
                  className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 font-semibold text-paper"
                >
                  <Copy size={11} aria-hidden="true" />
                  Copy
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      <section aria-labelledby="org-members-list-heading" className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2
          id="org-members-list-heading"
          className="m-0 mb-4 flex items-center gap-2 font-display text-base font-bold text-ink"
        >
          <Building2 size={16} aria-hidden="true" className="text-accent-ink" />
          Members ({String(members.length)})
        </h2>

        {loading ? (
          <p className="m-0 text-xs text-ink-3">Loading members\u2026</p>
        ) : members.length === 0 ? (
          <p className="m-0 text-xs text-ink-3">No members found.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {members.map((m) => {
              const isSelf = m.userId === profile?.id;
              return (
                <li
                  key={m.userId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-3 text-xs"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{m.displayName}</span>
                      <span className="font-mono text-2xs text-ink-3">@{m.username}</span>
                      <span className="text-2xs text-ink-3">{m.email}</span>
                      {isSelf && (
                        <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent-ink">
                          You
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-2xs text-ink-3">
                      Joined{" "}
                      <time dateTime={m.createdAt} title={formatFullTimestamp(m.createdAt)}>
                        {formatTimeAgo(m.createdAt)}
                      </time>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {canManage ? (
                      <select
                        aria-label={`Role for ${m.username}`}
                        value={m.role}
                        onChange={(e) => void handleRoleChange(m.userId, e.target.value as OrganisationRole)}
                        className="rounded border border-rule bg-paper px-2 py-1 text-xs font-medium text-ink"
                      >
                        <option value="owner">owner</option>
                        <option value="editor">editor</option>
                        <option value="viewer">viewer</option>
                      </select>
                    ) : (
                      <span className="rounded-pill border border-rule bg-paper px-2.5 py-0.5 font-mono text-2xs text-ink-2">
                        {m.role}
                      </span>
                    )}

                    {(canManage || isSelf) && (
                      <button
                        type="button"
                        onClick={() => void handleRemoveMember(m.userId)}
                        className="inline-flex items-center gap-1 rounded border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft"
                      >
                        <Trash2 size={12} aria-hidden="true" />
                        {isSelf ? "Leave" : "Remove"}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canManage && invitations.length > 0 && (
        <section aria-labelledby="org-invites-heading" className="rounded-lg border border-rule bg-paper p-6 shadow-xs">
          <h2 id="org-invites-heading" className="m-0 mb-4 font-display text-base font-bold text-ink">
            Pending Invitations ({String(invitations.length)})
          </h2>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {invitations.map((inv) => (
              <li
                key={inv.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-2.5 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{inv.email}</span>
                    <span className="rounded bg-paper px-1.5 py-0.5 font-mono text-2xs text-ink-3">{inv.role}</span>
                  </div>
                  <div className="mt-0.5 text-2xs text-ink-3">
                    Expires{" "}
                    <time dateTime={inv.expiresAt} title={formatFullTimestamp(inv.expiresAt)}>
                      {formatFullTimestamp(inv.expiresAt)}
                    </time>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeInvite(inv.id)}
                  className="rounded border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft"
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
