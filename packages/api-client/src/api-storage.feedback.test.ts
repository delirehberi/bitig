import { describe, expect, it, vi } from "vitest";
import { NotFoundError, StorageError, ValidationError } from "@bitig/core";
import { ApiStorage, type FeedbackFormSummary } from "./api-storage";
import { AuthError } from "./errors";

const BASE_URL = "https://api.test";
const PROJECT_ID = "01940000-0000-7000-8000-000000000001";
const FORM_ID = "01940000-0000-7000-8000-000000000005";
const PUBLIC_ID = "abcdefghijklmnopqrstu";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const HTTP_CREATED = 201;
const HTTP_NO_CONTENT = 204;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;

function formSummary(overrides: Partial<FeedbackFormSummary> = {}): FeedbackFormSummary {
  return {
    id: FORM_ID,
    orgId: "01940000-0000-7000-8000-000000000009",
    projectId: PROJECT_ID,
    publicId: PUBLIC_ID,
    name: "Bug reports",
    title: "Report a bug",
    intro: "",
    enabled: true,
    fields: { email: "optional", name: false, categories: [] },
    allowedOrigins: [],
    turnstile: true,
    thankYouText: "Thanks!",
    submissionCount: 0,
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
    publicPath: `/f/${PUBLIC_ID}`,
    publicUrl: `${BASE_URL}/f/${PUBLIC_ID}`,
    publicLink: `${BASE_URL}/f/${PUBLIC_ID}`,
    pendingCount: 0,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("ApiStorage feedback forms", () => {
  it("lists a project's forms from the project-scoped route", async () => {
    const forms = [formSummary()];
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(forms, 200)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.listFeedbackForms(PROJECT_ID)).toEqual(forms);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/projects/${PROJECT_ID}/feedback-forms`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("creates a form in the project without sending projectId or orgId in the body", async () => {
    const created = formSummary();
    const mockFetch = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(created, HTTP_CREATED)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.createFeedbackForm(PROJECT_ID, { name: "Bug reports", title: "Report a bug" })).toEqual(
      created,
    );
    const init = mockFetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    const body = init?.body;
    if (typeof body !== "string") throw new Error("Expected a JSON string body");
    const sent = JSON.parse(body) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("projectId");
    expect(sent).not.toHaveProperty("orgId");
    expect(sent.name).toBe("Bug reports");
  });

  it("rejects an invalid create input before calling the API", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(formSummary(), HTTP_CREATED)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.createFeedbackForm(PROJECT_ID, { name: "" })).rejects.toBeInstanceOf(ValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects an empty update patch before calling the API", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(formSummary(), 200)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.updateFeedbackForm(FORM_ID, {})).rejects.toBeInstanceOf(ValidationError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("sends a partial update as PATCH to the form route", async () => {
    const updated = formSummary({ enabled: false });
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(updated, 200)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.updateFeedbackForm(FORM_ID, { enabled: false })).toEqual(updated);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/feedback-forms/${FORM_ID}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ enabled: false }) }),
    );
  });

  it("deletes a form and resolves on 204", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(new Response(null, { status: HTTP_NO_CONTENT })));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.deleteFeedbackForm(FORM_ID)).resolves.toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/feedback-forms/${FORM_ID}`,
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("rotates the public id via the rotate route", async () => {
    const rotated = formSummary({ publicId: "zyxwvutsrqponmlkjihgf" });
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse(rotated, 200)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    expect(await storage.rotateFeedbackFormPublicId(FORM_ID)).toEqual(rotated);
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/api/feedback-forms/${FORM_ID}/rotate`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("maps 401 to AuthError", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({ error: "unauthorized" }, HTTP_UNAUTHORIZED)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.listFeedbackForms(PROJECT_ID)).rejects.toBeInstanceOf(AuthError);
  });

  it("maps 404 to NotFoundError for the form", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({ error: "not_found" }, HTTP_NOT_FOUND)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.deleteFeedbackForm(FORM_ID)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("maps a server-side 400 to ValidationError with the server's issues", async () => {
    const issues = [{ message: "Name is required", path: ["name"] }];
    const mockFetch = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: "validation_error", details: issues }, HTTP_BAD_REQUEST)),
    );
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.updateFeedbackForm(FORM_ID, { enabled: true })).rejects.toBeInstanceOf(ValidationError);
  });

  it("maps other failures to StorageError", async () => {
    const mockFetch = vi.fn(() => Promise.resolve(jsonResponse({}, HTTP_SERVER_ERROR)));
    const storage = new ApiStorage({ baseUrl: BASE_URL, fetch: mockFetch });

    await expect(storage.rotateFeedbackFormPublicId(FORM_ID)).rejects.toBeInstanceOf(StorageError);
  });
});
