import { useCallback, useEffect, useState } from "react";
import type {
  CreateProjectInput,
  OperationOptions,
  Project,
  StorageProvider,
  UpdateProjectInput,
} from "@bitig/core";

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
      const created = await storage.createProject(input);
      setProjects((prev) => [...prev, created]);
      return created;
    },
    [storage],
  );

  const updateProject = useCallback(
    async (id: string, patch: UpdateProjectInput): Promise<Project> => {
      const updated = await storage.updateProject(id, patch);
      setProjects((prev) => prev.map((p) => (p.id === id ? updated : p)));
      return updated;
    },
    [storage],
  );

  const deleteProject = useCallback(
    async (id: string): Promise<void> => {
      await storage.deleteProject(id);
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
