import { describe, expect, it, vi } from "vitest";
import { NotFoundError, StorageError, ValidationError } from "@bitig/core";
import { ApiStorage, type TaskFeedbackDetail } from "./api-storage";
import { AuthError } from "./errors";

const BASE_URL = "https://api.test";
const TASK_ID = "01940000-0000-7000-8000-000000000011";
const TARGET_TASK_ID = "01940000-0000-7000-8000-000000000012";
const FORM_ID = "01940000-0000-7000-8000-000000000005";
const PROJECT_ID = "01940000-0000-7000-8000-000000000001";
const ORG_ID = "01940000-0000-7000-8000-000000000009";
const ENTRY_ID = "01940000-0000-7000-8000-000000000013";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

function feedbackDetail(overrides: Partial<TaskFeedbackDetail> = {}): TaskFeedbackDetail {
  return {
    id: ENTRY_ID,
    taskId: TASK_ID,
    formId: FORM_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    outcome: "pending",
    category: "Bug",
    pageUrl: "https://example.com/pricing",
    spamScore: 0,
    createdAt: TIMESTAMP,
    form: { id: FORM_ID, name: "Bug reports", title: "Report a bug", publicId: "abcdefghijklmnopqrstu" },
    submitter: { name: "Ada" },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("ApiStorage task feedback", () => {
  it("loads the feedback entry behind a task from the task-scoped route", async () => {
    const detail = feedbackDetail();
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(detail, HTTP_OK)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.getTaskFeedback(TASK_ID)).toEqual(detail);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/tasks/${TASK_ID}/feedback`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects an invalid task id before calling the API", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({}, HTTP_OK)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.getTaskFeedback("not-an-id")).rejects.toThrow();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("posts a merge with the target task id and returns the removed and target ids", async () => {
    const result = { deletedTaskId: TASK_ID, mergedIntoTaskId: TARGET_TASK_ID };
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(result, HTTP_OK)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.mergeTaskFeedback(TASK_ID, TARGET_TASK_ID)).toEqual(result);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/tasks/${TASK_ID}/feedback/merge`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ taskId: TARGET_TASK_ID }),
      }),
    );
  });

  it("rejects a feedback task via the reject route", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({ deletedTaskId: TASK_ID }, HTTP_OK)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.rejectTaskFeedback(TASK_ID)).toEqual({ deletedTaskId: TASK_ID });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/tasks/${TASK_ID}/feedback/reject`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("marks a feedback task as spam via the spam route", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ deletedTaskId: TASK_ID, blockedIp: true }, HTTP_OK)),
    );
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.markTaskFeedbackSpam(TASK_ID)).toEqual({ deletedTaskId: TASK_ID, blockedIp: true });
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/tasks/${TASK_ID}/feedback/spam`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps 401 to AuthError", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({ error: "unauthorized" }, HTTP_UNAUTHORIZED)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.rejectTaskFeedback(TASK_ID)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 404 to NotFoundError when the task has no feedback entry", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({ error: "not_found" }, HTTP_NOT_FOUND)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.getTaskFeedback(TASK_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps a server-side 400 on merge to ValidationError", async () => {
    const issues = [{ message: "Invalid task id", path: ["taskId"] }];
    const mockFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: "validation_error", details: issues }, HTTP_BAD_REQUEST)),
    );
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.mergeTaskFeedback(TASK_ID, TARGET_TASK_ID)).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps other failures to StorageError", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({}, HTTP_SERVER_ERROR)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.markTaskFeedbackSpam(TASK_ID)).rejects.toBeInstanceOf(StorageError);
  });
});
