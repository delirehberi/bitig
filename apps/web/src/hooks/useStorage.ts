import { useMemo } from "react";
import type { StorageMode, StorageProvider } from "@bitig/core";
import { InMemoryStorage } from "@bitig/core";
import { ApiStorage } from "@bitig/api-client";
import { NostrStorage, Nip07Signer } from "@bitig/storage-nostr";
import { useAuth } from "../auth/useAuth";

export function useStorage(mode: StorageMode): StorageProvider {
  const { expire } = useAuth();

  return useMemo(() => {
    if (mode === "cloudflare") {
      // The session cookie authenticates same-origin requests; a 401 means it is gone.
      return new ApiStorage({ onUnauthorized: expire });
    }

    if (mode === "nostr") {
      const signer = new Nip07Signer();
      return new NostrStorage({
        signer,
      });
    }

    // Local adapter fallback (P2 FS access API)
    return new InMemoryStorage();
  }, [mode, expire]);
}
