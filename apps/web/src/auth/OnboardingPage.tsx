import { useState, type SyntheticEvent } from "react";
import { Building2, LogOut } from "lucide-react";
import { acceptInvitation, createOrganisation } from "../services/multi-user";
import { useAuth } from "./useAuth";

export function OnboardingPage() {
  const { user, selectOrg, refreshAuth, logout } = useAuth();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleCreateOrg(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) {
      setError("Organisation name is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createOrganisation({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
      });
      selectOrg(created.organisation.slug);
      await refreshAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create organisation");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAcceptInvite(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!inviteToken.trim()) {
      setError("Invitation token is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const joined = await acceptInvitation(inviteToken.trim());
      selectOrg(joined.organisation.slug);
      await refreshAuth();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not accept invitation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper-2 p-4">
      <div className="w-full max-w-md rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <div className="mb-5 flex items-center justify-between gap-3">
          <img src="/logo.svg" alt="bitig" width={81} height={32} />
          <button
            type="button"
            onClick={() => void logout()}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs font-medium text-ink-3 hover:bg-paper-2 hover:text-ink"
          >
            <LogOut size={14} aria-hidden="true" />
            Sign out
          </button>
        </div>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <Building2 size={18} aria-hidden="true" />
          </div>
          <div>
            <h1 className="m-0 font-display text-lg font-bold text-ink">Create your first organisation</h1>
            <p className="m-0 text-xs text-ink-3">
              Welcome{user ? `, ${user}` : ""}! Every project and task in Bitig belongs to an organisation. Create one
              below to get started.
            </p>
          </div>
        </div>

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
          >
            {error}
          </div>
        )}

        <form onSubmit={(event) => void handleCreateOrg(event)} className="flex flex-col gap-4">
          <div>
            <label htmlFor="onboard-org-name" className="block text-xs font-semibold text-ink-2">
              Organisation name
            </label>
            <input
              id="onboard-org-name"
              name="name"
              type="text"
              required
              autoFocus
              placeholder="Acme Engineering"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={submitting}
            />
          </div>

          <div>
            <label htmlFor="onboard-org-slug" className="block text-xs font-semibold text-ink-2">
              URL slug <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <input
              id="onboard-org-slug"
              name="slug"
              type="text"
              placeholder="acme-engineering"
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={submitting}
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? "Creating organisation\u2026" : "Create organisation & continue"}
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-2xs uppercase tracking-wider text-ink-3" aria-hidden="true">
          <span className="h-px flex-1 bg-rule" />
          or have an invite token?
          <span className="h-px flex-1 bg-rule" />
        </div>

        <form onSubmit={(event) => void handleAcceptInvite(event)} className="flex gap-2">
          <label htmlFor="onboard-invite-token" className="sr-only">
            Invitation token
          </label>
          <input
            id="onboard-invite-token"
            type="text"
            placeholder="Paste invitation token\u2026"
            value={inviteToken}
            onChange={(event) => {
              setInviteToken(event.target.value);
            }}
            className="min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-3 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
            disabled={submitting}
          />
          <button
            type="submit"
            disabled={submitting || !inviteToken.trim()}
            className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-paper-3 disabled:opacity-50"
          >
            Join
          </button>
        </form>
      </div>
    </main>
  );
}
