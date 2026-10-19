import { useState, type SyntheticEvent } from "react";
import { Lock } from "lucide-react";
import { hrefFor, navigate } from "../routing/router";
import { useAuth } from "./useAuth";

interface LoginPageProps {
  /** Where to go after signing in; already checked to be a same-origin path. */
  readonly next?: string | undefined;
}

export function LoginPage({ next }: LoginPageProps) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username.trim()) {
      setError("Username is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await login(username.trim(), password);
    if (result.ok) {
      navigate(next ?? hrefFor({ name: "overview" }), { replace: true });
      return;
    }
    setIsSubmitting(false);
    setError(result.error);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-paper-2 p-4">
      <div className="w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <div className="mb-5 flex items-center gap-3">
          <img src="/favicon.svg" alt="" width={28} height={28} />
          <span className="font-display text-xl font-bold tracking-tight text-ink">bitig</span>
        </div>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <Lock size={18} aria-hidden="true" />
          </div>
          <div>
            <h1 className="m-0 font-display text-lg font-bold text-ink">Sign In</h1>
            <p className="m-0 text-xs text-ink-3">Use the credentials configured on the Worker.</p>
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

        <form onSubmit={(e) => void handleSubmit(e)} className="flex flex-col gap-4">
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
              onChange={(e) => {
                setUsername(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              placeholder="e.g. admin"
              disabled={isSubmitting}
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
              onChange={(e) => {
                setPassword(e.target.value);
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              placeholder="••••••••"
              disabled={isSubmitting}
            />
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </main>
  );
}
