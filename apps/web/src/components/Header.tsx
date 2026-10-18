import { CircleUserRound, LogOut, Search } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { useFeatureFlags } from "../hooks/useFeatureFlags";

interface HeaderProps {
  readonly onOpenLogin: () => void;
  readonly searchQuery: string;
  readonly onSearchChange: (query: string) => void;
}

const ICON_SIZE = 16;

export function Header({ onOpenLogin, searchQuery, onSearchChange }: HeaderProps) {
  const { status, user, logout } = useAuth();
  const { basicAuthLogin } = useFeatureFlags();

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
          placeholder="Search tasks and projects…"
          value={searchQuery}
          onChange={(e) => {
            onSearchChange(e.target.value);
          }}
          className="w-full min-w-0 rounded-pill border border-rule bg-paper-2 py-2 pr-4 pl-9 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
        />
      </label>

      {basicAuthLogin && (
        <div className="ml-auto flex items-center gap-2">
          {status === "authenticated" && user ? (
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-2 whitespace-nowrap rounded-pill border border-rule bg-paper-2 px-3 py-1.5 text-sm font-medium text-ink">
                <CircleUserRound size={ICON_SIZE} aria-hidden="true" className="text-accent-ink" />
                {user}
              </span>
              <button
                type="button"
                onClick={logout}
                title="Sign out"
                aria-label="Sign out"
                className="flex items-center justify-center rounded-pill border border-rule p-2 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
              >
                <LogOut size={ICON_SIZE} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={onOpenLogin}
              className="flex items-center gap-2 whitespace-nowrap rounded-pill border border-rule px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-paper-2 hover:border-rule-strong focus-visible:outline-focus"
            >
              <CircleUserRound size={ICON_SIZE} aria-hidden="true" />
              Sign In
            </button>
          )}
        </div>
      )}
    </header>
  );
}
