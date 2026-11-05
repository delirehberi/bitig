import { useState, type SyntheticEvent } from "react";
import type { StorageMode } from "@bitig/core";
import {
  Building2,
  ChevronDown,
  CircleUserRound,
  KeyRound,
  LogOut,
  Plus,
  Search,
  Settings,
  Shield,
  User,
  Users,
} from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { MODE_COPY } from "../domain/modes";
import { useFeatureFlags } from "../hooks/useFeatureFlags";
import type { HealthState } from "../hooks/useHealth";
import { hrefFor, navigate } from "../routing/router";
import { createOrganisation } from "../services/multi-user";

interface HeaderProps {
  readonly mode: StorageMode;
  readonly health: HealthState;
  readonly searchQuery: string;
  readonly onSearchChange: (query: string) => void;
}

const ICON_SIZE = 16;

const DOT_CLASS: Record<HealthState["kind"], string> = {
  checking: "bg-rule-strong",
  online: "bg-ok",
  unreachable: "bg-danger",
};

/** Worker health as a dot; the label and storage backend are in its tooltip and for screen readers. */
function WorkerHealthDot({ mode, health }: { readonly mode: StorageMode; readonly health: HealthState }) {
  const state =
    health.kind === "checking"
      ? "Checking worker\u2026"
      : health.kind === "online"
        ? `Worker online \u00b7 v${health.version}`
        : `Worker unreachable \u00b7 ${health.reason}`;
  const label = `${state} \u00b7 ${MODE_COPY[mode].label} storage`;
  return (
    <span role="status" title={label} className="ml-auto inline-flex shrink-0 items-center p-2">
      <span aria-hidden="true" className={`size-2 rounded-pill ${DOT_CLASS[health.kind]}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Header({ mode, health, searchQuery, onSearchChange }: HeaderProps) {
  const {
    status,
    user,
    profile,
    memberships,
    currentOrg,
    currentRole,
    isAdmin,
    selectOrg,
    refreshAuth,
    logout,
  } = useAuth();
  const { passwordLogin } = useFeatureFlags();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newOrgOpen, setNewOrgOpen] = useState(false);
  const [newOrgName, setNewOrgName] = useState("");
  const [newOrgSlug, setNewOrgSlug] = useState("");
  const [newOrgError, setNewOrgError] = useState<string | null>(null);
  const [creatingOrg, setCreatingOrg] = useState(false);

  async function handleCreateOrg(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newOrgName.trim()) {
      setNewOrgError("Organisation name is required");
      return;
    }
    setCreatingOrg(true);
    setNewOrgError(null);
    try {
      const created = await createOrganisation({
        name: newOrgName.trim(),
        ...(newOrgSlug.trim() ? { slug: newOrgSlug.trim() } : {}),
      });
      selectOrg(created.organisation.slug);
      await refreshAuth();
      setNewOrgName("");
      setNewOrgSlug("");
      setNewOrgOpen(false);
      navigate(hrefFor({ name: "overview" }));
    } catch (err) {
      setNewOrgError(err instanceof Error ? err.message : "Could not create organisation");
    } finally {
      setCreatingOrg(false);
    }
  }

  return (
    <header className="flex items-center gap-3 border-b border-rule px-5 py-3 md:px-10">
      <label className="relative flex min-w-0 flex-1 items-center md:max-w-md">
        <span className="sr-only">Search</span>
        <Search
          size={ICON_SIZE}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 text-ink-3"
        />
        <input
          type="search"
          placeholder="Search tasks and projects\u2026"
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
          }}
          className="w-full min-w-0 rounded-pill border border-rule bg-paper-2 py-2 pr-4 pl-9 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
        />
      </label>

      <WorkerHealthDot mode={mode} health={health} />

      {passwordLogin && status === "authenticated" && user && (
        <div className="relative flex items-center gap-2">
          {memberships.length > 0 && currentOrg && (
            <div className="flex items-center gap-1">
              <label htmlFor="header-org-switcher" className="sr-only">
                Active organisation
              </label>
              <div className="inline-flex items-center gap-1.5 rounded-pill border border-rule bg-paper-2 px-2.5 py-1 text-xs font-medium text-ink">
                <Building2 size={14} aria-hidden="true" className="text-accent-ink" />
                <select
                  id="header-org-switcher"
                  aria-label="Active organisation"
                  value={currentOrg.slug}
                  onChange={(e) => {
                    if (e.target.value === "__create_org__") {
                      setNewOrgOpen(true);
                      return;
                    }
                    selectOrg(e.target.value);
                  }}
                  className="bg-transparent font-semibold text-ink focus:outline-none"
                >
                  {memberships.map((m) => (
                    <option key={m.organisation.id} value={m.organisation.slug}>
                      {m.organisation.name} ({m.role})
                    </option>
                  ))}
                  <option value="__create_org__">+ New organisation\u2026</option>
                </select>
              </div>
              {currentRole === "viewer" && (
                <span
                  title="You have read-only viewer access in this organisation"
                  className="rounded-pill border border-rule bg-paper-3 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider text-ink-3"
                >
                  Read-only
                </span>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              setMenuOpen((prev) => !prev);
            }}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="flex items-center gap-2 whitespace-nowrap rounded-pill border border-rule bg-paper-2 px-3 py-1.5 text-sm font-medium text-ink hover:bg-paper-3 focus-visible:outline-focus"
          >
            {profile?.avatarUrl ? (
              <img
                src={profile.avatarUrl}
                alt=""
                className="size-4 rounded-pill object-cover"
              />
            ) : (
              <CircleUserRound size={ICON_SIZE} aria-hidden="true" className="text-accent-ink" />
            )}
            <span>{user}</span>
            {isAdmin && (
              <span className="rounded-pill bg-accent-soft px-1.5 py-0.5 text-2xs font-bold uppercase text-accent-ink">
                Admin
              </span>
            )}
            <ChevronDown size={12} aria-hidden="true" className="text-ink-3" />
          </button>

          <button
            type="button"
            onClick={() => void logout()}
            title="Sign out"
            aria-label="Sign out"
            className="flex items-center justify-center rounded-pill border border-rule p-2 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
          >
            <LogOut size={ICON_SIZE} aria-hidden="true" />
          </button>

          {menuOpen && (
            <div
              role="menu"
              aria-label="User menu"
              className="absolute top-full right-0 z-modal mt-2 w-60 rounded-lg border border-rule bg-paper p-2 shadow-lg"
            >
              {profile && (
                <div className="mb-2 border-b border-rule px-2.5 pb-2">
                  <div className="truncate text-xs font-bold text-ink">{profile.displayName}</div>
                  <div className="truncate font-mono text-2xs text-ink-3">@{profile.username} \u00b7 {profile.email}</div>
                </div>
              )}

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  navigate(hrefFor({ name: "profile" }));
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
              >
                <User size={14} aria-hidden="true" />
                Profile
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  navigate(hrefFor({ name: "settings_profile" }));
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
              >
                <Settings size={14} aria-hidden="true" />
                Edit profile & account
              </button>

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  navigate(hrefFor({ name: "settings_security" }));
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
              >
                <KeyRound size={14} aria-hidden="true" />
                Sessions & API tokens
              </button>

              {currentOrg && (
                <>
                  <div className="my-1.5 border-t border-rule" />
                  <div className="px-2.5 py-1 text-2xs font-semibold uppercase tracking-wider text-ink-3">
                    {currentOrg.name}
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(hrefFor({ name: "org_members", slug: currentOrg.slug }));
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
                  >
                    <Users size={14} aria-hidden="true" />
                    Organisation members
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(hrefFor({ name: "org_settings", slug: currentOrg.slug }));
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
                  >
                    <Building2 size={14} aria-hidden="true" />
                    Organisation settings
                  </button>
                </>
              )}

              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setNewOrgOpen(true);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-accent-ink hover:bg-paper-2"
              >
                <Plus size={14} aria-hidden="true" />
                New organisation
              </button>

              {isAdmin && (
                <>
                  <div className="my-1.5 border-t border-rule" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      navigate(hrefFor({ name: "admin_users" }));
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs font-medium text-ink-2 hover:bg-paper-2 hover:text-ink"
                  >
                    <Shield size={14} aria-hidden="true" />
                    Platform admin: Users
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {newOrgOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="new-org-modal-title"
          className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
          onClick={() => {
            setNewOrgOpen(false);
          }}
        >
          <div
            className="w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg"
            onClick={(e) => {
              e.stopPropagation();
            }}
          >
            <h2 id="new-org-modal-title" className="m-0 mb-3 font-display text-lg font-bold text-ink">
              New Organisation
            </h2>
            {newOrgError && (
              <div role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
                {newOrgError}
              </div>
            )}
            <form onSubmit={(e) => void handleCreateOrg(e)} className="flex flex-col gap-3">
              <div>
                <label htmlFor="modal-org-name" className="block text-xs font-semibold text-ink-2">
                  Name
                </label>
                <input
                  id="modal-org-name"
                  type="text"
                  required
                  autoFocus
                  placeholder="Acme Studio"
                  value={newOrgName}
                  onChange={(e) => {
                    setNewOrgName(e.target.value);
                  }}
                  className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink"
                  disabled={creatingOrg}
                />
              </div>
              <div>
                <label htmlFor="modal-org-slug" className="block text-xs font-semibold text-ink-2">
                  Slug <span className="font-normal text-ink-3">(optional)</span>
                </label>
                <input
                  id="modal-org-slug"
                  type="text"
                  placeholder="acme-studio"
                  value={newOrgSlug}
                  onChange={(e) => {
                    setNewOrgSlug(e.target.value);
                  }}
                  className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink"
                  disabled={creatingOrg}
                />
              </div>
              <div className="mt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setNewOrgOpen(false);
                  }}
                  className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink-2"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingOrg}
                  className="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper"
                >
                  {creatingOrg ? "Creating\u2026" : "Create"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </header>
  );
}
