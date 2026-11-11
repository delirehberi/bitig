import { afterEach, describe, expect, it, vi } from "vitest";
import {
  disconnectT3Host,
  fetchT3Host,
  fetchT3Hosts,
  fetchT3RemoteProjects,
  settleProjectT3Thread,
  startT3OAuth,
  startTaskT3Run,
  T3ApiError,
  T3WorkspaceBusyApiError,
  updateT3Host,
} from "./t3";

const TASK_ID = "01940000-0000-7000-8000-000000000001";
const HTTP_OK = 200;
const HTTP_CONFLICT = 409;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_GATEWAY = 502;

describe("settleProjectT3Thread", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("encodes the path and accepts an empty 204 response", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: HTTP_NO_CONTENT }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await expect(settleProjectT3Thread("project/one", "thread/two", controller.signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/t3/projects/project%2Fone/threads/thread%2Ftwo/settle", expect.objectContaining({
      method: "POST", credentials: "same-origin", signal: controller.signal,
    }));
  });

  it("surfaces host errors for the panel to display", async () => {
    stubFetchResponse({ message: "Host unavailable" }, HTTP_BAD_GATEWAY);
    await expect(settleProjectT3Thread(TASK_ID, "thread")).rejects.toMatchObject({
      status: HTTP_BAD_GATEWAY, message: "Host unavailable",
    });
  });
});

function stubFetchResponse(body: unknown, status: number): void {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status })));
}

async function startError(): Promise<unknown> {
  try {
    await startTaskT3Run(TASK_ID, { workspaceStrategy: "root" });
  } catch (error) {
    return error;
  }
  throw new Error("expected startTaskT3Run to reject");
}

describe("startTaskT3Run workspace guard (#BIT-134)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws T3WorkspaceBusyApiError with the busy session on 409 workspace_busy", async () => {
    stubFetchResponse(
      {
        error: "workspace_busy",
        message: "Another T3 session (BIT-9) is working in this project's root checkout.",
        session: {
          threadId: "thread-busy",
          state: "working",
          taskId: "task-9",
          taskCode: "BIT-9",
          title: "Busy task",
          link: "https://t3.example.test/threads/thread-busy",
        },
      },
      HTTP_CONFLICT,
    );

    const error = await startError();
    expect(error).toBeInstanceOf(T3WorkspaceBusyApiError);
    const busy = error as T3WorkspaceBusyApiError;
    expect(busy.status).toBe(HTTP_CONFLICT);
    expect(busy.message).toBe("Another T3 session (BIT-9) is working in this project's root checkout.");
    expect(busy.session).toEqual({
      threadId: "thread-busy",
      state: "working",
      taskId: "task-9",
      taskCode: "BIT-9",
      title: "Busy task",
      link: "https://t3.example.test/threads/thread-busy",
    });
  });

  it("drops a non-http(s) link so it is never rendered as an href", async () => {
    stubFetchResponse(
      {
        error: "workspace_busy",
        message: "busy",
        session: { threadId: "thread-busy", state: "waiting_for_approval", link: "javascript:alert(1)" },
      },
      HTTP_CONFLICT,
    );

    const busy = (await startError()) as T3WorkspaceBusyApiError;
    expect(busy).toBeInstanceOf(T3WorkspaceBusyApiError);
    expect(busy.session).toEqual({ threadId: "thread-busy", state: "waiting_for_approval" });
  });

  it("throws a plain T3ApiError for other conflicts and malformed sessions", async () => {
    stubFetchResponse({ error: "thread_busy", message: "Switch models later." }, HTTP_CONFLICT);
    const other = await startError();
    expect(other).toBeInstanceOf(T3ApiError);
    expect(other).not.toBeInstanceOf(T3WorkspaceBusyApiError);
    expect((other as T3ApiError).message).toBe("Switch models later.");

    stubFetchResponse({ error: "workspace_busy", message: "busy", session: { threadId: "t", state: "finished" } }, HTTP_CONFLICT);
    expect(await startError()).not.toBeInstanceOf(T3WorkspaceBusyApiError);
  });
});

describe("multi-host client APIs (#BIT-152)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads connected hosts and single host status", async () => {
    const host = {
      id: "host-1",
      label: "Laptop",
      kind: "user" as const,
      projectsRoot: "~/www",
      connected: true as const,
      mcpUrl: "https://t3.example.test/mcp",
      issuer: "https://t3.example.test",
      connectedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      expiresInDays: 30,
      expiringSoon: false,
      expired: false,
    };
    stubFetchResponse({ hosts: [host] }, HTTP_OK);
    await expect(fetchT3Hosts()).resolves.toEqual([host]);

    stubFetchResponse(host, HTTP_OK);
    await expect(fetchT3Host("host/1")).resolves.toEqual(host);
  });

  it("starts OAuth for a new or reauthorised host and updates or disconnects a host", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ authorizationUrl: "https://t3.example.test/authorize", state: "s1" }, { status: HTTP_OK }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await startT3OAuth({
      mcpUrl: "https://t3.example.test/mcp",
      hostId: "host-1",
      label: "Laptop",
      kind: "user",
      projectsRoot: "~/www",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/t3/oauth/start",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          mcpUrl: "https://t3.example.test/mcp",
          hostId: "host-1",
          label: "Laptop",
          kind: "user",
          projectsRoot: "~/www",
        }),
      }),
    );

    stubFetchResponse({ id: "host-1", projectsRoot: "/srv/code" }, HTTP_OK);
    await expect(updateT3Host("host-1", { projectsRoot: "/srv/code" })).resolves.toMatchObject({
      id: "host-1",
      projectsRoot: "/srv/code",
    });

    stubFetchResponse({ error: "host_busy", message: "Stop active sessions before disconnecting." }, HTTP_CONFLICT);
    await expect(disconnectT3Host("host-1")).rejects.toMatchObject({
      status: HTTP_CONFLICT,
      message: "Stop active sessions before disconnecting.",
    });

    stubFetchResponse({ projects: [{ id: "p1", title: "Repo" }] }, HTTP_OK);
    await expect(fetchT3RemoteProjects(undefined, "host-1")).resolves.toEqual([{ id: "p1", title: "Repo" }]);
  });
});

