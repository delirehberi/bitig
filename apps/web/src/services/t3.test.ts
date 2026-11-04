import { afterEach, describe, expect, it, vi } from "vitest";
import { startTaskT3Run, T3ApiError, T3WorkspaceBusyApiError } from "./t3";

const TASK_ID = "01940000-0000-7000-8000-000000000001";
const HTTP_CONFLICT = 409;

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
