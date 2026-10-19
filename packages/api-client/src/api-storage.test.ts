import { describe, expect, it, vi } from "vitest";
import { NotFoundError, ValidationError, StorageError } from "@bitig/core";
import { ApiStorage } from "./api-storage";
import { AuthError } from "./errors";

const VALID_PROJECT_ID = "01940000-0000-7000-8000-000000000001";
const VALID_TASK_ID = "01940000-0000-7000-8000-000000000002";

describe("ApiStorage", () => {
  it("encodes basic auth credentials in Authorization header", async () => {
    let capturedHeader: string | null = null;
    const mockFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get("Authorization");
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const storage = new ApiStorage({
      baseUrl: "https://api.test/",
      auth: { username: "admin", password: "secretpassword" },
      fetch: mockFetch as unknown as typeof fetch,
    });

    const projects = await storage.getProjects();
    expect(projects).toEqual([]);
    expect(capturedHeader).toBe(`Basic ${btoa("admin:secretpassword")}`);
    expect(mockFetch).toHaveBeenCalledWith("https://api.test/api/projects", expect.anything());
  });

  it("supports dynamic auth function", async () => {
    let capturedHeader: string | null = null;
    const mockFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedHeader = headers.get("Authorization");
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    });

    const storage = new ApiStorage({
      baseUrl: "https://api.test",
      auth: () => "Basic custom-token",
      fetch: mockFetch as unknown as typeof fetch,
    });

    await storage.getProjects();
    expect(capturedHeader).toBe("Basic custom-token");
  });

  it("throws AuthError on 401 Unauthorized", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })),
    );

    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(storage.getProjects()).rejects.toBeInstanceOf(AuthError);
  });

  it("calls onUnauthorized on 401 only", async () => {
    const statuses = [200, 401];
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify([]), { status: statuses.shift() ?? 200 })),
    );
    const onUnauthorized = vi.fn();

    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
      onUnauthorized,
    });

    await storage.getProjects();
    expect(onUnauthorized).not.toHaveBeenCalled();
    await expect(storage.getProjects()).rejects.toBeInstanceOf(AuthError);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("returns null on 404 for getProject and getTask", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })),
    );

    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
    });

    expect(await storage.getProject(VALID_PROJECT_ID)).toBeNull();
    expect(await storage.getTask(VALID_TASK_ID)).toBeNull();
  });

  it("throws NotFoundError on 404 for mutations", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "not_found" }), { status: 404 })),
    );

    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(storage.updateProject(VALID_PROJECT_ID, { name: "New" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(storage.deleteProject(VALID_PROJECT_ID)).rejects.toBeInstanceOf(NotFoundError);
    await expect(storage.updateTask(VALID_TASK_ID, { title: "New" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(storage.deleteTask(VALID_TASK_ID)).rejects.toBeInstanceOf(NotFoundError);
    await expect(storage.completeTask(VALID_TASK_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError on 400 Bad Request", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "validation_error",
            details: [{ path: ["name"], message: "Too short" }],
          }),
          { status: 400 },
        ),
      ),
    );

    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(storage.createProject({ name: "Valid Length" })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it("rejects malformed IDs client-side before network", async () => {
    const mockFetch = vi.fn();
    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(storage.getProject("../malformed")).rejects.toBeInstanceOf(ValidationError);
    await expect(storage.deleteProject("../malformed")).rejects.toBeInstanceOf(ValidationError);
    await expect(storage.getTask("../malformed")).rejects.toBeInstanceOf(ValidationError);
    await expect(storage.deleteTask("../malformed")).rejects.toBeInstanceOf(ValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws StorageError on network failure", async () => {
    const mockFetch = vi.fn(() => Promise.reject(new Error("Failed to connect")));

    const storage = new ApiStorage({
      fetch: mockFetch as unknown as typeof fetch,
    });

    await expect(storage.getProjects()).rejects.toBeInstanceOf(StorageError);
  });

  it("respects AbortSignal", async () => {
    const controller = new AbortController();
    controller.abort("user aborted");

    const storage = new ApiStorage();
    await expect(storage.getProjects({ signal: controller.signal })).rejects.toBe("user aborted");
  });
});
