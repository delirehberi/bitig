import { useCallback, useEffect, useState } from "react";
import {
  compareProjects,
  type CreateProjectInput,
  type OperationOptions,
  type Project,
  type StorageProvider,
  type UpdateProjectInput,
} from "@bitig/core";
import { useRealtimeEvent } from "./useRealtime";

function upsertProject(projects: readonly Project[], incoming: Project): Project[] {
  const exists = projects.some((p) => p.id === incoming.id);
  const next = exists ? projects.map((p) => (p.id === incoming.id ? incoming : p)) : [...projects, incoming];
  return next.sort(compareProjects);
}

export function useProjects(storage: StorageProvider) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const opts: OperationOptions = { signal: controller.signal };
    storage
      .getProjects(opts)
      .then((result) => {
        setProjects(result);
        setIsLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load projects");
        setIsLoading(false);
      });

    return () => {
      controller.abort();
    };
  }, [storage]);

  useRealtimeEvent((event) => {
    switch (event.type) {
      case "project.created":
      case "project.updated":
        setProjects((prev) => upsertProject(prev, event.project));
        break;
      case "project.deleted":
        setProjects((prev) => prev.filter((p) => p.id !== event.id));
        break;
      case "sync":
        void storage
          .getProjects()
          .then((result) => {
            setProjects(result);
          })
          .catch((err: unknown) => {
            console.warn("failed to resync projects", err);
          });
        break;
      default:
        break;
    }
  });

  const refreshProjects = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await storage.getProjects();
      setProjects(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setIsLoading(false);
    }
  }, [storage]);

  const createProject = useCallback(
    async (input: CreateProjectInput): Promise<Project> => {
      const created = await storage.createProject(input, { actor: "you" });
      setProjects((prev) => upsertProject(prev, created));
      return created;
    },
    [storage],
  );

  const updateProject = useCallback(
    async (id: string, patch: UpdateProjectInput): Promise<Project> => {
      const updated = await storage.updateProject(id, patch, { actor: "you" });
      setProjects((prev) => upsertProject(prev, updated));
      return updated;
    },
    [storage],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<void> => {
      await storage.deleteProject(id, { actor: "you" });
      setProjects((prev) => prev.filter((p) => p.id !== id));
    },
    [storage],
  );

  return {
    projects,
    isLoading,
    error,
    createProject,
    updateProject,
    deleteProject,
    refreshProjects,
  };
}
