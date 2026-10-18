import { useCallback, useEffect, useState } from "react";
import type {
  CreateTaskInput,
  OperationOptions,
  StorageProvider,
  Task,
  UpdateTaskInput,
} from "@bitig/core";

export function useTasks(storage: StorageProvider, projectId?: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const filter = projectId ? { projectId } : undefined;
    const opts: OperationOptions = { signal: controller.signal };
    storage
      .getTasks(filter, opts)
      .then((result) => {
        setTasks(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load tasks");
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [storage, projectId]);

  const refreshTasks = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const filter = projectId ? { projectId } : undefined;
      const result = await storage.getTasks(filter);
      setTasks(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load tasks");
    } finally {
      setIsLoading(false);
    }
  }, [storage, projectId]);

  const saveTask = useCallback(
    async (input: CreateTaskInput): Promise<Task> => {
      const created = await storage.saveTask(input);
      setTasks((prev) => [...prev, created]);
      return created;
    },
    [storage],
  );

  const updateTask = useCallback(
    async (id: string, patch: UpdateTaskInput): Promise<Task> => {
      const updated = await storage.updateTask(id, patch);
      setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)));
      return updated;
    },
    [storage],
  );

  const completeTask = useCallback(
    async (id: string): Promise<Task> => {
      const completed = await storage.completeTask(id);
      setTasks((prev) => prev.map((t) => (t.id === id ? completed : t)));
      return completed;
    },
    [storage],
  );

  const deleteTask = useCallback(
    async (id: string): Promise<void> => {
      await storage.deleteTask(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
    },
    [storage],
  );

  return {
    tasks,
    isLoading,
    error,
    saveTask,
    updateTask,
    completeTask,
    deleteTask,
    refreshTasks,
  };
}
