import { useRef, useState, type SyntheticEvent } from "react";
import {
  TASK_PRIORITIES,
  WEBHOOK_PROVIDERS,
  type CreateWebhookInput,
  type Project,
  type TaskPriority,
  type Webhook,
  type WebhookMapping,
  type WebhookProvider,
} from "@bitig/core";
import { Webhook as WebhookIcon, X } from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";

interface WebhookModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (input: CreateWebhookInput) => Promise<void>;
  readonly webhook?: Webhook | null | undefined;
  readonly projects: Project[];
  readonly defaultProjectId?: string | undefined;
}

const ICON_SIZE = 16;

const PROVIDER_LABELS: Record<WebhookProvider, string> = {
  sentry: "Sentry",
  jira: "Jira",
  github: "GitHub",
  generic: "Generic JSON",
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  trivial: "Trivial",
  low: "Low",
  medium: "Medium",
  high: "High",
  urgent: "Urgent",
};

const PROVIDER_HINTS: Record<WebhookProvider, string> = {
  sentry: "Extracts issue.title, issue.culprit, and event.level from Sentry alert payloads.",
  jira: "Extracts issue.fields.summary, description, priority.name, and labels from Jira webhooks.",
  github: "Extracts issue/pull_request title, body, html_url, and labels from GitHub webhooks.",
  generic: "Accepts any JSON with title/summary/message, description/body, priority, and labels.",
};

export function WebhookModal({
  isOpen,
  onClose,
  onSubmit,
  webhook,
  projects,
  defaultProjectId,
}: WebhookModalProps) {
  const initialProjectId =
    webhook?.projectId ?? defaultProjectId ?? (projects.length > 0 ? (projects[0]?.id ?? "") : "");

  const [projectId, setProjectId] = useState(initialProjectId);
  const [name, setName] = useState(webhook?.name ?? "");
  const [provider, setProvider] = useState<WebhookProvider>(webhook?.provider ?? "generic");
  const [enabled, setEnabled] = useState(webhook?.enabled ?? true);
  const [defaultPriority, setDefaultPriority] = useState<TaskPriority | "">(webhook?.defaultPriority ?? "");
  const [defaultLabelsInput, setDefaultLabelsInput] = useState(
    webhook?.defaultLabels ? webhook.defaultLabels.join(", ") : "",
  );
  const [titlePath, setTitlePath] = useState(webhook?.mapping?.title ?? "");
  const [descriptionPath, setDescriptionPath] = useState(webhook?.mapping?.description ?? "");
  const [priorityPath, setPriorityPath] = useState(webhook?.mapping?.priority ?? "");
  const [labelsPath, setLabelsPath] = useState(webhook?.mapping?.labels ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, isOpen);

  if (!isOpen) return null;

  const isEditing = Boolean(webhook);

  async function handleSubmit(e: SyntheticEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Webhook name is required");
      return;
    }
    if (!projectId) {
      setError("Please select a project");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    const defaultLabels = defaultLabelsInput
      .split(",")
      .map((l) => l.trim())
      .filter(Boolean);

    const mapping: WebhookMapping = {
      ...(titlePath.trim() ? { title: titlePath.trim() } : {}),
      ...(descriptionPath.trim() ? { description: descriptionPath.trim() } : {}),
      ...(priorityPath.trim() ? { priority: priorityPath.trim() } : {}),
      ...(labelsPath.trim() ? { labels: labelsPath.trim() } : {}),
    };
    const hasMapping = Object.keys(mapping).length > 0;

    const payload: CreateWebhookInput = {
      projectId,
      name: name.trim(),
      provider,
      enabled,
      ...(defaultPriority ? { defaultPriority } : {}),
      ...(defaultLabels.length > 0 ? { defaultLabels } : {}),
      ...(hasMapping ? { mapping } : {}),
    };

    try {
      await onSubmit(payload);
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save webhook");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="webhook-modal-title"
      className="fixed inset-0 z-modal flex items-center justify-center bg-ink/40 p-4 backdrop-blur-xs"
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-lg border border-rule bg-paper p-6 shadow-lg outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close dialog"
          className="absolute top-4 right-4 text-ink-3 transition-colors hover:text-ink"
        >
          <X size={ICON_SIZE} />
        </button>

        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md bg-accent-soft text-accent-ink">
            <WebhookIcon size={18} />
          </div>
          <div>
            <h2 id="webhook-modal-title" className="m-0 font-display text-lg font-bold text-ink">
              {isEditing ? "Edit Webhook" : "New Webhook"}
            </h2>
            <p className="m-0 text-xs text-ink-3">Create tasks automatically from external services</p>
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
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="webhook-project" className="block text-xs font-semibold text-ink-2">
                Project <span className="text-danger">*</span>
              </label>
              <select
                id="webhook-project"
                required
                value={projectId}
                onChange={(e) => {
                  setProjectId(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
                disabled={isSubmitting || isEditing}
              >
                {projects.length === 0 && <option value="">No projects available</option>}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="webhook-provider" className="block text-xs font-semibold text-ink-2">
                Provider
              </label>
              <select
                id="webhook-provider"
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value as WebhookProvider);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
                disabled={isSubmitting}
              >
                {WEBHOOK_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="m-0 -mt-2 text-xs text-ink-3">{PROVIDER_HINTS[provider]}</p>

          <div>
            <label htmlFor="webhook-name" className="block text-xs font-semibold text-ink-2">
              Webhook Name <span className="text-danger">*</span>
            </label>
            <input
              id="webhook-name"
              type="text"
              required
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="e.g. Sentry Production Alerts"
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
              disabled={isSubmitting}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="webhook-default-priority" className="block text-xs font-semibold text-ink-2">
                Default Priority
              </label>
              <select
                id="webhook-default-priority"
                value={defaultPriority}
                onChange={(e) => {
                  setDefaultPriority(e.target.value as TaskPriority | "");
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink focus-visible:outline-focus"
                disabled={isSubmitting}
              >
                <option value="">From payload / None</option>
                {TASK_PRIORITIES.map((pr) => (
                  <option key={pr} value={pr}>
                    {PRIORITY_LABELS[pr]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="webhook-default-labels" className="block text-xs font-semibold text-ink-2">
                Default Labels <span className="font-normal text-ink-3">(comma separated)</span>
              </label>
              <input
                id="webhook-default-labels"
                type="text"
                value={defaultLabelsInput}
                onChange={(e) => {
                  setDefaultLabelsInput(e.target.value);
                }}
                placeholder="e.g. bug, sentry"
                className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <fieldset className="m-0 rounded-md border border-rule bg-paper-2/50 p-3">
            <legend className="px-1 text-xs font-semibold text-ink-2">
              Field Mapping Overrides <span className="font-normal text-ink-3">(optional JSON dot-paths)</span>
            </legend>
            <p className="m-0 mb-3 text-2xs text-ink-3">
              Map incoming JSON fields to Bitig task fields (e.g. <code>issue.fields.summary</code> →{" "}
              <code>bitig.title</code>). Overrides provider defaults when present.
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="webhook-map-title" className="block font-mono text-2xs font-semibold text-ink-2">
                  bitig.title
                </label>
                <input
                  id="webhook-map-title"
                  type="text"
                  value={titlePath}
                  onChange={(e) => {
                    setTitlePath(e.target.value);
                  }}
                  placeholder="e.g. issue.fields.summary"
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  disabled={isSubmitting}
                />
              </div>

              <div>
                <label
                  htmlFor="webhook-map-description"
                  className="block font-mono text-2xs font-semibold text-ink-2"
                >
                  bitig.description
                </label>
                <input
                  id="webhook-map-description"
                  type="text"
                  value={descriptionPath}
                  onChange={(e) => {
                    setDescriptionPath(e.target.value);
                  }}
                  placeholder="e.g. issue.fields.description"
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  disabled={isSubmitting}
                />
              </div>

              <div>
                <label htmlFor="webhook-map-priority" className="block font-mono text-2xs font-semibold text-ink-2">
                  bitig.priority
                </label>
                <input
                  id="webhook-map-priority"
                  type="text"
                  value={priorityPath}
                  onChange={(e) => {
                    setPriorityPath(e.target.value);
                  }}
                  placeholder="e.g. event.level"
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  disabled={isSubmitting}
                />
              </div>

              <div>
                <label htmlFor="webhook-map-labels" className="block font-mono text-2xs font-semibold text-ink-2">
                  bitig.labels
                </label>
                <input
                  id="webhook-map-labels"
                  type="text"
                  value={labelsPath}
                  onChange={(e) => {
                    setLabelsPath(e.target.value);
                  }}
                  placeholder="e.g. issue.fields.labels"
                  className="mt-1 w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 font-mono text-xs text-ink placeholder:text-ink-3 focus-visible:outline-focus"
                  disabled={isSubmitting}
                />
              </div>
            </div>
          </fieldset>

          <div className="flex items-center gap-2">
            <input
              id="webhook-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
              }}
              className="rounded border-rule text-accent focus-visible:outline-focus"
              disabled={isSubmitting}
            />
            <label htmlFor="webhook-enabled" className="text-xs font-semibold text-ink-2">
              Enabled <span className="font-normal text-ink-3">(accept incoming webhook deliveries)</span>
            </label>
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
              disabled={isSubmitting || projects.length === 0}
              className="rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {isSubmitting ? "Saving…" : isEditing ? "Save Changes" : "Create Webhook"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
