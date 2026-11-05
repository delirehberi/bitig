import { useCallback, useEffect, useState, type SyntheticEvent } from "react";
import { Copy, KeyRound, Laptop, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useAuth } from "../../auth/useAuth";
import { formatFullTimestamp, formatTimeAgo } from "../../domain/time-ago";
import { Link } from "../../routing/Link";
import { hrefFor } from "../../routing/router";
import {
  createMyToken,
  listMySessions,
  listMyTokens,
  revokeMySession,
  revokeMyToken,
  revokeOtherSessions,
  type AccessTokenItem,
  type SessionDeviceInfo,
} from "../../services/multi-user";

export function SecurityView() {
  const { memberships, currentOrg } = useAuth();
  const [sessions, setSessions] = useState<SessionDeviceInfo[]>([]);
  const [tokens, setTokens] = useState<AccessTokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [tokenName, setTokenName] = useState("");
  const [tokenOrgId, setTokenOrgId] = useState<string>(
    currentOrg?.id ?? memberships[0]?.organisation.id ?? "",
  );
  const [creatingToken, setCreatingToken] = useState(false);
  const [createdPlaintextToken, setCreatedPlaintextToken] = useState<string | null>(null);
  const [copiedToken, setCopiedToken] = useState(false);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const [sessList, tokList] = await Promise.all([listMySessions(), listMyTokens()]);
      setSessions(sessList);
      setTokens(tokList);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load sessions and tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([listMySessions(), listMyTokens()]).then(
      ([sessList, tokList]) => {
        if (!active) return;
        setSessions(sessList);
        setTokens(tokList);
        setLoading(false);
      },
      (err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Could not load sessions and tokens");
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);

  async function handleCreateToken(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    const orgId = (tokenOrgId || currentOrg?.id) ?? memberships[0]?.organisation.id;
    if (!tokenName.trim() || !orgId) return;
    setCreatingToken(true);
    setError(null);
    try {
      const res = await createMyToken({
        name: tokenName.trim(),
        orgId,
      });
      setCreatedPlaintextToken(res.token);
      setCopiedToken(false);
      setTokenName("");
      setTokens((prev) => [res.credential, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create token");
    } finally {
      setCreatingToken(false);
    }
  }

  async function handleRevokeToken(id: string) {
    try {
      await revokeMyToken(id);
      setTokens((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke token");
    }
  }

  async function handleRevokeSession(id: string) {
    try {
      await revokeMySession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke session");
    }
  }

  async function handleRevokeOtherSessions() {
    try {
      await revokeOtherSessions();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not sign out other sessions");
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="m-0 font-display text-2xl font-bold text-ink">Sessions & API Tokens</h1>
          <p className="m-0 mt-1 text-sm text-ink-3">
            Manage active browser sessions and personal access tokens for MCP and REST API clients.
          </p>
        </div>
        <Link
          href={hrefFor({ name: "profile" })}
          className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
        >
          Back to profile
        </Link>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <section aria-labelledby="security-tokens-heading" className="mb-6 rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <h2
          id="security-tokens-heading"
          className="m-0 mb-2 flex items-center gap-2 font-display text-base font-bold text-ink"
        >
          <KeyRound size={16} aria-hidden="true" className="text-accent-ink" />
          Personal Access Tokens
        </h2>
        <p className="m-0 mb-4 text-xs text-ink-3">
          Personal access tokens (<code className="font-mono">btg_...</code>) authenticate CLI, MCP, and API requests on
          your behalf.
        </p>

        {createdPlaintextToken && (
          <div
            role="status"
            className="mb-4 rounded-md border border-accent/40 bg-accent-soft p-4 text-xs text-accent-ink"
          >
            <div className="mb-1 font-bold">Copy your new personal access token now — it will not be shown again:</div>
            <div className="flex items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded bg-paper px-2.5 py-1.5 font-mono text-xs text-ink">
                {createdPlaintextToken}
              </code>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard.writeText(createdPlaintextToken);
                  setCopiedToken(true);
                }}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper"
              >
                <Copy size={12} aria-hidden="true" />
                {copiedToken ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
        )}

        <form onSubmit={(e) => void handleCreateToken(e)} className="mb-6 rounded-md border border-rule bg-paper-2 p-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="token-name" className="block text-xs font-semibold text-ink-2">
                Token name
              </label>
              <input
                id="token-name"
                type="text"
                required
                placeholder="Claude Code MCP"
                value={tokenName}
                onChange={(e) => {
                  setTokenName(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-1.5 text-sm text-ink"
                disabled={creatingToken}
              />
            </div>

            <div>
              <label htmlFor="token-org" className="block text-xs font-semibold text-ink-2">
                Organisation
              </label>
              <select
                id="token-org"
                value={(tokenOrgId || currentOrg?.id) ?? memberships[0]?.organisation.id ?? ""}
                onChange={(e) => {
                  setTokenOrgId(e.target.value);
                }}
                className="mt-1 w-full rounded-md border border-rule bg-paper px-3 py-1.5 text-sm text-ink"
                disabled={creatingToken}
              >
                {memberships.map((m) => (
                  <option key={m.organisation.id} value={m.organisation.id}>
                    {m.organisation.name} (/{m.organisation.slug})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="mt-3 flex justify-end">
            <button
              type="submit"
              disabled={creatingToken || !tokenName.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-paper hover:opacity-90 disabled:opacity-50"
            >
              <Plus size={14} aria-hidden="true" />
              {creatingToken ? "Creating\u2026" : "Generate token"}
            </button>
          </div>
        </form>

        {loading ? (
          <p className="m-0 text-xs text-ink-3">Loading tokens…</p>
        ) : tokens.length === 0 ? (
          <p className="m-0 text-xs text-ink-3">No personal access tokens issued yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {tokens.map((token) => (
              <li
                key={token.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-2.5 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{token.name}</span>
                    <code className="rounded bg-paper px-1.5 py-0.5 font-mono text-2xs text-ink-3">
                      {token.prefix}…
                    </code>
                    <span className="font-mono text-2xs text-ink-3">/{token.orgSlug}</span>
                  </div>
                  <div className="mt-0.5 text-2xs text-ink-3">
                    Created{" "}
                    <time dateTime={token.createdAt} title={formatFullTimestamp(token.createdAt)}>
                      {formatTimeAgo(token.createdAt)}
                    </time>
                    {token.lastUsedAt && (
                      <>
                        {" \u00b7 Last used "}
                        <time dateTime={token.lastUsedAt} title={formatFullTimestamp(token.lastUsedAt)}>
                          {formatTimeAgo(token.lastUsedAt)}
                        </time>
                      </>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void handleRevokeToken(token.id)}
                  aria-label={`Revoke token ${token.name}`}
                  className="inline-flex items-center gap-1 rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft"
                >
                  <Trash2 size={12} aria-hidden="true" />
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="security-sessions-heading" className="rounded-lg border border-rule bg-paper p-6 shadow-xs">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              id="security-sessions-heading"
              className="m-0 flex items-center gap-2 font-display text-base font-bold text-ink"
            >
              <Laptop size={16} aria-hidden="true" className="text-accent-ink" />
              Active Sessions ({String(sessions.length)})
            </h2>
            <p className="m-0 mt-0.5 text-xs text-ink-3">Devices currently signed in to your account.</p>
          </div>
          {sessions.length > 1 && (
            <button
              type="button"
              onClick={() => void handleRevokeOtherSessions()}
              className="rounded-md border border-rule bg-paper-2 px-3 py-1.5 text-xs font-semibold text-ink-2 hover:text-ink"
            >
              Sign out all other sessions
            </button>
          )}
        </div>

        {loading ? (
          <p className="m-0 text-xs text-ink-3">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p className="m-0 text-xs text-ink-3">No active server sessions found.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {sessions.map((session) => (
              <li
                key={session.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rule bg-paper-2 px-4 py-2.5 text-xs"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink">{session.userAgent ?? "Browser session"}</span>
                    {session.current && (
                      <span className="inline-flex items-center gap-1 rounded-pill bg-accent-soft px-2 py-0.5 text-2xs font-semibold text-accent-ink">
                        <ShieldCheck size={11} aria-hidden="true" />
                        Current session
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-2xs text-ink-3">
                    {session.ip ? `${session.ip} \u00b7 ` : ""}
                    Last active{" "}
                    <time dateTime={session.lastSeenAt} title={formatFullTimestamp(session.lastSeenAt)}>
                      {formatTimeAgo(session.lastSeenAt)}
                    </time>
                  </div>
                </div>
                {!session.current && (
                  <button
                    type="button"
                    onClick={() => void handleRevokeSession(session.id)}
                    className="rounded-md border border-rule bg-paper px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger-soft"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
