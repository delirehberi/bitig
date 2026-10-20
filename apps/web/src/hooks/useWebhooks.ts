import { useCallback, useEffect, useState } from "react";
import {
  compareWebhooks,
  type CreateWebhookInput,
  type OperationOptions,
  type StorageProvider,
  type UpdateWebhookInput,
  type Webhook,
} from "@bitig/core";
import { useRealtimeEvent } from "./useRealtime";

function upsertWebhook(webhooks: readonly Webhook[], incoming: Webhook): Webhook[] {
  const exists = webhooks.some((w) => w.id === incoming.id);
  const next = exists ? webhooks.map((w) => (w.id === incoming.id ? incoming : w)) : [...webhooks, incoming];
  return next.sort(compareWebhooks);
}

export function useWebhooks(storage: StorageProvider) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const opts: OperationOptions = { signal: controller.signal };
    storage
      .getWebhooks(undefined, opts)
      .then((result) => {
        setWebhooks(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load webhooks");
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [storage]);

  useRealtimeEvent((event) => {
    switch (event.type) {
      case "webhook.created":
      case "webhook.updated":
        setWebhooks((prev) => upsertWebhook(prev, event.webhook));
        break;
      case "webhook.deleted":
        setWebhooks((prev) => prev.filter((w) => w.id !== event.id));
        break;
      case "project.deleted":
        setWebhooks((prev) => prev.filter((w) => w.projectId !== event.id));
        break;
      case "sync":
        void storage
          .getWebhooks()
          .then((result) => {
            setWebhooks(result);
          })
          .catch((err: unknown) => {
            console.warn("failed to resync webhooks", err);
          });
        break;
      default:
        break;
    }
  });

  const refreshWebhooks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await storage.getWebhooks();
      setWebhooks(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load webhooks");
    } finally {
      setIsLoading(false);
    }
  }, [storage]);

  const createWebhook = useCallback(
    async (input: CreateWebhookInput): Promise<Webhook> => {
      const created = await storage.createWebhook(input);
      setWebhooks((prev) => upsertWebhook(prev, created));
      return created;
    },
    [storage],
  );

  const updateWebhook = useCallback(
    async (id: string, patch: UpdateWebhookInput): Promise<Webhook> => {
      const updated = await storage.updateWebhook(id, patch);
      setWebhooks((prev) => upsertWebhook(prev, updated));
      return updated;
    },
    [storage],
  );

  const deleteWebhook = useCallback(
    async (id: string): Promise<void> => {
      await storage.deleteWebhook(id);
      setWebhooks((prev) => prev.filter((w) => w.id !== id));
    },
    [storage],
  );

  return {
    webhooks,
    isLoading,
    error,
    createWebhook,
    updateWebhook,
    deleteWebhook,
    refreshWebhooks,
  };
}

