import { describe, expect, it } from "vitest";
import type { RunLevel } from "@bitig/core";
import {
  HttpRunProfileRouter,
  buildAiRouterEndpointUrl,
  buildClefRequest,
  resolveClefModelSelector,
  testAiRouterEndpoint,
  validateClefResponse,
} from "../src/t3/router";

const CF_BASE = "https://api.cloudflare.com/client/v4/accounts/8423a8bddcba5f61bc5f599e64bbdd62/ai/run";
const CLEF_MODEL = "@cf/cloudflare/clef";
const TOKEN = "clef-secret-token-4321";

const LEVELS: readonly RunLevel[] = [
  { key: "cheap", label: "Cheap", description: "Small, well-scoped edits", order: 0 },
  { key: "standard", label: "Standard", description: "Everyday feature work", order: 1 },
  { key: "strong", label: "Strong", description: "Complex architecture", order: 2 },
];

const TASK = { title: "Fix typo in README", description: "Update README.md", labels: ["docs"] };

const EFFORTS_BY_LEVEL = {
  cheap: ["low", "medium"],
  standard: ["low", "medium", "high"],
  strong: ["medium", "high"],
};

function clefAnswer(overrides: {
  level?: unknown;
  confidence?: unknown;
  effort?: unknown;
  probabilities?: unknown;
}): Record<string, unknown> {
  const levelChoice = overrides.level ?? "standard";
  return {
    model: "clef",
    answers: {
      level: {
        type: "choice",
        choice: levelChoice,
        probabilities: overrides.probabilities ?? { cheap: 0.1, standard: 0.82, strong: 0.08 },
        confidence: overrides.confidence ?? 0.82,
      },
      ...(overrides.effort !== undefined
        ? {
            effort: {
              type: "choice",
              choice: overrides.effort,
              probabilities: { low: 0.2, medium: 0.7, high: 0.1 },
              confidence: 0.7,
            },
          }
        : {}),
    },
    usage: { input_tokens: 120, output_tokens: 4 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeRouter(fetchFn: typeof fetch, model = CLEF_MODEL): HttpRunProfileRouter {
  return new HttpRunProfileRouter({
    baseUrl: CF_BASE,
    model,
    apiToken: TOKEN,
    apiStyle: "cloudflare-clef",
    fetchFn,
  });
}

describe("Clef router style (#BIT-210)", () => {
  it("resolves the model selector from the configured model id", () => {
    expect(resolveClefModelSelector("@cf/cloudflare/clef")).toBe("clef");
    expect(resolveClefModelSelector(" @cf/cloudflare/clef-flash ")).toBe("clef-flash");
    expect(resolveClefModelSelector("clef")).toBe("clef");
    expect(resolveClefModelSelector("@cf/meta/llama-3.1-8b-instruct")).toBeUndefined();
    expect(resolveClefModelSelector("@cf/cloudflare/clef-pro")).toBeUndefined();
  });

  it("builds the same endpoint URL as cloudflare-run", () => {
    expect(buildAiRouterEndpointUrl(CF_BASE, CLEF_MODEL, "cloudflare-clef")).toBe(
      `${CF_BASE}/${CLEF_MODEL}`,
    );
  });

  it("builds model, state and choice questions from the organisation's levels", () => {
    const built = buildClefRequest(
      TASK,
      { levels: LEVELS, effortValuesByLevel: EFFORTS_BY_LEVEL, serialPaths: ["packages/storage-d1/migrations/**"] },
      "clef",
    );
    expect(built).not.toBeNull();
    expect(built?.body.model).toBe("clef");
    expect(built?.body.state).toMatchObject({
      title: "Fix typo in README",
      labels: ["docs"],
      serialPaths: ["packages/storage-d1/migrations/**"],
    });
    expect(built?.body.questions).toEqual({
      level: {
        type: "choice",
        instructions: expect.any(String) as string,
        criteria: {
          cheap: "Cheap: Small, well-scoped edits",
          standard: "Standard: Everyday feature work",
          strong: "Strong: Complex architecture",
        },
      },
      effort: {
        type: "choice",
        instructions: expect.any(String) as string,
        criteria: {
          low: expect.any(String) as string,
          medium: expect.any(String) as string,
          high: expect.any(String) as string,
        },
      },
    });
    // The body must not name the models mapped to levels.
    expect(JSON.stringify(built?.body)).not.toContain("claude");
  });

  it("omits the effort question when fewer than two efforts exist and rejects fewer than two levels", () => {
    const oneEffort = buildClefRequest(
      TASK,
      { levels: LEVELS, effortValuesByLevel: { cheap: ["low"], standard: ["low"], strong: ["low"] } },
      "clef",
    );
    expect(Object.keys(oneEffort?.body.questions ?? {})).toEqual(["level"]);

    const first = LEVELS[0];
    expect(first).toBeDefined();
    expect(buildClefRequest(TASK, { levels: first ? [first] : [] }, "clef")).toBeNull();
  });

  describe("validateClefResponse", () => {
    const built = buildClefRequest(
      TASK,
      { levels: LEVELS, effortValuesByLevel: EFFORTS_BY_LEVEL },
      "clef",
    );

    function validate(raw: unknown, minConfidence?: number) {
      if (!built) throw new Error("expected a built Clef request");
      return validateClefResponse(raw, built, minConfidence);
    }

    it("maps the level and effort answers to a suggestion without touches or parallelism", () => {
      expect(validate(clefAnswer({ effort: "medium" }))).toEqual({
        ok: true,
        suggestion: {
          level: "standard",
          effort: "medium",
          touches: [],
          parallelSafe: false,
          reason: 'Router chose "standard" (82% probability), effort medium',
          confidence: 0.82,
        },
      });
    });

    it("accepts the Cloudflare REST envelope and case-insensitive level keys", () => {
      const outcome = validate({ success: true, result: clefAnswer({ level: " Standard " }) });
      expect(outcome).toMatchObject({ ok: true, suggestion: { level: "standard" } });
    });

    it("drops an effort the chosen level does not offer instead of rejecting the suggestion", () => {
      // "strong" offers only medium and high.
      const outcome = validate(
        clefAnswer({
          level: "strong",
          effort: "low",
          probabilities: { cheap: 0.05, standard: 0.05, strong: 0.9 },
          confidence: 0.9,
        }),
      );
      expect(outcome).toMatchObject({ ok: true, suggestion: { level: "strong" } });
      expect(outcome.ok && outcome.suggestion.effort).toBeUndefined();
    });

    it("reports low confidence below the minimum", () => {
      expect(validate(clefAnswer({ confidence: 0.3 }))).toEqual({
        ok: false,
        failure: { reason: "low_confidence", confidence: 0.3 },
      });
      expect(validate(clefAnswer({ confidence: 0.3 }), 0)).toMatchObject({ ok: true });
    });

    it("rejects an unknown level, a non-string level and an invalid confidence", () => {
      expect(validate(clefAnswer({ level: "genius" }))).toEqual({
        ok: false,
        failure: { reason: "validation_failed", field: "level" },
      });
      expect(validate(clefAnswer({ level: 3 }))).toEqual({
        ok: false,
        failure: { reason: "validation_failed", field: "level" },
      });
      expect(validate(clefAnswer({ confidence: 85 }))).toEqual({
        ok: false,
        failure: { reason: "validation_failed", field: "confidence" },
      });
    });

    it("rejects malformed and failed responses", () => {
      for (const raw of [
        null,
        "text",
        [],
        { success: false, result: {} },
        { model: "clef", answers: "nope" },
        { model: "clef", answers: {} },
        { model: "clef", answers: { level: { type: "noul", noul: 0.9 } } },
      ]) {
        expect(validate(raw)).toEqual({ ok: false, failure: { reason: "bad_response_shape" } });
      }
    });
  });

  describe("HttpRunProfileRouter with cloudflare-clef", () => {
    it("posts { model, state, questions } and returns the suggestion", async () => {
      const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
      const router = makeRouter(async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: req.url,
          auth: req.headers.get("Authorization"),
          body: JSON.parse(await req.text()) as Record<string, unknown>,
        });
        return jsonResponse({ success: true, result: clefAnswer({ effort: "high" }), errors: [] });
      });

      const outcome = await router.suggest(TASK, { levels: LEVELS, effortValuesByLevel: EFFORTS_BY_LEVEL });
      expect(outcome).toMatchObject({
        ok: true,
        suggestion: { level: "standard", effort: "high", touches: [], parallelSafe: false },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`${CF_BASE}/${CLEF_MODEL}`);
      expect(calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
      expect(Object.keys(calls[0]?.body ?? {}).sort()).toEqual(["model", "questions", "state"]);
      expect(calls[0]?.body.model).toBe("clef");
    });

    it("rejects a model that is not clef without calling the endpoint", async () => {
      let called = false;
      const router = makeRouter(() => {
        called = true;
        return Promise.resolve(jsonResponse({}));
      }, "@cf/meta/llama-3.1-8b-instruct");
      expect(await router.suggest(TASK, { levels: LEVELS })).toEqual({
        ok: false,
        failure: { reason: "invalid_endpoint" },
      });
      expect(called).toBe(false);
    });

    it("needs at least two levels", async () => {
      const first = LEVELS[0];
      const router = makeRouter(() => Promise.resolve(jsonResponse({})));
      expect(await router.suggest(TASK, { levels: first ? [first] : [] })).toEqual({
        ok: false,
        failure: { reason: "no_run_levels" },
      });
    });

    it("reports HTTP errors with a truncated, token-redacted detail for logs", async () => {
      const longBody = `AiError: Bad input ${TOKEN} ${"x".repeat(1000)}`;
      const router = makeRouter(() => Promise.resolve(new Response(longBody, { status: 400 })));
      const outcome = await router.suggest(TASK, { levels: LEVELS });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.failure.reason).toBe("http_error");
      if (outcome.failure.reason !== "http_error") return;
      expect(outcome.failure.status).toBe(400);
      expect(outcome.failure.detail).toContain("AiError: Bad input [REDACTED]");
      expect(outcome.failure.detail).not.toContain(TOKEN);
      expect(outcome.failure.detail?.length).toBeLessThanOrEqual(300);
    });

    it("omits the detail when the error body is empty", async () => {
      const router = makeRouter(() => Promise.resolve(new Response("", { status: 502 })));
      expect(await router.suggest(TASK, { levels: LEVELS })).toEqual({
        ok: false,
        failure: { reason: "http_error", status: 502 },
      });
    });

    it("reports a non-JSON success body as a bad response shape", async () => {
      const router = makeRouter(() => Promise.resolve(new Response("not json", { status: 200 })));
      expect(await router.suggest(TASK, { levels: LEVELS })).toEqual({
        ok: false,
        failure: { reason: "bad_response_shape" },
      });
    });
  });

  describe("testAiRouterEndpoint with cloudflare-clef", () => {
    it("succeeds against a Clef response even when its confidence is low", async () => {
      const result = await testAiRouterEndpoint({
        baseUrl: CF_BASE,
        model: CLEF_MODEL,
        apiToken: TOKEN,
        apiStyle: "cloudflare-clef",
        levels: LEVELS,
        effortValuesByLevel: EFFORTS_BY_LEVEL,
        fetchFn: () =>
          Promise.resolve(jsonResponse({ success: true, result: clefAnswer({ confidence: 0.2 }) })),
      });
      expect(result.ok).toBe(true);
      expect(result.suggestion?.level).toBe("standard");
    });

    it("surfaces the endpoint's HTTP error without leaking the token", async () => {
      const result = await testAiRouterEndpoint({
        baseUrl: CF_BASE,
        model: CLEF_MODEL,
        apiToken: TOKEN,
        apiStyle: "cloudflare-clef",
        levels: LEVELS,
        fetchFn: () => Promise.resolve(new Response(`bad input ${TOKEN}`, { status: 400 })),
      });
      expect(result).toMatchObject({ ok: false, status: 400 });
      expect(result.error).toContain("HTTP 400");
      expect(result.error).not.toContain(TOKEN);
    });

    it("explains a model that is not clef", async () => {
      const result = await testAiRouterEndpoint({
        baseUrl: CF_BASE,
        model: "@cf/meta/llama-3.1-8b-instruct",
        apiToken: TOKEN,
        apiStyle: "cloudflare-clef",
        levels: LEVELS,
        fetchFn: () => Promise.resolve(jsonResponse({})),
      });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("@cf/cloudflare/clef");
    });
  });
});
