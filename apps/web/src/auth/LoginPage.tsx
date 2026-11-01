import { useState, type SyntheticEvent } from "react";
import { Lock } from "lucide-react";
import { hrefFor, navigate } from "../routing/router";
import { useAuth } from "./useAuth";

interface LoginPageProps {
  /** Where to go after signing in; already checked to be a same-origin path. */
  readonly next?: string | undefined;
}

export function LoginPage({ next }: LoginPageProps) {
  const { loginWithPassword, loginWithNostr } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submittingMethod, setSubmittingMethod] = useState<"password" | "nostr" | null>(null);

  function finishLogin(result: Awaited<ReturnType<typeof loginWithNostr>>): boolean {
    if (result.ok) {
      navigate(next ?? hrefFor({ name: "overview" }), { replace: true });
      return true;
    }
    setSubmittingMethod(null);
    setError(result.error);
    return false;
  }

  async function handlePasswordLogin(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!username.trim()) {
      setError("Username is required");
      return;
    }

    setSubmittingMethod("password");
    setError(null);
    finishLogin(await loginWithPassword(username.trim(), password));
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
            <Lock size={18} aria-hidden="true" />
          </div>
          <div>
            <h1 className="m-0 font-display text-lg font-bold text-ink">Sign In</h1>
            <p className="m-0 text-xs text-ink-3">Use your configured credentials or a NIP-07 Nostr extension.</p>
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

        <form onSubmit={(event) => void handlePasswordLogin(event)} className="flex flex-col gap-4">
          <div>
            <label htmlFor="auth-username" className="block text-xs font-semibold text-ink-2">
              Username
            </label>
            <input
              id="auth-username"
              name="username"
              type="text"
              autoComplete="username"
              required
              autoFocus
              value={username}
              onChange={(event) => {
                setUsername(event.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={submittingMethod !== null}
            />
          </div>

          <div>
            <label htmlFor="auth-password" className="block text-xs font-semibold text-ink-2">
              Password
            </label>
            <input
              id="auth-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
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
            {submittingMethod === "password" ? "Signing in…" : "Sign in"}
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
            {submittingMethod === "nostr" ? "Waiting for signature…" : "Sign in with Nostr"}
          </button>
        </form>
      </div>
    </main>
  );
}
