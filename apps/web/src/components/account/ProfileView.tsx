import { BadgeCheck, Building2, Calendar, CircleUserRound, KeyRound, Mail, Settings, Shield } from "lucide-react";
import { useAuth } from "../../auth/useAuth";
import { formatNip05 } from "./nip05";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { hrefFor, navigate } from "../../routing/router";

export function ProfileView() {
  const { user, profile, memberships, currentOrg, selectOrg } = useAuth();

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold text-ink">Profile</h1>
          <p className="m-0 mt-1 text-sm text-ink-3">Your account details and organisation memberships.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={hrefFor({ name: "settings_profile" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-paper-3"
          >
            <Settings size={14} aria-hidden="true" />
            Edit profile
          </Link>
          <Link
            href={hrefFor({ name: "settings_security" })}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-2 text-xs font-semibold text-ink transition-colors hover:bg-paper-3"
          >
            <KeyRound size={14} aria-hidden="true" />
            Sessions & tokens
          </Link>
        </div>
      </div>

      <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <div className="flex flex-wrap items-center gap-4">
          {profile?.avatarUrl ? (
            <img
              src={profile.avatarUrl}
              alt={profile.displayName}
              className="size-16 rounded-pill border border-rule object-cover"
            />
          ) : (
            <div className="flex size-16 items-center justify-center rounded-pill bg-accent-soft text-accent-ink">
              <CircleUserRound size={32} aria-hidden="true" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0 font-display text-xl font-bold text-ink">
                {profile?.displayName ?? user ?? "User"}
              </h2>
              {profile?.platformRole === "admin" && (
                <span className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 text-2xs font-bold uppercase text-accent-ink">
                  <Shield size={11} aria-hidden="true" />
                  Platform Admin
                </span>
              )}
            </div>
            {profile && (
              <p className="m-0 mt-0.5 font-mono text-xs text-ink-3">@{profile.username}</p>
            )}
          </div>
        </div>

        {profile && (
          <dl className="m-0 mt-6 grid grid-cols-1 gap-4 border-t border-rule pt-4 sm:grid-cols-2">
            <div>
              <dt className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                <Mail size={12} aria-hidden="true" />
                Email
              </dt>
              <dd className="m-0 mt-1 text-sm text-ink">{profile.email}</dd>
            </div>
            {profile.nip05 && (
              <div>
                <dt className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                  <BadgeCheck size={12} aria-hidden="true" />
                  NIP-05
                </dt>
                <dd className="m-0 mt-1 text-sm text-ink" title="Verified against the domain's nostr.json">
                  {formatNip05(profile.nip05)}
                </dd>
              </div>
            )}
            <div>
              <dt className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                <Calendar size={12} aria-hidden="true" />
                Joined
              </dt>
              <dd className="m-0 mt-1 text-sm text-ink">
                <time dateTime={profile.createdAt} title={formatFullTimestamp(profile.createdAt)}>
                  {formatTimeAgo(profile.createdAt)}
                </time>
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section aria-labelledby="profile-orgs-heading" className="rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2
          id="profile-orgs-heading"
          className="m-0 mb-4 flex items-center gap-2 font-display text-base font-bold text-ink"
        >
          <Building2 size={16} aria-hidden="true" className="text-accent-ink" />
          Organisations ({String(memberships.length)})
        </h2>

        {memberships.length === 0 ? (
          <p className="m-0 text-sm text-ink-3">You are not a member of any organisation yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {memberships.map((m) => {
              const isActive = currentOrg?.id === m.organisation.id;
              return (
                <li
                  key={m.organisation.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-ink">{m.organisation.name}</span>
                      <span className="font-mono text-xs text-ink-3">/{m.organisation.slug}</span>
                      {isActive && (
                        <span className="rounded-pill bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent-ink">
                          Active
                        </span>
                      )}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-3">
                      Role: <strong className="font-semibold text-ink-2">{m.role}</strong>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {!isActive && (
                      <button
                        type="button"
                        onClick={() => {
                          selectOrg(m.organisation.slug);
                        }}
                        className="rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-ink-2 hover:text-ink"
                      >
                        Switch to org
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        selectOrg(m.organisation.slug);
                        navigate(hrefFor({ name: "org_members", slug: m.organisation.slug }));
                      }}
                      className="rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-ink-2 hover:text-ink"
                    >
                      Members
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        selectOrg(m.organisation.slug);
                        navigate(hrefFor({ name: "org_settings", slug: m.organisation.slug }));
                      }}
                      className="rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-ink-2 hover:text-ink"
                    >
                      Settings
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
