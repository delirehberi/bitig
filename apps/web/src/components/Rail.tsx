import { FolderKanban, ListTodo, Settings, Sprout } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { HealthState } from "../hooks/useHealth";

export type NavigationTab = "overview" | "projects" | "tasks";

interface NavItem {
  readonly id: NavigationTab | "settings";
  readonly label: string;
  readonly icon: LucideIcon;
  readonly available: boolean;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", icon: Sprout, available: true },
  { id: "projects", label: "Projects", icon: FolderKanban, available: true },
  { id: "tasks", label: "Tasks", icon: ListTodo, available: true },
  { id: "settings", label: "Settings", icon: Settings, available: false },
];

const ICON_SIZE = 18;

interface RailProps {
  readonly health: HealthState;
  readonly activeTab: NavigationTab;
  readonly onTabChange: (tab: NavigationTab) => void;
}

export function Rail({ health, activeTab, onTabChange }: RailProps) {
  return (
    <aside className="flex flex-col gap-6 border-rule bg-paper-2 px-4 py-5 md:sticky md:top-0 md:h-dvh md:border-r md:py-6">
      <div className="flex items-center gap-3 px-2">
        <img src="/favicon.svg" alt="" width={28} height={28} />
        <span className="font-display text-xl font-bold tracking-tight text-ink">bitig</span>
      </div>

      <nav aria-label="Primary">
        <ul className="flex flex-row flex-wrap gap-1 md:flex-col">
          {NAV_ITEMS.map(({ id, label, icon: Icon, available }) =>
            available && id !== "settings" ? (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => {
                    onTabChange(id);
                  }}
                  aria-current={activeTab === id ? "page" : undefined}
                  className={`flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm font-semibold transition-colors ${
                    activeTab === id
                      ? "bg-paper text-ink shadow-xs"
                      : "text-ink-2 hover:bg-paper-3 hover:text-ink"
                  }`}
                >
                  <Icon
                    size={ICON_SIZE}
                    aria-hidden="true"
                    className={activeTab === id ? "text-accent-ink" : "text-ink-3"}
                  />
                  {label}
                </button>
              </li>
            ) : (
              <li key={label} className="hidden md:block">
                <span
                  aria-disabled="true"
                  className="flex items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-sm text-ink-3"
                >
                  <Icon size={ICON_SIZE} aria-hidden="true" />
                  {label}
                  <span className="ml-auto text-xs">later</span>
                </span>
              </li>
            ),
          )}
        </ul>
      </nav>

      <p className="mt-auto hidden px-2 text-xs text-ink-3 md:block">
        {health.kind === "online" ? (
          <>
            <span className="tabular-nums">v{health.version}</span> · built for MCP
          </>
        ) : (
          "Built for MCP"
        )}
      </p>
    </aside>
  );
}
