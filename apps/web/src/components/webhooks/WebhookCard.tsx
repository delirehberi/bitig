import { useState } from "react";
import {
  Activity,
  Check,
  Copy,
  Edit2,
  Eye,
  EyeOff,
  FolderKanban,
  Power,
  RefreshCw,
  Tag,
  Trash2,
} from "lucide-react";
import type { Project, TaskPriority, Webhook, WebhookProvider } from "@bitig/core";

interface WebhookCardProps {
  readonly webhook: Webhook;
  readonly project?: Project | undefined;
  readonly showProjectBadge?: boolean | undefined;
  readonly onEdit: (webhook: Webhook) => void;
  readonly onDelete: (webhook: Webhook) => void;
  readonly onToggleEnabled: (webhook: Webhook) => void;
  readonly onRegenerateToken: (webhook: Webhook) => void;
  readonly onSelectProject?: ((projectId: string) => void) | undefined;
}

const PROVIDER_LABELS: Record<WebhookProvider, string> = {
  sentry: "Sentry",
  jira: "Jira",
  github: "GitHub",
  generic: "Generic JSON",
};

const PROVIDER_COLORS: Record<WebhookProvider, string> = {
  sentry: "bg-danger-soft text-danger",
  jira: "bg-accent-soft text-accent-ink",
  github: "bg-paper-3 text-ink",
  generic: "bg-paper-3 text-ink-2",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const ICON_SIZE = 14;

function maskToken(token: string): string {
  if (token.length <= 12) return "••••••••";
  return `${token.slice(0, 8)}••••••••${token.slice(-4)}`;
}

export function WebhookCard({
  webhook,
  project,
  showProjectBadge = true,
  onEdit,
  onDelete,
  onToggleEnabled,
  onRegenerateToken,
  onSelectProject,
}: WebhookCardProps) {
  const [copied, setCopied] = useState(false);
  const [revealToken, setRevealToken] = useState(false);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const fullUrl = `${origin}/webhooks/${webhook.token}`;
  const maskedUrl = `${origin}/webhooks/${maskToken(webhook.token)}`;

  const mappingEntries = webhook.mapping
    ? Object.entries(webhook.mapping).filter(([, value]) => typeof value === "string" && value.length > 0)
    : [];

  async function handleCopyUrl() {
    try {
      await navigator.clipboard.writeText(fullUrl);
      setCopied(true);
      window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch {
      // Clipboard API may be unavailable in restricted contexts; ignore gracefully.
    }
  }

  return (
    <article
      className={`flex flex-col justify-between rounded-lg border bg-paper p-5 transition-all hover:border-rule-strong hover:shadow-xs ${
        webhook.enabled ? "border-rule" : "border-rule/60 opacity-75"
      }`}
    >
      <div>
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-pill px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider ${
                PROVIDER_COLORS[webhook.provider]
              }`}
            >
              {PROVIDER_LABELS[webhook.provider]}
            </span>
            <span
              className={`rounded-pill px-2 py-0.5 text-2xs font-semibold uppercase tracking-wider ${
                webhook.enabled ? "bg-ok-soft text-ok" : "bg-paper-3 text-ink-3"
              }`}
            >
              {webhook.enabled ? "Enabled" : "Disabled"}
            </span>
            {showProjectBadge && project && (
              <button
                type="button"
                onClick={() => {
                  onSelectProject?.(project.id);
                }}
                title="View project tasks"
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-semibold text-ink-2 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus"
              >
                <FolderKanban size={11} />
                <span>{project.key ? `${project.key} · ${project.name}` : project.name}</span>
              </button>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => {
                onToggleEnabled(webhook);
              }}
              title={webhook.enabled ? "Disable webhook" : "Enable webhook"}
              aria-label={webhook.enabled ? `Disable ${webhook.name}` : `Enable ${webhook.name}`}
              className={`rounded-md p-1.5 transition-colors focus-visible:outline-focus ${
                webhook.enabled
                  ? "text-ok hover:bg-paper-2"
                  : "text-ink-3 hover:bg-paper-2 hover:text-ink"
              }`}
            >
              <Power size={ICON_SIZE} />
            </button>
            <button
              type="button"
              onClick={() => {
                onRegenerateToken(webhook);
              }}
              title="Regenerate webhook token"
              aria-label={`Regenerate token for ${webhook.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              <RefreshCw size={ICON_SIZE} />
            </button>
            <button
              type="button"
              onClick={() => {
                onEdit(webhook);
              }}
              title="Edit webhook"
              aria-label={`Edit ${webhook.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              <Edit2 size={ICON_SIZE} />
            </button>
            <button
              type="button"
              onClick={() => {
                onDelete(webhook);
              }}
              title="Delete webhook"
              aria-label={`Delete ${webhook.name}`}
              className="rounded-md p-1.5 text-ink-3 transition-colors hover:bg-danger-soft hover:text-danger focus-visible:outline-focus"
            >
              <Trash2 size={ICON_SIZE} />
            </button>
          </div>
        </div>

        <h3 className="m-0 mt-3 font-display text-base font-bold text-ink">{webhook.name}</h3>

        <div className="mt-3 flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-2.5 py-1.5">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
            {revealToken ? fullUrl : maskedUrl}
          </code>
          <button
            type="button"
            onClick={() => {
              setRevealToken((prev) => !prev);
            }}
            title={revealToken ? "Hide webhook URL" : "Reveal webhook URL"}
            aria-label={revealToken ? `Hide URL for ${webhook.name}` : `Reveal URL for ${webhook.name}`}
            className="shrink-0 rounded p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus"
          >
            {revealToken ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            onClick={() => {
              void handleCopyUrl();
            }}
            title="Copy webhook URL"
            aria-label={`Copy URL for ${webhook.name}`}
            className="inline-flex shrink-0 items-center gap-1 rounded bg-paper px-2 py-1 text-2xs font-semibold text-ink-2 shadow-2xs transition-colors hover:bg-paper-3 hover:text-ink focus-visible:outline-focus"
          >
            {copied ? <Check size={12} className="text-ok" /> : <Copy size={12} />}
            <span>{copied ? "Copied" : "Copy URL"}</span>
          </button>
        </div>

        {(webhook.defaultPriority !== undefined ||
          (webhook.defaultLabels !== undefined && webhook.defaultLabels.length > 0)) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {webhook.defaultPriority && (
              <span className="rounded-md border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2">
                Default Priority: <strong className="text-ink">{PRIORITY_LABELS[webhook.defaultPriority]}</strong>
              </span>
            )}
            {webhook.defaultLabels?.map((label) => (
              <span
                key={label}
                className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper-2 px-2 py-0.5 text-2xs text-ink-2"
              >
                <Tag size={10} />
                {label}
              </span>
            ))}
          </div>
        )}

        {mappingEntries.length > 0 && (
          <div className="mt-3 rounded-md border border-rule/80 bg-paper-2/60 p-2.5">
            <p className="m-0 mb-1.5 text-2xs font-semibold uppercase tracking-wider text-ink-3">
              Custom Field Mapping
            </p>
            <div className="grid grid-cols-1 gap-1 text-xs">
              {mappingEntries.map(([field, path]) => (
                <div key={field} className="flex items-center justify-between gap-2 font-mono text-2xs">
                  <span className="text-ink-3">bitig.{field}</span>
                  <span className="truncate font-semibold text-ink-2">{path}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 flex items-center justify-between border-t border-rule pt-3 text-xs text-ink-3">
        <div className="flex items-center gap-1.5">
          <Activity size={ICON_SIZE} />
          <span>
            <strong className="font-semibold text-ink">{webhook.triggerCount}</strong>{" "}
            {webhook.triggerCount === 1 ? "delivery" : "deliveries"}
          </span>
        </div>
        <span>
          {webhook.lastTriggeredAt
            ? `Last triggered ${new Date(webhook.lastTriggeredAt).toLocaleDateString()}`
            : "Never triggered"}
        </span>
      </div>
    </article>
  );
}
