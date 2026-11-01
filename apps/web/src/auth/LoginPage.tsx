import { useState } from "react";
import { Lock } from "lucide-react";
import { hrefFor, navigate } from "../routing/router";
import { useAuth } from "./useAuth";

interface LoginPageProps {
  /** Where to go after signing in; already checked to be a same-origin path. */
  readonly next?: string | undefined;
}

export function LoginPage({ next }: LoginPageProps) {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleLogin() {
    setIsSubmitting(true);
    setError(null);

    const result = await login();
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
          <img src="/logo.svg" alt="bitig" width={81} height={32} />
        </div>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <Lock size={18} aria-hidden="true" />
          </div>
          <div>
            <h1 className="m-0 font-display text-lg font-bold text-ink">Sign In</h1>
            <p className="m-0 text-xs text-ink-3">Prove your identity with a NIP-07 Nostr extension.</p>
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

        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => void handleLogin()}
            disabled={isSubmitting}
            className="mt-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isSubmitting ? "Waiting for signature…" : "Sign in with Nostr"}
          </button>
        </div>
      </div>
    </main>
  );
}
