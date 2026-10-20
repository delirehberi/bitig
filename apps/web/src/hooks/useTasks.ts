import { useCallback, useEffect, useRef, useState } from "react";
import {
  withTaskCommentCount,
  type CreateTaskInput,
  type OperationOptions,
  type StorageProvider,
  type Task,
  type UpdateTaskInput,
} from "@bitig/core";
import { useRealtimeEvent } from "./useRealtime";

function upsertTask(tasks: readonly Task[], incoming: Task, projectId?: string): Task[] {
  if (projectId !== undefined && incoming.projectId !== projectId) {
    return tasks.filter((t) => t.id !== incoming.id);
  }
  if (tasks.some((t) => t.id === incoming.id)) {
    return tasks.map((t) => {
      if (t.id !== incoming.id) return t;
      if (incoming.commentCount === undefined && t.commentCount !== undefined) {
        return { ...incoming, commentCount: t.commentCount };
      }
      return incoming;
    });
  }
  return [...tasks, incoming];
}

export function useTasks(storage: StorageProvider, projectId?: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const createdCommentIdsRef = useRef(new Set<string>());
  const deletedCommentIdsRef = useRef(new Set<string>());

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

  useRealtimeEvent((event) => {
    switch (event.type) {
      case "task.created":
      case "task.updated":
        setTasks((prev) => upsertTask(prev, event.task, projectId));
        break;
      case "task.deleted":
        setTasks((prev) => prev.filter((t) => t.id !== event.id));
        break;
      case "project.deleted":
        setTasks((prev) => prev.filter((t) => t.projectId !== event.id));
        break;
      case "comment.created": {
        if (createdCommentIdsRef.current.has(event.comment.id)) break;
        createdCommentIdsRef.current.add(event.comment.id);
        setTasks((prev) =>
          prev.map((t) =>
            t.id === event.comment.taskId
              ? withTaskCommentCount(t, (t.commentCount ?? 0) + 1)
              : t,
          ),
        );
        break;
      }
      case "comment.deleted": {
        if (deletedCommentIdsRef.current.has(event.id)) break;
        deletedCommentIdsRef.current.add(event.id);
        if (event.taskId !== undefined) {
          const targetTaskId = event.taskId;
          setTasks((prev) =>
            prev.map((t) =>
              t.id === targetTaskId
                ? withTaskCommentCount(t, Math.max(0, (t.commentCount ?? 0) - 1))
                : t,
            ),
          );
        } else {
          const filter = projectId ? { projectId } : undefined;
          void storage
            .getTasks(filter)
            .then((result) => {
              setTasks(result);
            })
            .catch((err: unknown) => {
              console.warn("failed to resync tasks", err);
            });
        }
        break;
      }
      case "sync": {
        const filter = projectId ? { projectId } : undefined;
        void storage
          .getTasks(filter)
          .then((result) => {
            setTasks(result);
          })
          .catch((err: unknown) => {
            console.warn("failed to resync tasks", err);
          });
        break;
      }
      default:
        break;
    }
  });

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
      setTasks((prev) => upsertTask(prev, created, projectId));
      return created;
    },
    [storage, projectId],
  );

  const updateTask = useCallback(
    async (id: string, patch: UpdateTaskInput): Promise<Task> => {
      const updated = await storage.updateTask(id, patch);
      setTasks((prev) => upsertTask(prev, updated, projectId));
      return updated;
    },
    [storage, projectId],
  );

  const completeTask = useCallback(
    async (id: string): Promise<Task> => {
      const completed = await storage.completeTask(id);
      setTasks((prev) => upsertTask(prev, completed, projectId));
      return completed;
    },
    [storage, projectId],
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
