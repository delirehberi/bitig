import { useCallback, useEffect, useState } from "react";
import {
  StorageError,
  compareAttachments,
  type Attachment,
  type AttachmentContent,
  type CreateAttachmentInput,
  type OperationOptions,
  type StorageProvider,
} from "@bitig/core";
import { dispatchRealtimeEvent, useRealtimeEvent } from "./useRealtime";

function upsertAttachment(attachments: readonly Attachment[], incoming: Attachment): Attachment[] {
  const exists = attachments.some((a) => a.id === incoming.id);
  const next = exists
    ? attachments.map((a) => (a.id === incoming.id ? incoming : a))
    : [...attachments, incoming];
  return next.sort(compareAttachments);
}

export type AddAttachmentFileInput = Omit<CreateAttachmentInput, "taskId">;

/**
 * One task's attachments, oldest first.
 * Mount it once per task (key the component by task ID): state is not reset when `taskId` changes.
 */
export function useAttachments(storage: StorageProvider, taskId: string) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    storage
      .getAttachments(taskId, { signal: controller.signal })
      .then((result) => {
        setAttachments(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (err instanceof StorageError && err.reason === "unsupported") {
          setUnsupported(true);
          setIsLoading(false);
          return;
        }
        setError(err instanceof Error ? err.message : "Failed to load attachments");
        setIsLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [storage, taskId]);

  useRealtimeEvent((event) => {
    if (unsupported) return;
    switch (event.type) {
      case "attachment.created":
        if (event.attachment.taskId === taskId) {
          setAttachments((prev) => upsertAttachment(prev, event.attachment));
        }
        break;
      case "attachment.deleted":
        setAttachments((prev) => prev.filter((a) => a.id !== event.id));
        break;
      case "sync":
        void storage
          .getAttachments(taskId)
          .then((result) => {
            setAttachments(result);
          })
          .catch((err: unknown) => {
            console.warn("failed to resync attachments", err);
          });
        break;
      default:
        break;
    }
  });

  const addAttachment = useCallback(
    async (input: AddAttachmentFileInput): Promise<Attachment> => {
      const added = await storage.addAttachment({ ...input, taskId }, { actor: "you" });
      setAttachments((prev) => upsertAttachment(prev, added));
      dispatchRealtimeEvent({ type: "attachment.created", attachment: added });
      return added;
    },
    [storage, taskId],
  );

  const deleteAttachment = useCallback(
    async (id: string): Promise<void> => {
      await storage.deleteAttachment(id, { actor: "you" });
      setAttachments((prev) => prev.filter((a) => a.id !== id));
      dispatchRealtimeEvent({ type: "attachment.deleted", id, taskId });
    },
    [storage, taskId],
  );

  const getAttachment = useCallback(
    async (id: string, opts?: OperationOptions): Promise<AttachmentContent | null> => {
      return storage.getAttachment(id, opts);
    },
    [storage],
  );

  return {
    attachments,
    isLoading,
    unsupported,
    error,
    addAttachment,
    deleteAttachment,
    getAttachment,
  };
}
