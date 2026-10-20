import { useState } from "react";
import { Plus, Search, Webhook as WebhookIcon } from "lucide-react";
import {
  WEBHOOK_PROVIDERS,
  type CreateWebhookInput,
  type Project,
  type UpdateWebhookInput,
  type Webhook,
  type WebhookProvider,
} from "@bitig/core";
import { DeleteWebhookDialog } from "./DeleteWebhookDialog";
import { WebhookCard } from "./WebhookCard";
import { WebhookModal } from "./WebhookModal";

const PROVIDER_LABELS: Record<WebhookProvider, string> = {
  sentry: "Sentry",
  jira: "Jira",
  github: "GitHub",
  generic: "Generic JSON",
};

interface WebhooksViewProps {
  readonly webhooks: Webhook[];
  readonly projects: Project[];
  readonly isLoading: boolean;
  readonly error: string | null;
  readonly selectedProjectId?: string | undefined;
  readonly onSelectProjectFilter: (projectId: string | undefined) => void;
  readonly onOpenProjectTasks: (projectId: string) => void;
  readonly onCreateWebhook: (input: CreateWebhookInput) => Promise<Webhook>;
  readonly onUpdateWebhook: (id: string, patch: UpdateWebhookInput) => Promise<Webhook>;
  readonly onDeleteWebhook: (id: string) => Promise<void>;
  readonly searchQuery: string;
}

const ICON_SIZE = 16;

export function WebhooksView({
  webhooks,
  projects,
  isLoading,
  error,
  selectedProjectId,
  onSelectProjectFilter,
  onOpenProjectTasks,
  onCreateWebhook,
  onUpdateWebhook,
  onDeleteWebhook,
  searchQuery,
}: WebhooksViewProps) {
  const [providerFilter, setProviderFilter] = useState<WebhookProvider | "">("");

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    webhook: Webhook | null;
    openKey: number;
  }>({
    isOpen: false,
    webhook: null,
    openKey: 0,
  });

  const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null);

  const activeProjects = projects.filter((p) => !p.archived);
  const projectMap = new Map(projects.map((p) => [p.id, p]));

  function openWebhookModal(webhook: Webhook | null) {
    setModalState((prev) => ({
      isOpen: true,
      webhook,
      openKey: prev.openKey + 1,
    }));
  }

  function closeWebhookModal() {
    setModalState((prev) => ({
      ...prev,
      isOpen: false,
      webhook: null,
    }));
  }

  const hasActiveFilters =
    Boolean(selectedProjectId) || Boolean(providerFilter) || Boolean(searchQuery);

  const filteredWebhooks = webhooks.filter((w) => {
    if (selectedProjectId && w.projectId !== selectedProjectId) {
      return false;
    }
    if (providerFilter && w.provider !== providerFilter) {
      return false;
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const projectName = projectMap.get(w.projectId)?.name.toLowerCase() ?? "";
      return (
        w.name.toLowerCase().includes(q) ||
        w.provider.toLowerCase().includes(q) ||
        projectName.includes(q)
      );
    }
    return true;
  });

  function clearFilters() {
    onSelectProjectFilter(undefined);
    setProviderFilter("");
  }

  async function handleModalSubmit(input: CreateWebhookInput) {
    if (modalState.webhook) {
      const patch: UpdateWebhookInput = {
        name: input.name,
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        defaultPriority: input.defaultPriority ?? null,
        defaultLabels: input.defaultLabels ?? null,
        mapping: input.mapping ?? null,
      };
      await onUpdateWebhook(modalState.webhook.id, patch);
    } else {
      await onCreateWebhook(input);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold tracking-tight text-ink">Webhooks</h1>
          <p className="m-0 text-sm text-ink-2">
            Receive incoming alerts from Sentry, Jira, GitHub, or custom JSON endpoints to create tasks
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 self-start">
          <button
            type="button"
            onClick={() => {
              openWebhookModal(null);
            }}
            disabled={activeProjects.length === 0}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-paper transition-opacity hover:opacity-90 focus-visible:outline-focus disabled:opacity-50"
          >
            <Plus size={ICON_SIZE} />
            New Webhook
          </button>
        </div>
      </div>

      {(webhooks.length > 0 || Boolean(selectedProjectId) || Boolean(providerFilter)) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-rule bg-paper p-3 shadow-xs">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
              <span>Project:</span>
              <select
                value={selectedProjectId ?? ""}
                onChange={(e) => {
                  onSelectProjectFilter(e.target.value || undefined);
                }}
                className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
              >
                <option value="">All Projects ({webhooks.length})</option>
                {activeProjects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex items-center gap-2 text-xs font-semibold text-ink-2">
              <span>Provider:</span>
              <select
                value={providerFilter}
                onChange={(e) => {
                  setProviderFilter(e.target.value as WebhookProvider | "");
                }}
                className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs text-ink focus-visible:outline-focus"
              >
                <option value="">All Providers</option>
                {WEBHOOK_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="rounded-md border border-danger/30 bg-danger-soft p-4 text-sm font-medium text-danger"
        >
          {error}
        </div>
      )}

      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-44 animate-pulse rounded-lg border border-rule bg-paper-2"
            />
          ))}
        </div>
      ) : filteredWebhooks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-rule bg-paper-2 p-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-paper text-ink-3">
            {hasActiveFilters ? <Search size={24} /> : <WebhookIcon size={24} />}
          </div>
          <h3 className="m-0 mt-4 font-display text-base font-bold text-ink">
            {hasActiveFilters ? "No matching webhooks found" : "No webhooks yet"}
          </h3>
          <p className="m-0 mt-1 max-w-sm text-xs text-ink-2">
            {searchQuery
              ? `No webhooks matched "${searchQuery}". Try a different search term.`
              : hasActiveFilters
                ? "No webhooks matched the selected filters."
                : activeProjects.length === 0
                  ? "Create a project first so you can attach incoming webhooks to it."
                  : "Create an incoming webhook to automatically turn Sentry, Jira, or GitHub events into tasks."}
          </p>
          {!hasActiveFilters && activeProjects.length > 0 && (
            <button
              type="button"
              onClick={() => {
                openWebhookModal(null);
              }}
              className="mt-5 inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 focus-visible:outline-focus"
            >
              <Plus size={ICON_SIZE} />
              Create your first webhook
            </button>
          )}
          {(Boolean(selectedProjectId) || Boolean(providerFilter)) && (
            <button
              type="button"
              onClick={clearFilters}
              className="mt-4 inline-flex items-center gap-2 rounded-md border border-rule bg-paper px-3 py-1.5 text-xs font-semibold text-ink-2 hover:bg-paper-2 hover:text-ink focus-visible:outline-focus"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredWebhooks.map((webhook) => (
            <WebhookCard
              key={webhook.id}
              webhook={webhook}
              project={projectMap.get(webhook.projectId)}
              showProjectBadge={!selectedProjectId}
              onEdit={(w) => {
                openWebhookModal(w);
              }}
              onDelete={(w) => {
                setDeleteTarget(w);
              }}
              onToggleEnabled={(w) => {
                void onUpdateWebhook(w.id, { enabled: !w.enabled });
              }}
              onRegenerateToken={(w) => {
                void onUpdateWebhook(w.id, { regenerateToken: true });
              }}
              onSelectProject={onOpenProjectTasks}
            />
          ))}
        </div>
      )}

      <WebhookModal
        key={`${modalState.webhook?.id ?? "new"}-${String(modalState.openKey)}`}
        isOpen={modalState.isOpen}
        webhook={modalState.webhook}
        projects={activeProjects}
        defaultProjectId={selectedProjectId}
        onClose={closeWebhookModal}
        onSubmit={handleModalSubmit}
      />

      <DeleteWebhookDialog
        isOpen={Boolean(deleteTarget)}
        webhook={deleteTarget}
        onClose={() => {
          setDeleteTarget(null);
        }}
        onConfirm={onDeleteWebhook}
      />
    </div>
  );
}
