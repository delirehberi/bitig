import { useState, type SyntheticEvent } from "react";
import { Lock, X } from "lucide-react";
import { useAuth } from "./useAuth";

interface LoginFormProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
}

const ICON_SIZE = 16;

export function LoginForm({ isOpen, onClose }: LoginFormProps) {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!isOpen) return null;

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!username.trim()) {
      setError("Username is required");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const result = await login(username.trim(), password);
    setIsSubmitting(false);

    if (result.success) {
      onClose();
    } else {
      setError(result.error ?? "Failed to sign in");
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-dialog-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div className="relative w-full max-w-sm rounded-lg border border-rule bg-paper p-6 shadow-lg">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <Lock size={18} />
          </div>
          <div>
            <h2 id="login-dialog-title" className="m-0 font-display text-lg font-bold text-ink">
              Sign In
            </h2>
            <p className="m-0 text-xs text-ink-3">Worker HTTP Basic Authentication</p>
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
              type="text"
              autoComplete="username"
              required
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

          <div className="mt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-rule px-3 py-2 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? "Signing in…" : "Sign In"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
