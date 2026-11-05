import {
  Building2,
  ChartNoAxesColumn,
  FolderKanban,
  ListTodo,
  Settings,
  Shield,
  Sprout,
  User,
  Users,
  Webhook,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import type { HealthState } from "../hooks/useHealth";
import { Link } from "../routing/Link";
import { hrefFor } from "../routing/router";

export type NavigationTab =
  | "overview"
  | "projects"
  | "tasks"
  | "webhooks"
  | "reports"
  | "settings"
  | "profile"
  | "settings_profile"
  | "settings_security"
  | "org_settings"
  | "org_members"
  | "admin_users";

interface NavItem {
  readonly id: "overview" | "projects" | "tasks" | "webhooks" | "reports" | "settings";
  readonly label: string;
  readonly icon: LucideIcon;
}

const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", icon: Sprout },
  { id: "projects", label: "Projects", icon: FolderKanban },
  { id: "tasks", label: "Tasks", icon: ListTodo },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "reports", label: "Reports", icon: ChartNoAxesColumn },
  { id: "settings", label: "Settings", icon: Settings },
];

const ICON_SIZE = 18;

interface RailProps {
  readonly health: HealthState;
  /** The section the current page belongs to; none on pages outside the nav, such as sign-in. */
  readonly activeTab?: NavigationTab | undefined;
}

export function Rail({ health, activeTab }: RailProps) {
  const { currentOrg, isAdmin, profile } = useAuth();

  return (
    <aside className="flex flex-col gap-6 border-rule bg-paper-2 px-4 py-5 md:sticky md:top-0 md:h-dvh md:border-r md:py-6">
      <div className="flex items-center gap-3 px-2">
        <img src="/logo.svg" alt="bitig" width={81} height={32} />
      </div>

      <nav aria-label="Primary">
        <ul className="flex flex-row flex-wrap gap-1 md:flex-col">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <Link
                href={hrefFor({ name: id })}
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
              </Link>
            </li>
          ))}
        </ul>

        {(Boolean(currentOrg ?? profile) || isAdmin) && (
          <div className="mt-6 hidden border-t border-rule pt-4 md:block">
            <p className="m-0 mb-2 px-3 text-2xs font-semibold uppercase tracking-wider text-ink-3">
              Account & Org
            </p>
            <ul className="flex flex-col gap-1">
              {currentOrg && (
                <>
                  <li>
                    <Link
                      href={hrefFor({ name: "org_members", slug: currentOrg.slug })}
                      aria-current={activeTab === "org_members" ? "page" : undefined}
                      className={`flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                        activeTab === "org_members"
                          ? "bg-paper text-ink shadow-xs"
                          : "text-ink-2 hover:bg-paper-3 hover:text-ink"
                      }`}
                    >
                      <Users size={16} aria-hidden="true" className="text-ink-3" />
                      Members
                    </Link>
                  </li>
                  <li>
                    <Link
                      href={hrefFor({ name: "org_settings", slug: currentOrg.slug })}
                      aria-current={activeTab === "org_settings" ? "page" : undefined}
                      className={`flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                        activeTab === "org_settings"
                          ? "bg-paper text-ink shadow-xs"
                          : "text-ink-2 hover:bg-paper-3 hover:text-ink"
                      }`}
                    >
                      <Building2 size={16} aria-hidden="true" className="text-ink-3" />
                      Org Settings
                    </Link>
                  </li>
                </>
              )}
              {profile && (
                <li>
                  <Link
                    href={hrefFor({ name: "profile" })}
                    aria-current={
                      activeTab === "profile" || activeTab === "settings_profile" || activeTab === "settings_security"
                        ? "page"
                        : undefined
                    }
                    className={`flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                      activeTab === "profile" || activeTab === "settings_profile" || activeTab === "settings_security"
                        ? "bg-paper text-ink shadow-xs"
                        : "text-ink-2 hover:bg-paper-3 hover:text-ink"
                    }`}
                  >
                    <User size={16} aria-hidden="true" className="text-ink-3" />
                    Profile
                  </Link>
                </li>
              )}
              {isAdmin && (
                <li>
                  <Link
                    href={hrefFor({ name: "admin_users" })}
                    aria-current={activeTab === "admin_users" ? "page" : undefined}
                    className={`flex w-full items-center gap-3 whitespace-nowrap rounded-md px-3 py-2 text-xs font-semibold transition-colors ${
                      activeTab === "admin_users"
                        ? "bg-paper text-ink shadow-xs"
                        : "text-ink-2 hover:bg-paper-3 hover:text-ink"
                    }`}
                  >
                    <Shield size={16} aria-hidden="true" className="text-ink-3" />
                    Admin Users
                  </Link>
                </li>
              )}
            </ul>
          </div>
        )}
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
