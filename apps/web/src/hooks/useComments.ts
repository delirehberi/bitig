import { useCallback, useEffect, useState } from "react";
import type { Comment, StorageProvider } from "@bitig/core";

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

  const addComment = useCallback(
    async (body: string): Promise<Comment> => {
      const added = await storage.addComment({ taskId, body, authorType: "human" });
      setComments((prev) => [...prev, added]);
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
