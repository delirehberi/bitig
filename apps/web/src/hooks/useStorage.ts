import { useMemo } from "react";
import type { StorageMode, StorageProvider } from "@bitig/core";
import { InMemoryStorage } from "@bitig/core";
import { ApiStorage } from "@bitig/api-client";
import { useAuth } from "../auth/useAuth";

/**
 * The Cloudflare API client for calls outside the `StorageProvider` contract, such as the feedback form
 * routes. Built with the same session and organisation wiring as `useStorage`.
 */
export function useApiStorage(): ApiStorage {
  const { expire, currentOrg } = useAuth();
  const orgSlug = currentOrg?.slug;

  return useMemo(
    () =>
      new ApiStorage({
        onUnauthorized: expire,
        ...(orgSlug ? { org: orgSlug } : {}),
      }),
    [expire, orgSlug],
  );
}

export function useStorage(mode: StorageMode): StorageProvider {
  const { expire, currentOrg } = useAuth();
  const orgSlug = currentOrg?.slug;

  return useMemo(() => {
    if (mode === "cloudflare") {
      // The session cookie authenticates same-origin requests; a 401 means it is gone.
      return new ApiStorage({
        onUnauthorized: expire,
        ...(orgSlug ? { org: orgSlug } : {}),
      });
    }

    // Local adapter fallback (P2 FS access API)
    return new InMemoryStorage();
  }, [mode, expire, orgSlug]);
}
