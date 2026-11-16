import { describe, expect, it, vi } from "vitest";
import type { WorkQueueProjectRef } from "@bitig/core";
import { encryptT3Token } from "../src/t3/crypto";
import {
  parseWorkQueuePromptWithFallback,
  resolveWorkQueueRouterState,
  WORK_QUEUE_PROMPT_MAX_CHARS,
  type WorkQueueRouterConfig,
  type WorkQueueRouterState,
} from "../src/work-queue/parse-fallback";

const ENCRYPTION_KEY = "work-queue-parse-test-secret-at-least-32-characters";
const API_TOKEN = "router-test-token";
const BASE_URL = "https://router.example.test/accounts/acc/ai/run";
const MODEL = "@cf/test/parse-model";
const OPENAI_BASE_URL = "https://router.example.test/v1";
const PROJECTS: readonly WorkQueueProjectRef[] = [
  { key: "BIT", name: "Bitig" },
  { key: "WEB", name: "Website" },
];

const READY_CONFIG: WorkQueueRouterConfig = {
  baseUrl: BASE_URL,
  model: MODEL,
  apiToken: API_TOKEN,
  apiStyle: "cloudflare-run",
};
const READY: WorkQueueRouterState = { status: "ready", config: READY_CONFIG };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Cloudflare Workers AI wrapper around a model answer. */
function runWrapper(answer: unknown): Response {
  return jsonResponse({ success: true, result: { response: JSON.stringify(answer) } });
}

function stubFetch(response: () => Response): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(() => Promise.resolve(response()));
}

describe("parseWorkQueuePromptWithFallback", () => {
  it("preserves deterministic exclusions against model suggestions", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: ["BIT-2", "BIT-3"], ranges: [] }));
    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 except BIT-2 and the fixes",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1", "BIT-3"]);
  });

  it("merges validated model codes and ranges after the deterministic result", async () => {
    const fetchFn = stubFetch(() =>
      runWrapper({ codes: ["BIT-7"], ranges: [{ key: "BIT", from: 20, to: 22 }] }),
    );

    const result = await parseWorkQueuePromptWithFallback({
      text: "the bitig ones, plus BIT-1",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("applied");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual([
      "BIT-1",
      "BIT-7",
      "BIT-20",
      "BIT-21",
      "BIT-22",
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/${MODEL}`);
    expect(init?.headers).toEqual({
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(typeof init?.body).toBe("string");
    const sent = JSON.parse(init?.body as string) as { messages: { content: string }[] };
    expect(sent.messages[1]?.content).toContain('"key":"BIT"');
    expect(sent.messages[1]?.content).toContain('"name":"Website"');
  });

  it("does not call the router when the deterministic parser is complete", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: [], ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 to BIT-3",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("not_needed");
    expect(result.items).toHaveLength(3);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not call the router for an empty prompt", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: [], ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "   ",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("not_needed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("calls the router when unparsed words remain", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: ["WEB-4"], ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 and the homepage fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1", "WEB-4"]);
    expect(result.unparsed).toEqual(["homepage", "fix"]);
  });

  it("returns the deterministic result with a warning on invalid JSON in the response body", async () => {
    const fetchFn = vi.fn<typeof fetch>(() => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })));

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 and the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1"]);
    expect(result.warnings).toContain(
      "AI parse fallback failed (invalid_json); showing the deterministic result.",
    );
  });

  it("returns the deterministic result when the model content is not valid JSON", async () => {
    const fetchFn = stubFetch(() => jsonResponse({ choices: [{ message: { content: "not json at all" } }] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 and the fix",
      projects: PROJECTS,
      router: { status: "ready", config: { ...READY_CONFIG, apiStyle: "openai-chat" } },
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(result.warnings.at(-1)).toBe(
      "AI parse fallback failed (invalid_json); showing the deterministic result.",
    );
  });

  it("rejects a payload that does not match the response schema", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: "BIT-2", ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 and the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1"]);
    expect(result.warnings.at(-1)).toBe(
      "AI parse fallback failed (invalid_shape); showing the deterministic result.",
    );
  });

  it("rejects a code that does not match the strict code format", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: ["BIT-1; DROP"], ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(result.items).toEqual([]);
  });

  it("ignores keys the model invented and never emits items for them", async () => {
    const fetchFn = stubFetch(() =>
      runWrapper({
        codes: ["FAKE-3", "BIT-4"],
        ranges: [{ key: "GHOST", from: 1, to: 2 }],
      }),
    );

    const result = await parseWorkQueuePromptWithFallback({
      text: "the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("applied");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-4"]);
    expect(result.unknownKeys.map((unknown) => unknown.key)).toEqual(["FAKE", "GHOST"]);
    expect(result.warnings).toContain("AI suggested unknown project key(s) FAKE, GHOST; ignored.");
  });

  it("keeps the item cap from the core parser for model ranges", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: [], ranges: [{ key: "BIT", from: 1, to: 500 }] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.items).toHaveLength(50);
    expect(result.warnings.some((warning) => warning.includes("truncated"))).toBe(true);
  });

  it("returns the deterministic result when the request times out", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
        }),
    );

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 and the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
      timeoutMs: 5,
    });

    expect(result.fallback).toBe("failed");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1"]);
    expect(result.warnings).toContain("AI parse fallback failed (timeout); showing the deterministic result.");
  });

  it("stops early when the caller aborts the request", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => { reject(new Error("aborted")); }, { once: true });
          controller.abort();
        }),
    );

    const result = await parseWorkQueuePromptWithFallback({
      text: "the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
      signal: controller.signal,
    });

    expect(result.fallback).toBe("failed");
    expect(result.warnings.at(-1)).toContain("(aborted)");
  });

  it("reports only the status code when the endpoint returns an error", async () => {
    const fetchFn = stubFetch(() => new Response(`bad token ${API_TOKEN}`, { status: 401 }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "the fix",
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(result.warnings.at(-1)).toBe("AI parse fallback failed (http_error); showing the deterministic result.");
    expect(result.warnings.join("\n")).not.toContain(API_TOKEN);
  });

  it("skips the router with a warning when it is disabled", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: ["BIT-9"], ranges: [] }));
    const router = await resolveWorkQueueRouterState(
      {
        enabled: false,
        baseUrl: BASE_URL,
        model: MODEL,
        apiStyle: "cloudflare-run",
        encryptedApiToken: null,
        tokenIv: null,
      },
      ENCRYPTION_KEY,
    );

    const result = await parseWorkQueuePromptWithFallback({
      text: "BIT-1 and the fix",
      projects: PROJECTS,
      router,
      fetchFn,
    });

    expect(router.status).toBe("unavailable");
    expect(result.fallback).toBe("router_unavailable");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["BIT-1"]);
    expect(result.warnings).toContain(
      "AI parse fallback skipped (router disabled or not configured); showing the deterministic result.",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("refuses prompts longer than the fallback limit without calling the router", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: [], ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: `BIT-1 ${"x".repeat(WORK_QUEUE_PROMPT_MAX_CHARS)}`,
      projects: PROJECTS,
      router: READY,
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not call a cloudflare-clef endpoint for free-text parsing", async () => {
    const fetchFn = stubFetch(() => runWrapper({ codes: [], ranges: [] }));

    const result = await parseWorkQueuePromptWithFallback({
      text: "the fix",
      projects: PROJECTS,
      router: { status: "ready", config: { ...READY_CONFIG, apiStyle: "cloudflare-clef" } },
      fetchFn,
    });

    expect(result.fallback).toBe("failed");
    expect(result.warnings.at(-1)).toContain("unsupported_api_style");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("uses the chat-completions endpoint and response shape for openai-style routers", async () => {
    const fetchFn = stubFetch(() =>
      jsonResponse({
        choices: [{ message: { content: '```json\n{"codes":["WEB-2"],"ranges":[]}\n```' } }],
      }),
    );

    const result = await parseWorkQueuePromptWithFallback({
      text: "the homepage",
      projects: PROJECTS,
      router: {
        status: "ready",
        config: { baseUrl: OPENAI_BASE_URL, model: MODEL, apiToken: API_TOKEN, apiStyle: "openai-chat" },
      },
      fetchFn,
    });

    expect(result.fallback).toBe("applied");
    expect(result.items.map((item) => `${item.key}-${String(item.number)}`)).toEqual(["WEB-2"]);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${OPENAI_BASE_URL}/chat/completions`);
  });
});

describe("resolveWorkQueueRouterState", () => {
  it("decrypts the stored token into a ready config", async () => {
    const encrypted = await encryptT3Token(API_TOKEN, ENCRYPTION_KEY);

    const state = await resolveWorkQueueRouterState(
      {
        enabled: true,
        baseUrl: BASE_URL,
        model: MODEL,
        apiStyle: "cloudflare-run",
        encryptedApiToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
      },
      ENCRYPTION_KEY,
    );

    expect(state).toEqual({ status: "ready", config: READY_CONFIG });
  });

  it("reports an unreadable token without exposing key material", async () => {
    const encrypted = await encryptT3Token(API_TOKEN, ENCRYPTION_KEY);

    const state = await resolveWorkQueueRouterState(
      {
        enabled: true,
        baseUrl: BASE_URL,
        model: MODEL,
        apiStyle: "cloudflare-run",
        encryptedApiToken: encrypted.ciphertext,
        tokenIv: encrypted.iv,
      },
      "a-different-secret",
    );

    expect(state).toEqual({ status: "unavailable", reason: "stored token could not be read" });
  });

  it("treats a missing settings row as not configured", async () => {
    const state = await resolveWorkQueueRouterState(undefined, ENCRYPTION_KEY);

    expect(state).toEqual({ status: "unavailable", reason: "router disabled or not configured" });
  });
});
