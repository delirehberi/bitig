import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmResult, samplePlan } from "../components/dashboard/work-queue-fixtures";
import { confirmWorkQueue, planWorkQueue, WorkQueueApiError } from "./work-queue";

const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_BAD_REQUEST = 400;
const HTTP_CONFLICT = 409;
const HTTP_BAD_GATEWAY = 502;

function stubFetch(body: unknown, status: number) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function bodyOf(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(init.body);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("planWorkQueue", () => {
  it("posts the prompt and edited codes with the CSRF header", async () => {
    const fetchMock = stubFetch(samplePlan(), HTTP_OK);
    const controller = new AbortController();
    const plan = await planWorkQueue({ prompt: "Start BIT-92", items: ["BIT-92"] }, controller.signal);

    expect(plan.rows).toHaveLength(samplePlan().rows.length);
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/work-queue/plan");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", signal: controller.signal });
    expect(init?.headers).toMatchObject({ "X-Bitig-Request": "true", "Content-Type": "application/json" });
    expect(bodyOf(init)).toEqual({ prompt: "Start BIT-92", items: ["BIT-92"] });
  });

  it("leaves items out when only the prompt is given", async () => {
    const fetchMock = stubFetch(samplePlan(), HTTP_OK);
    await planWorkQueue({ prompt: "Start BIT-92" });
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual({ prompt: "Start BIT-92" });
  });

  it("uses the first validation issue as the error message", async () => {
    stubFetch({ error: "validation_error", details: [{ path: ["prompt"], message: "Too long" }] }, HTTP_BAD_REQUEST);
    await expect(planWorkQueue({ prompt: "x" })).rejects.toMatchObject({ status: HTTP_BAD_REQUEST, message: "Too long" });
  });

  it("reports the HTTP status for a non-JSON error", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response("down", { status: HTTP_BAD_GATEWAY })));
    await expect(planWorkQueue({ prompt: "x" })).rejects.toThrow("Could not plan the work queue (HTTP 502)");
  });

  it("refuses a response that is not a plan", async () => {
    stubFetch({ rows: "nope" }, HTTP_OK);
    await expect(planWorkQueue({ prompt: "x" })).rejects.toThrow("unexpected response");
  });
});

describe("confirmWorkQueue", () => {
  it("posts items, approvals and overrides", async () => {
    const fetchMock = stubFetch(confirmResult(samplePlan(), ["BIT-92"]), HTTP_CREATED);
    const input = {
      prompt: "Start BIT-92",
      items: ["BIT-92"],
      approvals: [],
      overrides: [{ code: "BIT-92", level: "strong" }],
    };
    const result = await confirmWorkQueue(input);

    expect(result.queue.entries).toHaveLength(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/work-queue");
    expect(bodyOf(fetchMock.mock.calls[0]?.[1])).toEqual(input);
  });

  it("carries the server's fresh plan when nothing can be queued", async () => {
    const plan = samplePlan();
    stubFetch({ error: "nothing_to_queue", message: "No listed task can be queued.", plan }, HTTP_CONFLICT);
    const error: unknown = await confirmWorkQueue({ prompt: "x", items: ["BIT-1"], approvals: [], overrides: [] }).catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(WorkQueueApiError);
    expect(error).toMatchObject({ status: HTTP_CONFLICT, message: "No listed task can be queued." });
    // The plan went through JSON, which drops keys whose value is undefined.
    expect((error as WorkQueueApiError).plan).toEqual(JSON.parse(JSON.stringify(plan)));
  });
});
