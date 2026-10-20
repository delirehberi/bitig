import { useCallback, useEffect, useState } from "react";
import { compareComments, type Comment, type StorageProvider } from "@bitig/core";
import { useRealtimeEvent } from "./useRealtime";

function upsertComment(comments: readonly Comment[], incoming: Comment): Comment[] {
  const exists = comments.some((c) => c.id === incoming.id);
  const next = exists ? comments.map((c) => (c.id === incoming.id ? incoming : c)) : [...comments, incoming];
  return next.sort(compareComments);
}

/**
 * One task's comments, oldest first. People write them here, so new ones are marked `human`.
 * Mount it once per task (key the component by task ID): state is not reset when `taskId` changes.
 */
export function useComments(storage: StorageProvider, taskId: string) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    storage
      .getComments(taskId, { signal: controller.signal })
      .then((result) => {
        setComments(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load comments");
        setIsLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [storage, taskId]);

  useRealtimeEvent((event) => {
    switch (event.type) {
      case "comment.created":
        if (event.comment.taskId === taskId) {
          setComments((prev) => upsertComment(prev, event.comment));
        }
        break;
      case "comment.deleted":
        setComments((prev) => prev.filter((c) => c.id !== event.id));
        break;
      case "sync":
        void storage
          .getComments(taskId)
          .then((result) => {
            setComments(result);
          })
          .catch((err: unknown) => {
            console.warn("failed to resync comments", err);
          });
        break;
      default:
        break;
    }
  });

  const addComment = useCallback(
    async (body: string): Promise<Comment> => {
      const added = await storage.addComment({ taskId, body, authorType: "human" });
      setComments((prev) => upsertComment(prev, added));
      return added;
    },
    [storage, taskId],
  );

  const deleteComment = useCallback(
    async (id: string): Promise<void> => {
      await storage.deleteComment(id);
      setComments((prev) => prev.filter((c) => c.id !== id));
    },
    [storage],
  );

  return { comments, isLoading, error, addComment, deleteComment };
}
