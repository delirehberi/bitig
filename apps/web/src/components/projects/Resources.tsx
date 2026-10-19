import { RESOURCE_TYPES, type ProjectResource, type ResourceType } from "@bitig/core";
import type { ResourceDraft } from "./resource-drafts";
import { ArrowDown, ArrowUp, BookOpen, Bug, GitBranch, Link2, PenTool, Plus, X, type LucideIcon } from "lucide-react";

const ICON_SIZE = 14;

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
  repository: "Repository",
  issue_tracker: "Issue tracker",
  design: "Design",
  documentation: "Documentation",
  other: "Other",
};

const RESOURCE_ICONS: Record<ResourceType, LucideIcon> = {
  repository: GitBranch,
  issue_tracker: Bug,
  design: PenTool,
  documentation: BookOpen,
  other: Link2,
};

/** Outbound links for a project card; renders nothing for a project without resources. */
export function ResourceLinks({ resources }: { readonly resources: readonly ProjectResource[] | undefined }) {
  if (!resources || resources.length === 0) return null;
  return (
    <ul aria-label="Links" className="m-0 mt-3 flex list-none flex-wrap gap-1.5 p-0">
      {resources.map((resource, index) => {
        const Icon = RESOURCE_ICONS[resource.type];
        return (
          // Resources have no identity beyond their position, which is also their order.
          <li key={index}>
            <a
              // Only http(s) URLs pass the core schema, so the href cannot run script.
              href={resource.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${RESOURCE_TYPE_LABELS[resource.type]}: ${resource.url}`}
              className="inline-flex max-w-48 items-center gap-1 rounded-pill border border-rule bg-paper-2 px-2 py-0.5 text-2xs font-medium text-ink-2 transition-colors hover:border-rule-strong hover:text-ink focus-visible:outline-focus"
            >
              <Icon size={12} aria-hidden="true" className="shrink-0" />
              <span className="truncate">{resource.label}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

interface ResourcesEditorProps {
  readonly items: readonly ResourceDraft[];
  readonly onChange: (next: ResourceDraft[]) => void;
  readonly disabled?: boolean;
}

/** Editor for the project form: add, edit, reorder and remove links. */
export function ResourcesEditor({ items, onChange, disabled = false }: ResourcesEditorProps) {
  function update(index: number, patch: Partial<ResourceDraft>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function move(from: number, to: number) {
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    onChange(next);
  }

  const inputClass =
    "min-w-0 rounded-md border border-rule bg-paper-2 px-2 py-1 text-sm text-ink placeholder:text-ink-3 focus-visible:outline-focus";
  const buttonClass =
    "rounded-md p-1 text-ink-3 transition-colors hover:bg-paper-3 hover:text-ink disabled:opacity-30 focus-visible:outline-focus";

  return (
    <div className="flex flex-col gap-2">
      {items.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {items.map((item, index) => {
            const n = String(index + 1);
            const name = item.label.trim() || `link ${n}`;
            return (
              <li key={index} className="flex flex-col gap-1.5 rounded-md border border-rule p-2">
                <div className="flex items-center gap-2">
                  <select
                    aria-label={`Link ${n} type`}
                    value={item.type}
                    disabled={disabled}
                    onChange={(e) => {
                      update(index, { type: e.target.value as ResourceType });
                    }}
                    className={inputClass}
                  >
                    {RESOURCE_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {RESOURCE_TYPE_LABELS[type]}
                      </option>
                    ))}
                  </select>
                  <input
                    type="text"
                    aria-label={`Link ${n} label`}
                    placeholder="Label (defaults to the site)"
                    value={item.label}
                    disabled={disabled}
                    onChange={(e) => {
                      update(index, { label: e.target.value });
                    }}
                    className={`${inputClass} flex-1`}
                  />
                  <button
                    type="button"
                    aria-label={`Move up: ${name}`}
                    disabled={disabled || index === 0}
                    onClick={() => {
                      move(index, index - 1);
                    }}
                    className={buttonClass}
                  >
                    <ArrowUp size={ICON_SIZE} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move down: ${name}`}
                    disabled={disabled || index === items.length - 1}
                    onClick={() => {
                      move(index, index + 1);
                    }}
                    className={buttonClass}
                  >
                    <ArrowDown size={ICON_SIZE} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove: ${name}`}
                    disabled={disabled}
                    onClick={() => {
                      onChange(items.filter((_, i) => i !== index));
                    }}
                    className={`${buttonClass} hover:bg-danger-soft hover:text-danger`}
                  >
                    <X size={ICON_SIZE} aria-hidden="true" />
                  </button>
                </div>
                <input
                  type="url"
                  aria-label={`Link ${n} URL`}
                  placeholder="https://"
                  value={item.url}
                  disabled={disabled}
                  onChange={(e) => {
                    update(index, { url: e.target.value });
                  }}
                  className={inputClass}
                />
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          onChange([...items, { type: "other", label: "", url: "" }]);
        }}
        className="inline-flex items-center gap-1 self-start rounded-md border border-rule px-2 py-1 text-xs font-medium text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink disabled:opacity-50"
      >
        <Plus size={ICON_SIZE} aria-hidden="true" />
        Add link
      </button>
    </div>
  );
}
