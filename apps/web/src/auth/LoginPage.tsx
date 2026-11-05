import { useEffect, useState, type SyntheticEvent } from "react";
import { Lock, Mail } from "lucide-react";
import { Link } from "../routing/Link";
import { hrefFor, navigate } from "../routing/router";
import { getPublicInvitationInfo, type PublicInvitationPreview } from "../services/multi-user";
import { useAuth } from "./useAuth";

interface LoginPageProps {
  /** Where to go after signing in; already checked to be a same-origin path. */
  readonly next?: string | undefined;
  /** Optional organisation invitation token passed via `?invite=`. */
  readonly invite?: string | undefined;
}

export function LoginPage({ next, invite }: LoginPageProps) {
  const { requestSignInCode, verifyAuthCode, loginWithNostr } = useAuth();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [submittingMethod, setSubmittingMethod] = useState<"email" | "verify" | "nostr" | null>(null);
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

  function finishLogin(result: Awaited<ReturnType<typeof loginWithNostr>>): boolean {
    if (result.ok) {
      navigate(next ?? hrefFor({ name: "overview" }), { replace: true });
      return true;
    }
    setSubmittingMethod(null);
    setError(result.error);
    return false;
  }

  async function handleRequestCode(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim()) {
      setError("Email is required");
      return;
    }
    setSubmittingMethod("email");
    setError(null);
    const result = await requestSignInCode(email.trim());
    setSubmittingMethod(null);
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
    setSubmittingMethod("verify");
    setError(null);
    finishLogin(
      await verifyAuthCode({
        email: email.trim(),
        code: code.trim(),
        ...(invite ? { inviteToken: invite } : {}),
      }),
    );
  }

  async function handleNostrLogin() {
    setSubmittingMethod("nostr");
    setError(null);
    finishLogin(await loginWithNostr());
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper-2 p-4">
      <div className="w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-3">
          <img src="/logo.svg" alt="bitig" width={81} height={32} />
        </div>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            {step === "code" ? <Mail size={18} aria-hidden="true" /> : <Lock size={18} aria-hidden="true" />}
          </div>
          <div>
            <h1 className="m-0 font-display text-lg font-bold text-ink">Sign In</h1>
            <p className="m-0 text-xs text-ink-3">
              {step === "code"
                ? `Enter the 6-digit code sent to ${email}.`
                : "Sign in with a one-time email code or a NIP-07 Nostr extension."}
            </p>
          </div>
        </div>

        {inviteInfo && (
          <div className="mb-4 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-xs text-accent-ink">
            You have been invited to join <strong>{inviteInfo.orgName}</strong> as{" "}
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

        {step === "email" ? (
          <form onSubmit={(event) => void handleRequestCode(event)} className="flex flex-col gap-4">
            <div>
              <label htmlFor="auth-email" className="block text-xs font-semibold text-ink-2">
                Email
              </label>
              <input
                id="auth-email"
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
                disabled={submittingMethod !== null}
              />
            </div>

            <button
              type="submit"
              disabled={submittingMethod !== null}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submittingMethod === "email" ? "Sending code\u2026" : "Send sign-in code"}
            </button>

            <div className="flex items-center gap-3 text-2xs uppercase tracking-wider text-ink-3" aria-hidden="true">
              <span className="h-px flex-1 bg-rule" />
              or
              <span className="h-px flex-1 bg-rule" />
            </div>

            <button
              type="button"
              onClick={() => void handleNostrLogin()}
              disabled={submittingMethod !== null}
              className="rounded-md border border-rule bg-paper-2 px-4 py-2 text-sm font-semibold text-ink transition-colors hover:bg-paper-3 disabled:opacity-50"
            >
              {submittingMethod === "nostr" ? "Waiting for signature\u2026" : "Sign in with Nostr"}
            </button>

            <p className="m-0 text-center text-xs text-ink-3">
              New to Bitig?{" "}
              <Link
                href={hrefFor({
                  name: "register",
                  ...(next ? { next } : {}),
                  ...(invite ? { invite } : {}),
                })}
                className="font-semibold text-accent-ink hover:underline"
              >
                Create an account
              </Link>
            </p>
          </form>
        ) : (
          <form onSubmit={(event) => void handleVerifyCode(event)} className="flex flex-col gap-4">
            <div>
              <label htmlFor="auth-code" className="block text-xs font-semibold text-ink-2">
                Verification code
              </label>
              <input
                id="auth-code"
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
                disabled={submittingMethod !== null}
              />
            </div>

            <button
              type="submit"
              disabled={submittingMethod !== null}
              className="rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {submittingMethod === "verify" ? "Verifying\u2026" : "Verify & sign in"}
            </button>

            <button
              type="button"
              onClick={() => {
                setStep("email");
                setCode("");
                setError(null);
              }}
              disabled={submittingMethod !== null}
              className="rounded-md border border-rule bg-paper-2 px-4 py-2 text-xs font-semibold text-ink-2 transition-colors hover:bg-paper-3"
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
