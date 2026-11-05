import { useState, type SyntheticEvent } from "react";
import { AlertTriangle, Check, Mail, Save } from "lucide-react";
import { useAuth } from "../../auth/useAuth";
import { Link } from "../../routing/Link";
import { hrefFor, navigate } from "../../routing/router";
import {
  confirmAccountDelete,
  requestAccountDeleteCode,
  requestEmailChange,
  updateMyProfile,
  verifyEmailChange,
} from "../../services/multi-user";

export function ProfileEditView() {
  const { profile, refreshAuth, expire } = useAuth();
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [username, setUsername] = useState(profile?.username ?? "");
  const [avatarUrl, setAvatarUrl] = useState(profile?.avatarUrl ?? "");
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMessage, setProfileMessage] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Email change flow
  const [newEmail, setNewEmail] = useState("");
  const [emailStep, setEmailStep] = useState<"input" | "verify">("input");
  const [emailCode, setEmailCode] = useState("");
  const [emailBusy, setEmailBusy] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailMessage, setEmailMessage] = useState<string | null>(null);

  // Account soft-delete flow
  const [deleteStep, setDeleteStep] = useState<"idle" | "code">("idle");
  const [deleteCode, setDeleteCode] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleSaveProfile(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setProfileSaving(true);
    setProfileError(null);
    setProfileMessage(null);
    try {
      await updateMyProfile({
        displayName: displayName.trim(),
        username: username.trim(),
        avatarUrl: avatarUrl.trim() ? avatarUrl.trim() : null,
      });
      await refreshAuth();
      setProfileMessage("Profile saved.");
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Could not update profile");
    } finally {
      setProfileSaving(false);
    }
  }

  async function handleRequestEmailCode(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newEmail.trim()) return;
    setEmailBusy(true);
    setEmailError(null);
    setEmailMessage(null);
    try {
      await requestEmailChange(newEmail.trim());
      setEmailStep("verify");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Could not send verification code");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleConfirmEmailChange(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!emailCode.trim()) return;
    setEmailBusy(true);
    setEmailError(null);
    try {
      await verifyEmailChange(newEmail.trim(), emailCode.trim());
      await refreshAuth();
      setEmailStep("input");
      setNewEmail("");
      setEmailCode("");
      setEmailMessage("Email address updated.");
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : "Could not verify email change");
    } finally {
      setEmailBusy(false);
    }
  }

  async function handleRequestDeleteCode() {
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await requestAccountDeleteCode();
      setDeleteStep("code");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not send deletion code");
    } finally {
      setDeleteBusy(false);
    }
  }

  async function handleConfirmDelete(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleteCode.trim()) return;
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await confirmAccountDelete(deleteCode.trim());
      expire();
      navigate(hrefFor({ name: "login" }), { replace: true });
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Could not delete account");
      setDeleteBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold text-ink">Edit Profile</h1>
          <p className="m-0 mt-1 text-sm text-ink-3">Update your display name, username, avatar, or email.</p>
        </div>
        <Link
          href={hrefFor({ name: "profile" })}
          className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
        >
          Back to profile
        </Link>
      </div>

      <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2 className="m-0 mb-4 font-display text-base font-bold text-ink">Public profile</h2>
        {profileError && (
          <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
            {profileError}
          </div>
        )}
        {profileMessage && (
          <div role="status" className="mb-4 flex items-center gap-1.5 rounded-md border border-ok/30 bg-paper-2 px-3 py-2 text-xs font-medium text-ink">
            <Check size={14} aria-hidden="true" className="text-ok" />
            {profileMessage}
          </div>
        )}
        <form onSubmit={(e) => void handleSaveProfile(e)} className="flex flex-col gap-4">
          <div>
            <label htmlFor="profile-display-name" className="block text-xs font-semibold text-ink-2">
              Display name
            </label>
            <input
              id="profile-display-name"
              type="text"
              required
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink"
              disabled={profileSaving}
            />
          </div>

          <div>
            <label htmlFor="profile-username" className="block text-xs font-semibold text-ink-2">
              Username
            </label>
            <input
              id="profile-username"
              type="text"
              required
              value={username}
              onChange={(e) => {
                setUsername(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink"
              disabled={profileSaving}
            />
          </div>

          <div>
            <label htmlFor="profile-avatar-url" className="block text-xs font-semibold text-ink-2">
              Avatar URL <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <input
              id="profile-avatar-url"
              type="url"
              placeholder="https://example.com/avatar.png"
              value={avatarUrl}
              onChange={(e) => {
                setAvatarUrl(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink"
              disabled={profileSaving}
            />
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={profileSaving}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              <Save size={14} aria-hidden="true" />
              {profileSaving ? "Saving\u2026" : "Save changes"}
            </button>
          </div>
        </form>
      </section>

      <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2 className="m-0 mb-2 flex items-center gap-2 font-display text-base font-bold text-ink">
          <Mail size={16} aria-hidden="true" className="text-accent-ink" />
          Email address
        </h2>
        <p className="m-0 mb-4 text-xs text-ink-3">
          Current email: <strong className="font-semibold text-ink-2">{profile?.email ?? "\u2014"}</strong>. Changing
          your email sends a 6-digit verification code to the new address.
        </p>

        {emailError && (
          <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
            {emailError}
          </div>
        )}
        {emailMessage && (
          <div role="status" className="mb-4 rounded-md border border-ok/30 bg-paper-2 px-3 py-2 text-xs text-ink">
            {emailMessage}
          </div>
        )}

        {emailStep === "input" ? (
          <form onSubmit={(e) => void handleRequestEmailCode(e)} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="profile-new-email" className="block text-xs font-semibold text-ink-2">
                New email address
              </label>
              <input
                id="profile-new-email"
                type="email"
                required
                placeholder="new@example.com"
                value={newEmail}
                onChange={(e) => {
                  setNewEmail(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink"
                disabled={emailBusy}
              />
            </div>
            <button
              type="submit"
              disabled={emailBusy || !newEmail.trim()}
              className="rounded-md border border-rule bg-paper-2 px-4 py-2 text-xs font-semibold text-ink hover:bg-paper-3 disabled:opacity-50"
            >
              {emailBusy ? "Sending\u2026" : "Send verification code"}
            </button>
          </form>
        ) : (
          <form onSubmit={(e) => void handleConfirmEmailChange(e)} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="profile-email-code" className="block text-xs font-semibold text-ink-2">
                6-digit code sent to {newEmail}
              </label>
              <input
                id="profile-email-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                required
                placeholder="123456"
                value={emailCode}
                onChange={(e) => {
                  setEmailCode(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink"
                disabled={emailBusy}
              />
            </div>
            <button
              type="submit"
              disabled={emailBusy || !emailCode.trim()}
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              {emailBusy ? "Confirming\u2026" : "Confirm email"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEmailStep("input");
                setEmailCode("");
              }}
              className="rounded-md border border-rule px-3 py-2 text-xs text-ink-2"
            >
              Cancel
            </button>
          </form>
        )}
      </section>

      <section className="rounded-lg border border-danger/30 bg-paper p-6 shadow-xs">
        <h2 className="m-0 mb-2 flex items-center gap-2 font-display text-base font-bold text-danger">
          <AlertTriangle size={16} aria-hidden="true" />
          Delete account
        </h2>
        <p className="m-0 mb-4 text-xs text-ink-3">
          Deleting your account soft-deletes your user profile, revokes all active sessions and API tokens, and removes
          your memberships. You must transfer ownership or delete any organisation where you are the sole owner first.
        </p>

        {deleteError && (
          <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
            {deleteError}
          </div>
        )}

        {deleteStep === "idle" ? (
          <button
            type="button"
            disabled={deleteBusy}
            onClick={() => void handleRequestDeleteCode()}
            className="rounded-md border border-danger/40 bg-danger-soft px-4 py-2 text-xs font-semibold text-danger hover:opacity-90 disabled:opacity-50"
          >
            {deleteBusy ? "Sending confirmation code\u2026" : "Delete my account\u2026"}
          </button>
        ) : (
          <form onSubmit={(e) => void handleConfirmDelete(e)} className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="delete-account-code" className="block text-xs font-semibold text-ink-2">
                Enter the 6-digit confirmation code sent to your email
              </label>
              <input
                id="delete-account-code"
                type="text"
                inputMode="numeric"
                maxLength={6}
                required
                placeholder="123456"
                value={deleteCode}
                onChange={(e) => {
                  setDeleteCode(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm text-ink"
                disabled={deleteBusy}
              />
            </div>
            <button
              type="submit"
              disabled={deleteBusy || !deleteCode.trim()}
              className="rounded-md bg-danger px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              {deleteBusy ? "Deleting\u2026" : "Confirm account deletion"}
            </button>
            <button
              type="button"
              onClick={() => {
                setDeleteStep("idle");
                setDeleteCode("");
              }}
              className="rounded-md border border-rule px-3 py-2 text-xs text-ink-2"
            >
              Cancel
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
