import { useEffect, useState, type SyntheticEvent } from "react";
import { Mail, UserPlus } from "lucide-react";
import { Link } from "../routing/Link";
import { hrefFor, navigate } from "../routing/router";
import { getPublicInvitationInfo, type PublicInvitationPreview } from "../services/multi-user";
import { useAuth } from "./useAuth";

interface RegisterPageProps {
  readonly next?: string | undefined;
  readonly invite?: string | undefined;
}

export function RegisterPage({ next, invite }: RegisterPageProps) {
  const { requestRegistrationCode, verifyAuthCode } = useAuth();
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [organisationName, setOrganisationName] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"details" | "code">("details");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [inviteInfo, setInviteInfo] = useState<PublicInvitationPreview | null>(null);

  useEffect(() => {
    if (!invite) return;
    let active = true;
    void getPublicInvitationInfo(invite)
      .then((res) => {
        if (!active) return;
        setInviteInfo(res.invitation);
        if (res.invitation.email) {
          setEmail((prev) => prev || res.invitation.email);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [invite]);

  async function handleRequestCode(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !username.trim() || !displayName.trim()) {
      setError("Email, username, and display name are required");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await requestRegistrationCode({
      email: email.trim(),
      username: username.trim(),
      displayName: displayName.trim(),
      ...(invite ? { inviteToken: invite } : {}),
      ...(organisationName.trim() ? { organisationName: organisationName.trim() } : {}),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setStep("code");
  }

  async function handleVerifyCode(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim()) {
      setError("Verification code is required");
      return;
    }
    setSubmitting(true);
    setError(null);
    const result = await verifyAuthCode({
      email: email.trim(),
      code: code.trim(),
      ...(invite ? { inviteToken: invite } : {}),
      ...(organisationName.trim() ? { organisationName: organisationName.trim() } : {}),
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    navigate(next ?? hrefFor({ name: "overview" }), { replace: true });
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper-2 p-4">
      <div className="w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-3">
          <img src="/logo.svg" alt="bitig" width={81} height={32} />
        </div>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            {step === "code" ? <Mail size={18} aria-hidden="true" /> : <UserPlus size={18} aria-hidden="true" />}
          </div>
          <div>
            <h1 className="m-0 font-display text-lg font-bold text-ink">Create Account</h1>
            <p className="m-0 text-xs text-ink-3">
              {step === "code"
                ? `Enter the 6-digit verification code sent to ${email}.`
                : "Register with your email — no password required."}
            </p>
          </div>
        </div>

        {inviteInfo && (
          <div className="mb-4 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-accent-ink">
            Joining <strong>{inviteInfo.orgName}</strong> as{" "}
            <span className="font-mono">{inviteInfo.role}</span>.
          </div>
        )}

        {error && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs font-medium text-danger"
          >
            {error}
          </div>
        )}

        {step === "details" ? (
          <form onSubmit={(event) => void handleRequestCode(event)} className="flex flex-col gap-4">
            <div>
              <label htmlFor="register-email" className="block text-xs font-semibold text-ink-2">
                Email
              </label>
              <input
                id="register-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                placeholder="you@example.com"
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                disabled={submitting}
              />
            </div>

            <div>
              <label htmlFor="register-username" className="block text-xs font-semibold text-ink-2">
                Username
              </label>
              <input
                id="register-username"
                name="username"
                type="text"
                autoComplete="username"
                required
                placeholder="alice"
                value={username}
                onChange={(event) => {
                  setUsername(event.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                disabled={submitting}
              />
            </div>

            <div>
              <label htmlFor="register-display-name" className="block text-xs font-semibold text-ink-2">
                Display name
              </label>
              <input
                id="register-display-name"
                name="displayName"
                type="text"
                autoComplete="name"
                required
                placeholder="Alice Example"
                value={displayName}
                onChange={(event) => {
                  setDisplayName(event.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                disabled={submitting}
              />
            </div>

            {!invite && (
              <div>
                <label htmlFor="register-org-name" className="block text-xs font-semibold text-ink-2">
                  Organisation name <span className="font-normal text-ink-3">(optional — can create in onboarding)</span>
                </label>
                <input
                  id="register-org-name"
                  name="organisationName"
                  type="text"
                  placeholder="Acme Labs"
                  value={organisationName}
                  onChange={(event) => {
                    setOrganisationName(event.target.value);
                  }}
                  className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  disabled={submitting}
                />
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Sending verification code\u2026" : "Send verification code"}
            </button>

            <p className="m-0 text-center text-xs text-ink-3">
              Already have an account?{" "}
              <Link
                href={hrefFor({
                  name: "login",
                  ...(next ? { next } : {}),
                  ...(invite ? { invite } : {}),
                })}
                className="font-semibold text-accent-ink hover:underline"
              >
                Sign in
              </Link>
            </p>
          </form>
        ) : (
          <form onSubmit={(event) => void handleVerifyCode(event)} className="flex flex-col gap-4">
            <div>
              <label htmlFor="register-code" className="block text-xs font-semibold text-ink-2">
                Verification code
              </label>
              <input
                id="register-code"
                name="code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                required
                autoFocus
                placeholder="123456"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-sm tracking-widest text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                disabled={submitting}
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Verifying\u2026" : "Complete registration"}
            </button>

            <button
              type="button"
              onClick={() => {
                setStep("details");
                setCode("");
                setError(null);
              }}
              disabled={submitting}
              className="rounded-md border border-rule bg-paper-2 px-4 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3"
            >
              Back to details
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
