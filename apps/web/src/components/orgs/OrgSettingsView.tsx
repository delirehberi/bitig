import { useEffect, useState, type SyntheticEvent } from "react";
import { AlertTriangle, Building2, Check, Download, Save, Users } from "lucide-react";
import { useAuth } from "../../auth/useAuth";
import { Link } from "../../routing/Link";
import { hrefFor, navigate } from "../../routing/router";
import {
  deleteOrganisation,
  exportOrganisationData,
  getOrganisation,
  updateOrganisation,
} from "../../services/multi-user";

interface OrgSettingsViewProps {
  readonly slug: string;
}

export function OrgSettingsView({ slug }: OrgSettingsViewProps) {
  const { memberships, isAdmin, selectOrg, refreshAuth } = useAuth();
  const membership = memberships.find((m) => m.organisation.slug === slug);
  const canManage = isAdmin || membership?.role === "owner";

  const [name, setName] = useState(membership?.organisation.name ?? "");
  const [newSlug, setNewSlug] = useState(membership?.organisation.slug ?? slug);
  const [loading, setLoading] = useState(!membership);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmSlug, setConfirmSlug] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    let active = true;
    void getOrganisation(slug)
      .then((res) => {
        if (!active) return;
        setName(res.organisation.name);
        setNewSlug(res.organisation.slug);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load organisation");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [slug]);

  async function handleSave(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await updateOrganisation(slug, {
        name: name.trim(),
        slug: newSlug.trim(),
      });
      selectOrg(updated.organisation.slug);
      await refreshAuth();
      setMessage("Organisation settings updated.");
      if (updated.organisation.slug !== slug) {
        navigate(hrefFor({ name: "org_settings", slug: updated.organisation.slug }), { replace: true });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update organisation");
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    setExporting(true);
    setError(null);
    try {
      const exported = await exportOrganisationData(slug);
      const blob = new Blob([JSON.stringify(exported, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bitig-${slug}-backup.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not export organisation backup");
    } finally {
      setExporting(false);
    }
  }

  async function handleDelete(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmSlug.trim() !== slug) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteOrganisation(slug);
      await refreshAuth();
      navigate(hrefFor({ name: "overview" }), { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete organisation");
      setDeleting(false);
    }
  }

  if (loading) {
    return <p className="text-sm text-ink-3">Loading organisation settings\u2026</p>;
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 flex items-center gap-2 font-display text-2xl font-bold text-ink">
            <Building2 size={22} aria-hidden="true" className="text-accent-ink" />
            Organisation Settings
          </h1>
          <p className="m-0 mt-1 text-sm text-ink-3">
            Configure <span className="font-mono font-semibold text-ink-2">/{slug}</span>, export a backup, or delete
            the organisation.
          </p>
        </div>
        <Link
          href={hrefFor({ name: "org_members", slug })}
          className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
        >
          <Users size={14} aria-hidden="true" />
          Manage members
        </Link>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {message && (
        <div role="status" className="mb-4 flex items-center gap-1.5 rounded-md border border-ok/30 bg-paper-2 px-3 py-2 text-xs text-ink">
          <Check size={14} aria-hidden="true" className="text-ok" />
          {message}
        </div>
      )}

      <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2 className="m-0 mb-4 font-display text-base font-bold text-ink">General</h2>
        <form onSubmit={(e) => void handleSave(e)} className="flex flex-col gap-4">
          <div>
            <label htmlFor="org-settings-name" className="block text-xs font-semibold text-ink-2">
              Organisation name
            </label>
            <input
              id="org-settings-name"
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink"
              disabled={!canManage || saving}
            />
          </div>

          <div>
            <label htmlFor="org-settings-slug" className="block text-xs font-semibold text-ink-2">
              URL slug
            </label>
            <input
              id="org-settings-slug"
              type="text"
              required
              value={newSlug}
              onChange={(e) => {
                setNewSlug(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink"
              disabled={!canManage || saving}
            />
          </div>

          {canManage ? (
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
              >
                <Save size={14} aria-hidden="true" />
                {saving ? "Saving\u2026" : "Save changes"}
              </button>
            </div>
          ) : (
            <p className="m-0 text-xs text-ink-3">Only organisation owners can rename or change the URL slug.</p>
          )}
        </form>
      </section>

      {canManage && (
        <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
          <h2 className="m-0 mb-2 font-display text-base font-bold text-ink">Export organisation data</h2>
          <p className="m-0 mb-4 text-xs text-ink-3">
            Download a complete JSON snapshot of this organisation&apos;s projects, tasks, comments, checkpoints,
            attachments, webhooks, and memberships.
          </p>
          <button
            type="button"
            disabled={exporting}
            onClick={() => void handleExport()}
            className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-4 py-2 text-xs font-semibold text-ink hover:bg-paper-3 disabled:opacity-50"
          >
            <Download size={14} aria-hidden="true" />
            {exporting ? "Preparing export\u2026" : "Export JSON backup"}
          </button>
        </section>
      )}

      {canManage && (
        <section className="rounded-lg border border-danger/30 bg-paper p-6 shadow-xs">
          <h2 className="m-0 mb-2 flex items-center gap-2 font-display text-base font-bold text-danger">
            <AlertTriangle size={16} aria-hidden="true" />
            Delete organisation
          </h2>
          <p className="m-0 mb-4 text-xs text-ink-3">
            Soft-deleting this organisation archives it and hides its projects and tasks from all members. Type{" "}
            <code className="font-mono font-semibold text-ink">{slug}</code> below to confirm.
          </p>
          <form onSubmit={(e) => void handleDelete(e)} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="org-delete-confirm" className="block text-xs font-semibold text-ink-2">
                Confirm organisation slug
              </label>
              <input
                id="org-delete-confirm"
                type="text"
                placeholder={slug}
                value={confirmSlug}
                onChange={(e) => {
                  setConfirmSlug(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink"
                disabled={deleting}
              />
            </div>
            <button
              type="submit"
              disabled={deleting || confirmSlug.trim() !== slug}
              className="rounded-md bg-danger px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              {deleting ? "Deleting\u2026" : "Delete organisation"}
            </button>
          </form>
        </section>
      )}
    </div>
  );
}
