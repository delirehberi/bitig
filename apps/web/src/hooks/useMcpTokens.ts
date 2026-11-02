import { useCallback, useEffect, useRef, useState } from "react";
import { MCP_TOKEN_LIST_LIMIT, type CreatedMcpToken, type CreateMcpTokenInput, type McpTokenMetadata } from "@bitig/core";
import { createMcpToken, listMcpTokens, revokeMcpToken } from "../services/mcp-tokens";

const STATUS_REFRESH_MS = 30_000;

export function useMcpTokens() {
  const [tokens, setTokens] = useState<McpTokenMetadata[]>([]);
  const [created, setCreated] = useState<CreatedMcpToken | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  const mutation = useRef<AbortController | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setInterval(() => { setNow(Date.now()); }, STATUS_REFRESH_MS);
    return () => {
      window.clearInterval(timer);
      mounted.current = false;
      mutation.current?.abort();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listMcpTokens(controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setTokens(result);
      setIsLoading(false);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Could not load MCP tokens.");
      setIsLoading(false);
    });
    return () => { controller.abort(); };
  }, [revision]);

  const refresh = useCallback(() => {
    if (mutation.current !== null) return;
    setError(null);
    setIsLoading(true);
    setRevision((current) => current + 1);
  }, []);

  const create = useCallback(async (input: CreateMcpTokenInput) => {
    if (mutation.current !== null) return;
    const controller = new AbortController();
    mutation.current = controller;
    setIsPending(true);
    setError(null);
    setCreated(null);
    setNotice(null);
    try {
      const result = await createMcpToken(input, controller.signal);
      if (controller.signal.aborted) return;
      setCreated(result);
      setTokens((current) => [result.credential, ...current].slice(0, MCP_TOKEN_LIST_LIMIT));
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Could not create token. Reload the list before retrying.");
    } finally {
      if (!controller.signal.aborted) setIsPending(false);
      mutation.current = null;
    }
  }, []);

  const revoke = useCallback(async (id: string) => {
    if (mutation.current !== null) return;
    const controller = new AbortController();
    mutation.current = controller;
    setIsPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await revokeMcpToken(id, controller.signal);
      if (controller.signal.aborted) return;
      setTokens((current) => current.map((token) => token.id === id ? result : token));
      setCreated((current) => current?.credential.id === id ? null : current);
      setNotice(`Revoked token for ${result.label}. Other clients are unchanged.`);
    } catch (reason) {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Could not revoke token. Reload the list to verify its status.");
    } finally {
      if (!controller.signal.aborted) setIsPending(false);
      mutation.current = null;
    }
  }, []);

  const copy = useCallback(async () => {
    if (created === null) return;
    try {
      await navigator.clipboard.writeText(created.token);
      if (mounted.current) setNotice("Token copied. Store it securely; it cannot be shown again.");
    } catch {
      if (mounted.current) setError("Clipboard access failed. Select the revealed token and copy it manually.");
    }
  }, [created]);

  const dismiss = useCallback(() => { setCreated(null); setNotice(null); }, []);
  return { tokens, created, isLoading, isPending, error, notice, now, refresh, create, revoke, copy, dismiss };
}
