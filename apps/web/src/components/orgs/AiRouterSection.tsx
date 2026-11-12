import { useEffect, useState, type SyntheticEvent } from "react";
import { Activity, Bot, Save, Trash2 } from "lucide-react";
import { AI_ROUTER_API_STYLES, AI_ROUTER_BASE_URL_MAX, AI_ROUTER_MODEL_MAX, type AiRouterApiStyle } from "@bitig/core";
import {
  deleteAiRouter,
  fetchAiRouter,
  saveAiRouter,
  testAiRouter,
  type AiRouterSettingsView,
  type AiRouterTestResult,
} from "../../services/run-orchestration";

interface AiRouterSectionProps {
  readonly orgSlug: string;
}

const API_STYLE_LABELS: Record<AiRouterApiStyle, string> = {
  "cloudflare-run": "Cloudflare Workers AI (run)",
  openai: "OpenAI-compatible (responses)",
  "openai-chat": "OpenAI-compatible (chat completions)",
};

interface Form {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiStyle: AiRouterApiStyle;
  readonly enabled: boolean;
  /** A new token typed in; the stored one is never read back. */
  readonly newToken: string;
  readonly removeToken: boolean;
}

function formFrom(view: AiRouterSettingsView): Form {
  return {
    baseUrl: view.baseUrl,
    model: view.model,
    apiStyle: view.apiStyle,
    enabled: view.enabled,
    newToken: "",
    removeToken: false,
  };
}

/** What the token field says about the stored token, without ever showing it. */
function describeStoredToken(view: Pick<AiRouterSettingsView, "hasToken" | "tokenLast4">): string {
  if (!view.hasToken) return "Not set";
  return view.tokenLast4 ? `Set, ends in ${view.tokenLast4}` : "Set";
}

function describeTest(result: AiRouterTestResult): string {
  if (result.ok) {
    return result.suggestion
      ? `The endpoint answered: it suggests level "${result.suggestion.level}".`
      : "The endpoint answered.";
  }
  const status = result.status !== undefined ? ` (HTTP ${String(result.status)})` : "";
  return `The endpoint did not answer${status}: ${result.error ?? "unknown error"}`;
}

/**
 * Organisation AI router settings (#BIT-188, owners only): the endpoint that suggests a task level,
 * effort and touched paths (#BIT-187). The API token is write-only.
 */
export function AiRouterSection({ orgSlug }: AiRouterSectionProps) {
  const [view, setView] = useState<AiRouterSettingsView | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<AiRouterTestResult | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAiRouter(orgSlug, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setView(res);
        setForm(formFrom(res));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not load AI router settings.");
      });
    return () => {
      controller.abort();
    };
  }, [orgSlug]);

  if (!view || !form) {
    return (
      <section className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2 className="m-0 mb-2 font-display text-base font-bold text-ink">AI router</h2>
        {error ? (
          <p role="alert" className="m-0 text-xs text-danger">
            {error}
          </p>
        ) : (
          <p className="m-0 text-xs text-ink-3">Loading AI router settings…</p>
        )}
      </section>
    );
  }

  const currentForm = form;
  const isComplete = currentForm.baseUrl.trim().length > 0 && currentForm.model.trim().length > 0;
  const typedToken = currentForm.newToken.trim();

  function patch(next: Partial<Form>) {
    setForm((prev) => (prev ? { ...prev, ...next } : prev));
    setNotice(null);
  }

  async function act(action: () => Promise<void>, failure: string) {
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setIsBusy(false);
    }
  }

  function handleSave(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    void act(async () => {
      const saved = await saveAiRouter(orgSlug, {
        baseUrl: currentForm.baseUrl.trim(),
        model: currentForm.model.trim(),
        apiStyle: currentForm.apiStyle,
        enabled: currentForm.enabled,
        ...(typedToken ? { apiToken: typedToken } : currentForm.removeToken ? { clearToken: true } : {}),
      });
      setView(saved);
      setForm(formFrom(saved));
      setNotice("AI router settings saved.");
    }, "Could not save AI router settings.");
  }

  function handleTest() {
    setTestResult(null);
    void act(async () => {
      const result = await testAiRouter(orgSlug, {
        baseUrl: currentForm.baseUrl.trim(),
        model: currentForm.model.trim(),
        apiStyle: currentForm.apiStyle,
        ...(typedToken ? { apiToken: typedToken } : {}),
      });
      setTestResult(result);
    }, "Could not test the AI router.");
  }

  function handleRemove() {
    void act(async () => {
      const cleared = await deleteAiRouter(orgSlug);
      setView(cleared);
      setForm(formFrom(cleared));
      setTestResult(null);
      setNotice("AI router removed.");
    }, "Could not remove AI router settings.");
  }

  const canTest = isComplete && (typedToken.length > 0 || (view.hasToken && !currentForm.removeToken));

  return (
    <section aria-labelledby="org-ai-router-heading" className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
      <h2 id="org-ai-router-heading" className="m-0 mb-1 flex items-center gap-2 font-display text-base font-bold text-ink">
        <Bot size={16} aria-hidden="true" className="text-accent-ink" />
        AI router
      </h2>
      <p className="m-0 mb-4 text-xs text-ink-3">
        An endpoint that reads a task and the task levels above, then suggests a level, effort and touched paths.
        Its suggestions never replace a level set by you or an agent.
      </p>

      {error && (
        <div role="alert" className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}
      {notice && (
        <p role="status" className="m-0 mb-3 text-xs text-ink-2">
          {notice}
        </p>
      )}

      <form onSubmit={handleSave} className="flex flex-col gap-3">
        <div>
          <label htmlFor="ai-router-url" className="block text-xs font-semibold text-ink-2">
            Endpoint URL
          </label>
          <input
            id="ai-router-url"
            type="url"
            value={currentForm.baseUrl}
            maxLength={AI_ROUTER_BASE_URL_MAX}
            placeholder="https://api.cloudflare.com/client/v4/accounts/…/ai/run"
            disabled={isBusy}
            onChange={(e) => {
              patch({ baseUrl: e.target.value });
            }}
            className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-xs text-ink"
          />
        </div>

        <div className="flex flex-wrap gap-3">
          <div className="min-w-0 flex-1">
            <label htmlFor="ai-router-model" className="block text-xs font-semibold text-ink-2">
              Model ID
            </label>
            <input
              id="ai-router-model"
              type="text"
              value={currentForm.model}
              maxLength={AI_ROUTER_MODEL_MAX}
              disabled={isBusy}
              onChange={(e) => {
                patch({ model: e.target.value });
              }}
              className="mt-1 w-full rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-xs text-ink"
            />
          </div>
          <div>
            <label htmlFor="ai-router-style" className="block text-xs font-semibold text-ink-2">
              API style
            </label>
            <select
              id="ai-router-style"
              value={currentForm.apiStyle}
              disabled={isBusy}
              onChange={(e) => {
                const style = AI_ROUTER_API_STYLES.find((s) => s === e.target.value);
                if (style) patch({ apiStyle: style });
              }}
              className="mt-1 rounded-md border border-rule bg-paper-2 px-3 py-2 text-xs text-ink"
            >
              {AI_ROUTER_API_STYLES.map((style) => (
                <option key={style} value={style}>
                  {API_STYLE_LABELS[style]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label htmlFor="ai-router-token" className="block text-xs font-semibold text-ink-2">
            API token
          </label>
          <p data-testid="ai-router-token-status" className="m-0 mt-0.5 text-2xs text-ink-3">
            {describeStoredToken(view)}
            {currentForm.removeToken && !typedToken ? " (will be removed on save)" : ""}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              id="ai-router-token"
              type="password"
              autoComplete="off"
              value={currentForm.newToken}
              placeholder={view.hasToken ? "Type a new token to replace it" : "Paste a token"}
              disabled={isBusy}
              onChange={(e) => {
                patch({ newToken: e.target.value, removeToken: false });
              }}
              className="min-w-0 flex-1 rounded-md border border-rule bg-paper-2 px-3 py-2 font-mono text-xs text-ink"
            />
            {view.hasToken && (
              <button
                type="button"
                disabled={isBusy}
                onClick={() => {
                  patch({ newToken: "", removeToken: !currentForm.removeToken });
                }}
                className="rounded-md border border-rule bg-paper-2 px-3 py-2 text-xs text-ink-2 hover:bg-paper-3 disabled:opacity-50"
              >
                {currentForm.removeToken ? "Keep token" : "Remove token"}
              </button>
            )}
          </div>
        </div>

        <label className="inline-flex items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={currentForm.enabled}
            disabled={isBusy}
            onChange={(e) => {
              patch({ enabled: e.target.checked });
            }}
          />
          Enabled: suggest a run profile when a task is approved, and offer Suggest on tasks
        </label>

        {testResult && (
          <p
            role="status"
            data-testid="ai-router-test-result"
            className={`m-0 rounded-md border px-3 py-2 text-xs ${
              testResult.ok ? "border-ok/30 bg-paper-2 text-ink" : "border-danger/30 bg-danger-soft text-danger"
            }`}
          >
            {describeTest(testResult)}
          </p>
        )}

        <div className="flex flex-wrap justify-between gap-2">
          <div className="flex gap-2">
            <button
              type="button"
              disabled={isBusy || !canTest}
              onClick={handleTest}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-paper-2 px-3 py-2 text-xs font-semibold text-ink hover:bg-paper-3 disabled:opacity-50"
            >
              <Activity size={14} aria-hidden="true" />
              Test
            </button>
            {view.configured || view.baseUrl ? (
              <button
                type="button"
                disabled={isBusy}
                onClick={handleRemove}
                className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-paper px-3 py-2 text-xs font-semibold text-danger hover:bg-danger-soft disabled:opacity-50"
              >
                <Trash2 size={14} aria-hidden="true" />
                Remove router
              </button>
            ) : null}
          </div>
          <button
            type="submit"
            disabled={isBusy || !isComplete}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
          >
            <Save size={14} aria-hidden="true" />
            Save router
          </button>
        </div>
      </form>
    </section>
  );
}
