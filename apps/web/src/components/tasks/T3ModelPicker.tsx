import type { T3ModelCapability, T3ModelOptionValue, T3ModelSelection } from "@bitig/core";

/** Separates provider instance and model in a picker value; neither contains it. */
const MODEL_KEY_SEPARATOR = "::";
const KEEP_CURRENT_VALUE = "";

function modelKey(cap: { readonly providerInstanceId: string; readonly model: string }): string {
  return `${cap.providerInstanceId}${MODEL_KEY_SEPARATOR}${cap.model}`;
}

/** Option values travel through `<select>` as strings; booleans are encoded so they round-trip. */
function encodeOptionValue(value: T3ModelOptionValue): string {
  return typeof value === "boolean" ? `bool:${String(value)}` : `str:${value}`;
}

function decodeOptionValue(raw: string): T3ModelOptionValue {
  if (raw === "bool:true") return true;
  if (raw === "bool:false") return false;
  return raw.startsWith("str:") ? raw.slice("str:".length) : raw;
}

function formatOptionValue(value: T3ModelOptionValue): string {
  return typeof value === "boolean" ? (value ? "on" : "off") : value;
}

/** The selection a model starts with: each option at its default, or its first value. */
function defaultT3ModelSelection(cap: T3ModelCapability): T3ModelSelection {
  const options = (cap.options ?? []).flatMap((opt) => {
    const value = opt.default ?? opt.values[0];
    return value === undefined ? [] : [{ id: opt.id, value }];
  });
  return {
    providerInstanceId: cap.providerInstanceId,
    model: cap.model,
    ...(options.length > 0 ? { options } : {}),
  };
}

interface T3ModelPickerProps {
  /** Unique per picker on the page; used for the select's element ID. */
  readonly idSuffix: string;
  /** Visible label of the model select. */
  readonly label?: string | undefined;
  /** Text of the first option, which keeps the thread's current (or T3's default) model. */
  readonly keepLabel: string;
  readonly capabilities: readonly T3ModelCapability[];
  /** `null` keeps the thread's current model. */
  readonly value: T3ModelSelection | null;
  readonly onChange: (next: T3ModelSelection | null) => void;
  readonly disabled: boolean;
}

const DEFAULT_PICKER_LABEL = "Reply with model";

/**
 * Provider, model and option (e.g. effort) selects for a T3 thread: task replies (#BIT-119) and
 * project-level threads (#BIT-127).
 */
export function T3ModelPicker({
  idSuffix,
  label = DEFAULT_PICKER_LABEL,
  keepLabel,
  capabilities,
  value,
  onChange,
  disabled,
}: T3ModelPickerProps) {
  const selectedCap = value ? capabilities.find((cap) => modelKey(cap) === modelKey(value)) : undefined;
  const modelSelectId = `t3-model-${idSuffix}`;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
      <label htmlFor={modelSelectId}>{label}</label>
      <select
        id={modelSelectId}
        value={value ? modelKey(value) : KEEP_CURRENT_VALUE}
        disabled={disabled}
        onChange={(e) => {
          const cap = capabilities.find((c) => modelKey(c) === e.target.value);
          onChange(cap ? defaultT3ModelSelection(cap) : null);
        }}
        className="rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
      >
        <option value={KEEP_CURRENT_VALUE}>{keepLabel}</option>
        {capabilities.map((cap) => (
          <option key={modelKey(cap)} value={modelKey(cap)}>
            {cap.displayName ? `${cap.displayName}: ` : ""}
            {cap.label ?? cap.model}
          </option>
        ))}
      </select>

      {value &&
        selectedCap?.options?.map((opt) => {
          const chosen = value.options?.find((o) => o.id === opt.id)?.value;
          return (
            <select
              key={opt.id}
              aria-label={`T3 ${opt.id}`}
              value={chosen === undefined ? "" : encodeOptionValue(chosen)}
              disabled={disabled}
              onChange={(e) => {
                const nextValue = decodeOptionValue(e.target.value);
                const others = (value.options ?? []).filter((o) => o.id !== opt.id);
                onChange({ ...value, options: [...others, { id: opt.id, value: nextValue }] });
              }}
              className="rounded-md border border-rule bg-paper px-2 py-1 text-xs text-ink disabled:opacity-50"
            >
              {opt.values.map((v) => (
                <option key={encodeOptionValue(v)} value={encodeOptionValue(v)}>
                  {opt.id}: {formatOptionValue(v)}
                </option>
              ))}
            </select>
          );
        })}
    </div>
  );
}
