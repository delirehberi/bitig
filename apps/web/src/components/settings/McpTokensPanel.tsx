import { useState } from "react";
import { MCP_TOKEN_ACTIVE_LIMIT, MCP_TOKEN_LABEL_MAX_LENGTH, type McpTokenTransport } from "@bitig/core";
import { KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import { useMcpTokens } from "../../hooks/useMcpTokens";

const INPUT_CLASS = "w-full rounded-md border border-rule bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent";
const BUTTON_CLASS = "rounded-md border border-rule px-3 py-2 text-sm font-semibold text-ink hover:bg-paper-2 disabled:cursor-not-allowed disabled:opacity-50";

export function McpTokensPanel() {
  const state = useMcpTokens();
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<McpTokenTransport>("bearer");
  const [expiry, setExpiry] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  async function submit(event: React.SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setInputError(null);
    const parsedExpiry = expiry.length === 0 ? null : new Date(expiry);
    if (parsedExpiry !== null && (Number.isNaN(parsedExpiry.getTime()) || parsedExpiry.getTime() <= Date.now())) {
      setInputError("Choose an expiry in the future, or leave it empty.");
      return;
    }
    await state.create({ label, transport, expiresAt: parsedExpiry?.toISOString() ?? null });
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="note" className="flex items-start gap-3 rounded-lg border border-rule bg-paper-2 p-4 text-sm text-ink-2">
        <ShieldCheck size={20} aria-hidden="true" className="shrink-0 text-accent-ink" />
        <p className="m-0">Existing environment tokens remain unchanged and are never displayed here. New tokens grant full MCP access to Bitig; create one per client so you can revoke it independently.</p>
      </div>
      {(state.error ?? inputError) && <p role="alert" className="m-0 rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-danger">{inputError ?? state.error}</p>}
      {state.notice && <p role="status" className="m-0 text-sm text-accent-ink">{state.notice}</p>}

      {state.created && (
        <section aria-labelledby="new-token-heading" className="flex flex-col gap-3 rounded-lg border border-accent/30 bg-accent-soft p-5">
          <h2 id="new-token-heading" className="m-0 font-display text-lg font-bold text-ink">Save your token now</h2>
          <p className="m-0 text-sm text-ink-2">This secret is shown only once. Dismissing it or leaving this tab clears it. If lost, revoke this token and create another.</p>
          <label className="text-sm font-semibold text-ink" htmlFor="revealed-mcp-token">New token for {state.created.credential.label}</label>
          <textarea id="revealed-mcp-token" readOnly value={state.created.token} spellCheck={false} autoComplete="off" className={`${INPUT_CLASS} font-mono`} />
          <p className="m-0 break-all font-mono text-xs text-ink-2">
            {state.created.credential.transport === "bearer" ? "Send Authorization: Bearer <token> to /mcp" : "Use /mcp?token=<token> without an Authorization header"}
          </p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON_CLASS} onClick={() => { void state.copy(); }}>Copy token</button>
            <button type="button" className={BUTTON_CLASS} onClick={state.dismiss}>I saved it — dismiss</button>
          </div>
        </section>
      )}

      <section aria-labelledby="create-token-heading" className="rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2 id="create-token-heading" className="m-0 flex items-center gap-2 font-display text-lg font-bold text-ink"><KeyRound size={18} aria-hidden="true" />Create MCP token</h2>
        <form onSubmit={(event) => { void submit(event); }} className="mt-5 flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Client name
            <input required maxLength={MCP_TOKEN_LABEL_MAX_LENGTH} value={label} onChange={(event) => { setLabel(event.target.value); }} placeholder="e.g. Claude Desktop on laptop" className={INPUT_CLASS} />
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Authentication
              <select value={transport} onChange={(event) => { setTransport(event.target.value === "query" ? "query" : "bearer"); }} className={INPUT_CLASS}>
                <option value="bearer">Bearer header (recommended)</option>
                <option value="query">URL query token</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm font-semibold text-ink">Expires at (optional, local time)
              <input type="datetime-local" value={expiry} onChange={(event) => { setExpiry(event.target.value); }} className={INPUT_CLASS} />
            </label>
          </div>
          {transport === "query" && <p role="note" className="m-0 text-sm text-danger">URL tokens can appear in client history and infrastructure logs. Prefer a Bearer header whenever your client supports it.</p>}
          <button type="submit" disabled={state.isLoading || state.isPending || state.error !== null || label.trim().length === 0 || state.created !== null} className="self-start rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
            {state.isPending ? "Working…" : "Generate token"}
          </button>
        </form>
      </section>

      <section aria-labelledby="tokens-heading" className="rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="tokens-heading" className="m-0 font-display text-lg font-bold text-ink">Client tokens</h2>
          <button type="button" onClick={state.refresh} disabled={state.isLoading || state.isPending} className={`${BUTTON_CLASS} flex items-center gap-2`}><RefreshCw size={14} aria-hidden="true" />Reload tokens</button>
        </div>
        <p className="text-xs text-ink-3">Up to {MCP_TOKEN_ACTIVE_LIMIT} active tokens. All active tokens and recent inactive tokens are listed; secrets cannot be retrieved.</p>
        {state.isLoading ? <p role="status" className="text-sm text-ink-2">Loading tokens…</p> : state.tokens.length === 0 ? <p className="text-sm text-ink-2">No generated tokens yet. Your existing environment tokens are unaffected.</p> : (
          <ul className="m-0 flex list-none flex-col divide-y divide-rule p-0">
            {state.tokens.map((token) => {
              const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() <= state.now;
              const status = token.revokedAt !== null ? "Revoked" : expired ? "Expired" : "Active";
              return (
                <li key={token.id} className="flex flex-col gap-3 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 text-sm">
                      <p className="m-0 break-words font-semibold text-ink">{token.label} <span className="ml-2 text-xs font-normal text-ink-3">{status}</span></p>
                      <p className="my-1 text-xs text-ink-2">{token.transport === "bearer" ? "Bearer header" : "URL query"} · Created {new Date(token.createdAt).toLocaleString()}</p>
                      <p className="m-0 text-xs text-ink-3">{token.expiresAt === null ? "No expiry" : `Expires ${new Date(token.expiresAt).toLocaleString()}`}</p>
                    </div>
                    {token.revokedAt === null && <button type="button" aria-label={`Revoke ${token.label}`} disabled={state.isPending || state.isLoading} className={BUTTON_CLASS} onClick={() => { setConfirmId(token.id); }}>Revoke</button>}
                  </div>
                  {confirmId === token.id && <div role="group" aria-label={`Confirm revoke ${token.label}`} className="rounded-md border border-danger/30 p-3 text-sm text-ink">
                    <p className="mt-0">Revoke {token.label}? This client will lose access. Other tokens, including existing environment tokens, stay unchanged.</p>
                    <div className="flex gap-2">
                      <button type="button" disabled={state.isPending || state.isLoading} className={BUTTON_CLASS} onClick={() => { setConfirmId(null); void state.revoke(token.id); }}>Confirm revoke</button>
                      <button type="button" disabled={state.isPending} className={BUTTON_CLASS} onClick={() => { setConfirmId(null); }}>Cancel</button>
                    </div>
                  </div>}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
