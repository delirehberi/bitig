import type { StorageMode } from "@bitig/core";
import { CircleUserRound, LogOut, Search } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { MODE_COPY } from "../domain/modes";
import { useFeatureFlags } from "../hooks/useFeatureFlags";
import type { HealthState } from "../hooks/useHealth";

interface HeaderProps {
  readonly mode: StorageMode;
  readonly health: HealthState;
  readonly searchQuery: string;
  readonly onSearchChange: (query: string) => void;
}

const ICON_SIZE = 16;

const DOT_CLASS: Record<HealthState["kind"], string> = {
  checking: "bg-rule-strong",
  online: "bg-ok",
  unreachable: "bg-danger",
};

/** Worker health as a dot; the label and storage backend are in its tooltip and for screen readers. */
function WorkerHealthDot({ mode, health }: { readonly mode: StorageMode; readonly health: HealthState }) {
  const state =
    health.kind === "checking"
      ? "Checking worker…"
      : health.kind === "online"
        ? `Worker online · v${health.version}`
        : `Worker unreachable · ${health.reason}`;
  const label = `${state} · ${MODE_COPY[mode].label} storage`;
  return (
    <span role="status" title={label} className="ml-auto inline-flex shrink-0 items-center p-2">
      <span aria-hidden="true" className={`size-2 rounded-pill ${DOT_CLASS[health.kind]}`} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function Header({ mode, health, searchQuery, onSearchChange }: HeaderProps) {
  const { status, user, logout } = useAuth();
  const { passwordLogin } = useFeatureFlags();

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

      <WorkerHealthDot mode={mode} health={health} />

      {passwordLogin && status === "authenticated" && user && (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-2 whitespace-nowrap rounded-pill border border-rule bg-paper-2 px-3 py-1.5 text-sm font-medium text-ink">
            <CircleUserRound size={ICON_SIZE} aria-hidden="true" className="text-accent-ink" />
            {user}
          </span>
          <button
            type="button"
            onClick={() => void logout()}
            title="Sign out"
            aria-label="Sign out"
            className="flex items-center justify-center rounded-pill border border-rule p-2 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
          >
            <LogOut size={ICON_SIZE} aria-hidden="true" />
          </button>
        </div>
      )}
    </header>
  );
}
