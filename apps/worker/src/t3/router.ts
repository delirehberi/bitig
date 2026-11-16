import {
  AI_ROUTER_BASE_URL_MAX,
  AI_ROUTER_MODEL_MAX,
  AiRouterApiStyleSchema,
  RunProfileConfidenceSchema,
  RunProfileEffortSchema,
  RunProfileReasonSchema,
  RunProfileTouchesSchema,
  ValidationError,
  parseOrThrow,
  sortRunLevels,
  type AiRouterApiStyle,
  type OrgAiRouterSettings,
  type RunLevel,
  type RunLevelKey,
  type T3ModelCapability,
} from "@bitig/core";

export const DEFAULT_ROUTER_TIMEOUT_MS = 15_000;
export const DEFAULT_ROUTER_MIN_CONFIDENCE = 0.5;
export const DEFAULT_ROUTER_EFFORT_VALUES = ["low", "medium", "high"] as const;

export const DEFAULT_REPO_MAP = [
  "apps/cli",
  "apps/web",
  "apps/worker",
  "packages/core",
  "packages/mcp-server",
  "packages/mcp-tools",
  "packages/storage-api",
  "packages/storage-d1",
  "packages/storage-fs",
  "packages/storage-md",
] as const;

/** Model selectors accepted by the Clef decision-model API (`@cf/cloudflare/clef[-flash]`, #BIT-210). */
export const CLEF_MODEL_SELECTORS = ["clef", "clef-flash"] as const;
type ClefModelSelector = (typeof CLEF_MODEL_SELECTORS)[number];

/** Question ids sent to Clef; answers come back under the same ids. */
const CLEF_LEVEL_QUESTION_ID = "level";
const CLEF_EFFORT_QUESTION_ID = "effort";
/** Clef `choice` questions need at least two options. */
const CLEF_MIN_CHOICE_OPTIONS = 2;
const CLEF_LEVEL_INSTRUCTIONS =
  "Choose the organisation run level that best fits the software engineering task described in the state. Prefer the cheapest level that can complete the task reliably.";
const CLEF_EFFORT_INSTRUCTIONS =
  "Choose how much reasoning effort the software engineering task described in the state needs.";
const CLEF_EFFORT_DESCRIPTIONS: Readonly<Record<string, string>> = {
  low: "Simple, well-scoped work that needs little reasoning.",
  medium: "Typical work with some ambiguity or several moving parts.",
  high: "Hard, ambiguous or risky work that needs deep reasoning.",
};
const PERCENT = 100;
/** Maximum characters of an error response body kept in the `http_error` log detail. */
const HTTP_ERROR_DETAIL_MAX = 300;

export interface RunProfileSuggestion {
  readonly level: RunLevelKey;
  readonly effort?: string | undefined;
  readonly touches: string[];
  readonly parallelSafe: boolean;
  readonly reason: string;
  readonly confidence: number;
}

export interface RunProfileRouterTaskInput {
  readonly title: string;
  readonly description?: string | undefined;
  readonly checklist?: readonly { readonly text: string; readonly done: boolean }[] | null | undefined;
  readonly labels?: readonly string[] | null | undefined;
}

export interface RunProfileRouterContext {
  readonly levels: readonly RunLevel[];
  /**
   * Optional per-level allowed effort values offered by the level's mapped model.
   * When omitted for a level, defaults to `DEFAULT_ROUTER_EFFORT_VALUES` (`["low", "medium", "high"]`)
   * plus any string effort option configured on that level's model selection.
   */
  readonly effortValuesByLevel?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly serialPaths?: readonly string[] | undefined;
  readonly repoMap?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Why the router produced no suggestion (#BIT-208). Carries only the classification and small
 * non-sensitive values (HTTP status, failing field, confidence); never tokens. `http_error.detail`
 * is a truncated, token-redacted response body for server logs only (#BIT-210); the service strips
 * it before the failure is returned to clients.
 */
export type RunProfileSuggestionFailure =
  | { readonly reason: "router_disabled" }
  | { readonly reason: "not_configured" }
  | { readonly reason: "no_token" }
  | { readonly reason: "decrypt_failed" }
  | { readonly reason: "store_unavailable" }
  | { readonly reason: "invalid_endpoint" }
  | { readonly reason: "no_run_levels" }
  | { readonly reason: "http_error"; readonly status: number; readonly detail?: string }
  | { readonly reason: "timeout" }
  | { readonly reason: "aborted" }
  | { readonly reason: "network_error" }
  | { readonly reason: "bad_response_shape" }
  | { readonly reason: "validation_failed"; readonly field: string }
  | { readonly reason: "low_confidence"; readonly confidence: number };

export type RunProfileSuggestionOutcome =
  | { readonly ok: true; readonly suggestion: RunProfileSuggestion }
  | { readonly ok: false; readonly failure: RunProfileSuggestionFailure };

/**
 * Pluggable task run profile router (#BIT-187).
 * Another decider (e.g. an ACP decision model reached through T3) can replace the HTTP router later.
 */
export interface RunProfileRouter {
  suggest(
    task: RunProfileRouterTaskInput,
    context: RunProfileRouterContext,
  ): Promise<RunProfileSuggestionOutcome>;
}

function failed(failure: RunProfileSuggestionFailure): RunProfileSuggestionOutcome {
  return { ok: false, failure };
}

export interface PublicOrgAiRouterSettings {
  readonly orgId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly apiStyle: AiRouterApiStyle;
  readonly hasToken: boolean;
  readonly tokenStatus: "set" | "not set";
  readonly tokenLast4?: string | undefined;
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly updatedBy?: string | undefined;
  readonly updatedAt?: string | undefined;
}

export function formatOrgAiRouterSettingsResponse(
  settings: OrgAiRouterSettings | undefined,
  orgId: string,
): PublicOrgAiRouterSettings {
  if (!settings) {
    return {
      orgId,
      baseUrl: "",
      model: "",
      apiStyle: "cloudflare-run",
      hasToken: false,
      tokenStatus: "not set",
      enabled: false,
      configured: false,
    };
  }
  const hasToken = settings.hasToken;
  const configured =
    settings.enabled &&
    settings.baseUrl.trim().length > 0 &&
    settings.model.trim().length > 0 &&
    hasToken;
  return {
    orgId: settings.orgId,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiStyle: settings.apiStyle,
    hasToken,
    tokenStatus: hasToken ? "set" : "not set",
    ...(hasToken && settings.tokenLast4 ? { tokenLast4: settings.tokenLast4 } : {}),
    enabled: settings.enabled,
    configured,
    ...(settings.updatedBy ? { updatedBy: settings.updatedBy } : {}),
    ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {}),
  };
}

function makeRouterValidationError(path: string, message: string, input?: unknown): never {
  throw new ValidationError("aiRouter", [
    {
      code: "custom",
      path: [path],
      message,
      ...(input !== undefined ? { input } : {}),
    },
  ]);
}

function isPrivateOrReservedIpv4Octets(a: number, b: number, c: number, d: number): boolean {
  if (
    !Number.isInteger(a) ||
    !Number.isInteger(b) ||
    !Number.isInteger(c) ||
    !Number.isInteger(d) ||
    a < 0 ||
    a > 255 ||
    b < 0 ||
    b > 255 ||
    c < 0 ||
    c > 255 ||
    d < 0 ||
    d > 255
  ) {
    return true;
  }
  // 0.0.0.0/8 (unspecified / current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (private RFC 1918)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-Grade NAT RFC 6598 / Tailscale)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (link-local / cloud metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (private RFC 1918)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 and 192.0.2.0/24 (IETF / TEST-NET-1)
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  // 192.168.0.0/16 (private RFC 1918)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (benchmarking) and 198.51.100.0/24 (TEST-NET-2)
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  // 203.0.113.0/24 (TEST-NET-3)
  if (a === 203 && b === 0 && c === 113) return true;
  // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved / broadcast)
  if (a >= 224) return true;
  return false;
}

export function isPrivateOrLoopbackHost(rawHostname: string): boolean {
  const host = rawHostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
  if (!host) return true;

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".localdomain") ||
    host.endsWith(".lan") ||
    host.endsWith(".corp") ||
    host.endsWith(".intranet")
  ) {
    return true;
  }

  // IPv6 literal
  if (host.includes(":")) {
    const normalized = host.split("%")[0] ?? host;
    if (
      normalized === "::1" ||
      normalized === "::" ||
      normalized === "0:0:0:0:0:0:0:1" ||
      normalized === "0:0:0:0:0:0:0:0"
    ) {
      return true;
    }
    // Unique local fc00::/7 (fc.. or fd..), link-local fe80::/10 (fe8.. - feb..), multicast ff00::/8
    if (/^(?:fc|fd|fe[89ab]|ff)[0-9a-f]{0,2}:/i.test(normalized)) {
      return true;
    }
    // IPv4-mapped IPv6 ::ffff:a.b.c.d or ::ffff:xxxx:yyyy
    if (normalized.startsWith("::ffff:")) {
      const suffix = normalized.slice("::ffff:".length);
      const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(suffix);
      if (dotted) {
        return isPrivateOrReservedIpv4Octets(
          Number(dotted[1]),
          Number(dotted[2]),
          Number(dotted[3]),
          Number(dotted[4]),
        );
      }
      const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(suffix);
      if (hexPair?.[1] && hexPair[2]) {
        const high = Number.parseInt(hexPair[1], 16);
        const low = Number.parseInt(hexPair[2], 16);
        return isPrivateOrReservedIpv4Octets(
          (high >> 8) & 0xff,
          high & 0xff,
          (low >> 8) & 0xff,
          low & 0xff,
        );
      }
      return true;
    }
    return false;
  }

  // IPv4 literal
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4Match) {
    return isPrivateOrReservedIpv4Octets(
      Number(ipv4Match[1]),
      Number(ipv4Match[2]),
      Number(ipv4Match[3]),
      Number(ipv4Match[4]),
    );
  }

  // Reject single-label hostnames (e.g. "metadata", "redis") or numeric TLDs
  if (!host.includes(".") || /\.\d+$/.test(host)) {
    return true;
  }

  return false;
}

/**
 * Validates an organisation AI router `baseUrl`:
 * - Must be a valid `https://` URL within `AI_ROUTER_BASE_URL_MAX`.
 * - Must not include credentials, query strings, or fragments.
 * - Must not point to a loopback, private, link-local, or internal host.
 */
export function validateAiRouterBaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    makeRouterValidationError("baseUrl", "AI router baseUrl is required.", rawUrl);
  }
  if (trimmed.length > AI_ROUTER_BASE_URL_MAX) {
    makeRouterValidationError(
      "baseUrl",
      `AI router baseUrl must be at most ${String(AI_ROUTER_BASE_URL_MAX)} characters.`,
      rawUrl,
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    makeRouterValidationError("baseUrl", "AI router baseUrl must be a valid URL.", rawUrl);
  }

  if (parsed.protocol !== "https:") {
    makeRouterValidationError("baseUrl", "AI router baseUrl must use https://.", rawUrl);
  }
  if (parsed.username || parsed.password) {
    makeRouterValidationError(
      "baseUrl",
      "AI router baseUrl must not contain embedded credentials.",
      rawUrl,
    );
  }
  if (parsed.search || parsed.hash) {
    makeRouterValidationError(
      "baseUrl",
      "AI router baseUrl must not contain query parameters or fragments.",
      rawUrl,
    );
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    makeRouterValidationError(
      "baseUrl",
      "AI router baseUrl must not point to a private, loopback, or internal host.",
      rawUrl,
    );
  }

  return trimmed.replace(/\/+$/, "");
}

/**
 * Validates an organisation AI router `model` identifier.
 * Preserves `@` and `/` (e.g. `@cf/cloudflare/clef`) while rejecting path traversal or query characters.
 */
export function validateAiRouterModel(rawModel: string): string {
  const trimmed = rawModel.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed) {
    makeRouterValidationError("model", "AI router model is required.", rawModel);
  }
  if (trimmed.length > AI_ROUTER_MODEL_MAX) {
    makeRouterValidationError(
      "model",
      `AI router model must be at most ${String(AI_ROUTER_MODEL_MAX)} characters.`,
      rawModel,
    );
  }
  if (/[\s?#\\]/.test(trimmed)) {
    makeRouterValidationError(
      "model",
      "AI router model must not contain whitespace, '?', '#', or backslashes.",
      rawModel,
    );
  }
  const segments = trimmed.split("/");
  if (segments.some((seg) => seg.length === 0 || seg === "." || seg === "..")) {
    makeRouterValidationError(
      "model",
      "AI router model must not contain empty or '..' path segments.",
      rawModel,
    );
  }
  return trimmed;
}

/**
 * Builds the target URL for an AI router call:
 * - `cloudflare-run` / `cloudflare-clef`: appends `<baseUrl>/<model>` directly so `@` and `/` in the model ID are preserved in the URL path.
 * - `openai` / `openai-chat`: appends `/chat/completions` to `<baseUrl>` (unless already ending with `/chat/completions`).
 */
export function buildAiRouterEndpointUrl(
  baseUrl: string,
  model: string,
  apiStyle: AiRouterApiStyle = "cloudflare-run",
): string {
  const validatedBase = validateAiRouterBaseUrl(baseUrl);
  const validatedModel = validateAiRouterModel(model);
  const style = parseOrThrow(AiRouterApiStyleSchema, apiStyle, "buildAiRouterEndpointUrl apiStyle");

  if (style === "cloudflare-run" || style === "cloudflare-clef") {
    return `${validatedBase}/${validatedModel}`;
  }

  if (validatedBase.endsWith("/chat/completions")) {
    return validatedBase;
  }
  return `${validatedBase}/chat/completions`;
}

/**
 * Derives allowed effort values per level from the organisation's levels and optional T3 model capabilities.
 */
export function buildEffortValuesByLevel(
  levels: Iterable<RunLevel>,
  capabilities?: readonly T3ModelCapability[],
): Record<string, readonly string[]> {
  const result: Record<string, readonly string[]> = {};
  for (const level of levels) {
    const sel = level.selection;
    let efforts: string[] | undefined;

    if (sel && capabilities && capabilities.length > 0) {
      const cap = capabilities.find(
        (c) =>
          c.providerInstanceId === sel.providerInstanceId.trim() &&
          c.model === sel.model.trim(),
      );
      const effortOpt = cap?.options?.find(
        (opt) =>
          opt.id === "effort" || opt.id === "reasoningEffort" || opt.id === "thinkingEffort",
      );
      if (effortOpt && effortOpt.values.length > 0) {
        const stringVals = effortOpt.values.filter((v): v is string => typeof v === "string");
        if (stringVals.length > 0) {
          efforts = [...new Set(stringVals)];
        }
      }
    }

    if (!efforts) {
      const configuredEffort = sel?.options?.find(
        (opt) =>
          (opt.id === "effort" || opt.id === "reasoningEffort" || opt.id === "thinkingEffort") &&
          typeof opt.value === "string",
      );
      const base = [...DEFAULT_ROUTER_EFFORT_VALUES];
      if (
        configuredEffort &&
        typeof configuredEffort.value === "string" &&
        !base.includes(configuredEffort.value as (typeof DEFAULT_ROUTER_EFFORT_VALUES)[number])
      ) {
        base.push(configuredEffort.value as (typeof DEFAULT_ROUTER_EFFORT_VALUES)[number]);
      }
      efforts = base;
    }

    result[level.key] = efforts;
  }
  return result;
}

export interface BuiltRouterRequest {
  readonly messages: readonly [
    { readonly role: "system"; readonly content: string },
    { readonly role: "user"; readonly content: string },
  ];
  readonly jsonSchema: {
    readonly type: "object";
    readonly properties: Record<string, unknown>;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
  readonly allowedLevels: ReadonlySet<string>;
  readonly allowedEffortsByLevel: ReadonlyMap<string, ReadonlySet<string>>;
}

/** The non-sensitive task fields sent to any router: never comments, attachments, secrets or model names. */
function sanitizeRouterState(task: RunProfileRouterTaskInput, context: RunProfileRouterContext) {
  return {
    title: task.title.trim(),
    description: (task.description ?? "").trim(),
    checklist: (task.checklist ?? []).map((item) => ({
      text: item.text,
      done: item.done,
    })),
    labels: [...(task.labels ?? [])],
    serialPaths: [...(context.serialPaths ?? [])],
    repoMap: [...(context.repoMap ?? DEFAULT_REPO_MAP)],
  };
}

/**
 * Generates the router messages and JSON schema from the organisation's ordered run levels
 * and the task's non-sensitive fields (`title`, `description`, `checklist`, `labels`,
 * project `serialPaths`, and top-level `repoMap`).
 *
 * Never includes comments, attachments, secrets, or model names.
 */
export function buildRouterRequest(
  task: RunProfileRouterTaskInput,
  context: RunProfileRouterContext,
): BuiltRouterRequest | null {
  const sortedLevels = sortRunLevels(context.levels);
  if (sortedLevels.length === 0) {
    return null;
  }

  const levelKeys = sortedLevels.map((l) => l.key);
  const allowedLevels = new Set<string>(levelKeys);
  const allowedEffortsByLevel = new Map<string, ReadonlySet<string>>();
  const allEffortValues: string[] = [];

  for (const level of sortedLevels) {
    const explicitEfforts = context.effortValuesByLevel?.[level.key];
    let levelEfforts: readonly string[];
    if (explicitEfforts !== undefined) {
      levelEfforts = explicitEfforts.map((v) => v.trim()).filter(Boolean);
    } else {
      const configuredOpt = level.selection?.options?.find(
        (opt) =>
          (opt.id === "effort" || opt.id === "reasoningEffort" || opt.id === "thinkingEffort") &&
          typeof opt.value === "string",
      );
      const list: string[] = [...DEFAULT_ROUTER_EFFORT_VALUES];
      if (
        configuredOpt &&
        typeof configuredOpt.value === "string" &&
        configuredOpt.value.trim() &&
        !list.includes(configuredOpt.value.trim())
      ) {
        list.push(configuredOpt.value.trim());
      }
      levelEfforts = list;
    }
    allowedEffortsByLevel.set(level.key, new Set(levelEfforts));
    for (const val of levelEfforts) {
      if (!allEffortValues.includes(val)) {
        allEffortValues.push(val);
      }
    }
  }

  const rubricLines = sortedLevels.map((level, index) => {
    const efforts = [...(allowedEffortsByLevel.get(level.key) ?? [])];
    const effortNote =
      efforts.length > 0 ? ` (supported effort values: ${efforts.join(", ")})` : "";
    return `${String(index + 1)}. "${level.key}" — ${level.label}: ${level.description}${effortNote}`;
  });

  const systemPrompt = [
    "You are a task run-profile router. Given a software engineering task, the project's serial paths, and the repository's top-level packages, suggest:",
    "- `level`: which organisation run level key best fits the task.",
    "- `effort`: optional effort value supported by that level.",
    "- `touches`: relative repository path globs the task is expected to modify.",
    "- `parallelSafe`: whether the task can safely run in parallel alongside sibling tasks when touched paths do not overlap (`false` if it touches serial paths, global config, migrations, or wide cross-cutting state).",
    "- `reason`: a concise 1-2 sentence explanation for the level and touched paths (never name a specific AI model).",
    "- `confidence`: a number between 0 and 1 indicating confidence in this classification.",
    "",
    "Organisation Run Levels (in order):",
    ...rubricLines,
    "",
    "Respond strictly with JSON matching the provided JSON schema.",
  ].join("\n");

  const sanitizedInput = sanitizeRouterState(task, context);

  const properties: Record<string, unknown> = {
    level: {
      type: "string",
      enum: levelKeys,
      description: "The chosen organisation run level key.",
    },
    ...(allEffortValues.length > 0
      ? {
          effort: {
            type: "string",
            enum: allEffortValues,
            description: "Effort level offered by the chosen level.",
          },
        }
      : {}),
    touches: {
      type: "array",
      items: { type: "string" },
      description: "Relative repository path globs the task modifies.",
    },
    parallelSafe: {
      type: "boolean",
      description: "Whether the task is safe to run in parallel when touched paths are disjoint.",
    },
    reason: {
      type: "string",
      description: "Brief explanation for the chosen level and touched paths.",
    },
    confidence: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Confidence in [0, 1].",
    },
  };

  const jsonSchema = {
    type: "object" as const,
    properties,
    required: ["level", "touches", "parallelSafe", "reason", "confidence"] as const,
    additionalProperties: false as const,
  };

  return {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: JSON.stringify(sanitizedInput) },
    ],
    jsonSchema,
    allowedLevels,
    allowedEffortsByLevel,
  };
}

function unwrapJsonString(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fenced ? (fenced[1]?.trim() ?? "") : trimmed;
  return JSON.parse(candidate);
}

function extractRawRouterPayload(body: unknown, apiStyle: AiRouterApiStyle): unknown {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;

  if (apiStyle === "cloudflare-run") {
    if (record.success === false) {
      return undefined;
    }
    const result = record.result;
    if (result && typeof result === "object") {
      const resultObj = result as Record<string, unknown>;
      if ("response" in resultObj && resultObj.response !== undefined) {
        return typeof resultObj.response === "string"
          ? unwrapJsonString(resultObj.response)
          : resultObj.response;
      }
      if ("level" in resultObj) {
        return resultObj;
      }
    }
    if ("response" in record && record.response !== undefined) {
      return typeof record.response === "string"
        ? unwrapJsonString(record.response)
        : record.response;
    }
  }

  // OpenAI / chat/completions format (also supported as fallback)
  if (Array.isArray(record.choices) && record.choices.length > 0) {
    const first = record.choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (typeof content === "string") {
      return unwrapJsonString(content);
    }
    if (content && typeof content === "object") {
      return content;
    }
  }

  // Fallback to result.response if an OpenAI style setting was pointed at a CF wrapper
  if (record.result && typeof record.result === "object") {
    const resultObj = record.result as Record<string, unknown>;
    if ("response" in resultObj && resultObj.response !== undefined) {
      return typeof resultObj.response === "string"
        ? unwrapJsonString(resultObj.response)
        : resultObj.response;
    }
  }

  return undefined;
}

export function validateRouterSuggestionPayload(
  raw: unknown,
  built: BuiltRouterRequest,
  minConfidence = DEFAULT_ROUTER_MIN_CONFIDENCE,
): RunProfileSuggestionOutcome {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return failed({ reason: "bad_response_shape" });
  }
  const obj = raw as Record<string, unknown>;

  // Reject unexpected extra keys. The key itself comes from model output, so it is not echoed.
  const allowedKeys = new Set(["level", "effort", "touches", "parallelSafe", "reason", "confidence"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      return failed({ reason: "validation_failed", field: "unexpectedKey" });
    }
  }

  if (typeof obj.level !== "string") {
    return failed({ reason: "validation_failed", field: "level" });
  }
  const levelKey = obj.level.trim().toLowerCase();
  if (!built.allowedLevels.has(levelKey)) {
    return failed({ reason: "validation_failed", field: "level" });
  }

  let validatedEffort: string | undefined;
  if (obj.effort !== undefined && obj.effort !== null) {
    if (typeof obj.effort !== "string") {
      return failed({ reason: "validation_failed", field: "effort" });
    }
    const parsedEffort = RunProfileEffortSchema.safeParse(obj.effort);
    if (!parsedEffort.success) {
      return failed({ reason: "validation_failed", field: "effort" });
    }
    const allowedEfforts = built.allowedEffortsByLevel.get(levelKey);
    if (!allowedEfforts?.has(parsedEffort.data)) {
      return failed({ reason: "validation_failed", field: "effort" });
    }
    validatedEffort = parsedEffort.data;
  }

  if (!Array.isArray(obj.touches) || !obj.touches.every((item) => typeof item === "string")) {
    return failed({ reason: "validation_failed", field: "touches" });
  }
  const parsedTouches = RunProfileTouchesSchema.safeParse(obj.touches);
  if (!parsedTouches.success) {
    return failed({ reason: "validation_failed", field: "touches" });
  }

  if (typeof obj.parallelSafe !== "boolean") {
    return failed({ reason: "validation_failed", field: "parallelSafe" });
  }

  if (typeof obj.reason !== "string") {
    return failed({ reason: "validation_failed", field: "reason" });
  }
  const parsedReason = RunProfileReasonSchema.safeParse(obj.reason);
  if (!parsedReason.success) {
    return failed({ reason: "validation_failed", field: "reason" });
  }

  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    return failed({ reason: "validation_failed", field: "confidence" });
  }
  const parsedConfidence = RunProfileConfidenceSchema.safeParse(obj.confidence);
  if (!parsedConfidence.success) {
    return failed({ reason: "validation_failed", field: "confidence" });
  }
  if (parsedConfidence.data < minConfidence) {
    return failed({ reason: "low_confidence", confidence: parsedConfidence.data });
  }

  return {
    ok: true,
    suggestion: {
      level: levelKey,
      ...(validatedEffort !== undefined ? { effort: validatedEffort } : {}),
      touches: parsedTouches.data,
      parallelSafe: obj.parallelSafe,
      reason: parsedReason.data,
      confidence: parsedConfidence.data,
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Resolves the Clef `model` selector from a configured model id such as `@cf/cloudflare/clef-flash`. */
export function resolveClefModelSelector(model: string): ClefModelSelector | undefined {
  const lastSegment = model.trim().split("/").pop()?.trim().toLowerCase();
  return CLEF_MODEL_SELECTORS.find((selector) => selector === lastSegment);
}

export interface BuiltClefRequest {
  readonly body: {
    readonly model: ClefModelSelector;
    readonly state: unknown;
    readonly questions: Record<string, unknown>;
  };
  readonly allowedLevels: ReadonlySet<string>;
  readonly allowedEffortsByLevel: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * Builds a request for the Clef decision-model API (#BIT-210). Clef answers typed questions rather
 * than chat prompts, so the level (and, when the levels offer 2+ efforts, the effort) are two
 * `choice` questions over the task state. Returns null when fewer than two levels are configured,
 * because a `choice` question needs at least two options.
 */
export function buildClefRequest(
  task: RunProfileRouterTaskInput,
  context: RunProfileRouterContext,
  selector: ClefModelSelector,
): BuiltClefRequest | null {
  // Reuse the level and per-level effort derivation shared with the chat-style routers.
  const chat = buildRouterRequest(task, context);
  if (!chat || chat.allowedLevels.size < CLEF_MIN_CHOICE_OPTIONS) {
    return null;
  }

  const levelCriteria: Record<string, string> = {};
  for (const level of sortRunLevels(context.levels)) {
    levelCriteria[level.key] = `${level.label}: ${level.description}`;
  }

  const efforts = new Set<string>();
  for (const levelEfforts of chat.allowedEffortsByLevel.values()) {
    for (const effort of levelEfforts) {
      efforts.add(effort);
    }
  }

  const questions: Record<string, unknown> = {
    [CLEF_LEVEL_QUESTION_ID]: {
      type: "choice",
      instructions: CLEF_LEVEL_INSTRUCTIONS,
      criteria: levelCriteria,
    },
  };
  if (efforts.size >= CLEF_MIN_CHOICE_OPTIONS) {
    questions[CLEF_EFFORT_QUESTION_ID] = {
      type: "choice",
      instructions: CLEF_EFFORT_INSTRUCTIONS,
      criteria: Object.fromEntries(
        [...efforts].map((effort) => [effort, CLEF_EFFORT_DESCRIPTIONS[effort] ?? null]),
      ),
    };
  }

  return {
    body: { model: selector, state: sanitizeRouterState(task, context), questions },
    allowedLevels: chat.allowedLevels,
    allowedEffortsByLevel: chat.allowedEffortsByLevel,
  };
}

/**
 * Turns a Clef response (`{ answers: { level: { choice, probabilities, confidence }, effort? } }`,
 * optionally wrapped in the Cloudflare REST envelope `{ success, result }`) into a suggestion.
 * Clef cannot write free text, so `touches` is empty, `parallelSafe` is false and `reason` is
 * generated from the model's own probabilities (never naming a model).
 */
export function validateClefResponse(
  raw: unknown,
  built: BuiltClefRequest,
  minConfidence = DEFAULT_ROUTER_MIN_CONFIDENCE,
): RunProfileSuggestionOutcome {
  if (!isPlainRecord(raw) || raw.success === false) {
    return failed({ reason: "bad_response_shape" });
  }
  const payload = isPlainRecord(raw.result) && "answers" in raw.result ? raw.result : raw;
  const answers = payload.answers;
  if (!isPlainRecord(answers)) {
    return failed({ reason: "bad_response_shape" });
  }

  const levelAnswer = answers[CLEF_LEVEL_QUESTION_ID];
  if (!isPlainRecord(levelAnswer) || levelAnswer.type !== "choice") {
    return failed({ reason: "bad_response_shape" });
  }
  if (typeof levelAnswer.choice !== "string") {
    return failed({ reason: "validation_failed", field: "level" });
  }
  const levelKey = levelAnswer.choice.trim().toLowerCase();
  if (!built.allowedLevels.has(levelKey)) {
    return failed({ reason: "validation_failed", field: "level" });
  }

  const parsedConfidence = RunProfileConfidenceSchema.safeParse(levelAnswer.confidence);
  if (!parsedConfidence.success) {
    return failed({ reason: "validation_failed", field: "confidence" });
  }
  if (parsedConfidence.data < minConfidence) {
    return failed({ reason: "low_confidence", confidence: parsedConfidence.data });
  }

  // An effort the chosen level does not offer is dropped; the level suggestion is still useful.
  let effort: string | undefined;
  const effortAnswer = answers[CLEF_EFFORT_QUESTION_ID];
  if (
    isPlainRecord(effortAnswer) &&
    effortAnswer.type === "choice" &&
    typeof effortAnswer.choice === "string"
  ) {
    const parsedEffort = RunProfileEffortSchema.safeParse(effortAnswer.choice);
    if (parsedEffort.success && built.allowedEffortsByLevel.get(levelKey)?.has(parsedEffort.data)) {
      effort = parsedEffort.data;
    }
  }

  const probabilities = isPlainRecord(levelAnswer.probabilities) ? levelAnswer.probabilities : {};
  const levelProbability = probabilities[levelAnswer.choice] ?? probabilities[levelKey];
  const probability =
    typeof levelProbability === "number" && Number.isFinite(levelProbability)
      ? levelProbability
      : parsedConfidence.data;
  const reasonText = `Router chose "${levelKey}" (${String(Math.round(probability * PERCENT))}% probability)${
    effort !== undefined ? `, effort ${effort}` : ""
  }`;
  const parsedReason = RunProfileReasonSchema.safeParse(reasonText);
  if (!parsedReason.success) {
    return failed({ reason: "validation_failed", field: "reason" });
  }

  return {
    ok: true,
    suggestion: {
      level: levelKey,
      ...(effort !== undefined ? { effort } : {}),
      touches: [],
      parallelSafe: false,
      reason: parsedReason.data,
      confidence: parsedConfidence.data,
    },
  };
}

export interface PreparedRouterRequest {
  readonly body: unknown;
  /** Extracts and validates a suggestion from the endpoint's parsed JSON response. */
  readonly parse: (json: unknown, minConfidence: number) => RunProfileSuggestionOutcome;
}

export type PreparedRouterRequestResult =
  | { readonly ok: true; readonly request: PreparedRouterRequest }
  | { readonly ok: false; readonly failure: RunProfileSuggestionFailure };

/**
 * Builds the request body and response parser for an API style, so `HttpRunProfileRouter.suggest`
 * and `testAiRouterEndpoint` cannot drift apart (#BIT-210).
 */
export function prepareRouterRequest(args: {
  readonly apiStyle: AiRouterApiStyle;
  readonly model: string;
  readonly task: RunProfileRouterTaskInput;
  readonly context: RunProfileRouterContext;
}): PreparedRouterRequestResult {
  const { apiStyle, task, context } = args;
  const model = args.model.trim();

  if (apiStyle === "cloudflare-clef") {
    const selector = resolveClefModelSelector(model);
    if (!selector) {
      return { ok: false, failure: { reason: "invalid_endpoint" } };
    }
    const built = buildClefRequest(task, context, selector);
    if (!built) {
      return { ok: false, failure: { reason: "no_run_levels" } };
    }
    return {
      ok: true,
      request: {
        body: built.body,
        parse: (json, minConfidence) => validateClefResponse(json, built, minConfidence),
      },
    };
  }

  const built = buildRouterRequest(task, context);
  if (!built) {
    return { ok: false, failure: { reason: "no_run_levels" } };
  }
  const body =
    apiStyle === "cloudflare-run"
      ? {
          messages: built.messages,
          response_format: {
            type: "json_schema",
            json_schema: built.jsonSchema,
          },
        }
      : {
          model,
          messages: built.messages,
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "run_profile_suggestion",
              strict: true,
              schema: built.jsonSchema,
            },
          },
        };
  return {
    ok: true,
    request: {
      body,
      parse: (json, minConfidence) => {
        let extracted: unknown;
        try {
          extracted = extractRawRouterPayload(json, apiStyle);
        } catch {
          return failed({ reason: "bad_response_shape" });
        }
        return validateRouterSuggestionPayload(extracted, built, minConfidence);
      },
    },
  };
}

export interface HttpRunProfileRouterOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiToken: string;
  readonly apiStyle?: AiRouterApiStyle | undefined;
  readonly enabled?: boolean | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
  readonly minConfidence?: number | undefined;
}

export class HttpRunProfileRouter implements RunProfileRouter {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiToken: string;
  private readonly apiStyle: AiRouterApiStyle;
  private readonly enabled: boolean;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;
  private readonly minConfidence: number;

  constructor(options: HttpRunProfileRouterOptions) {
    this.baseUrl = options.baseUrl.trim();
    this.model = options.model.trim();
    this.apiToken = options.apiToken.trim();
    this.apiStyle = options.apiStyle ?? "cloudflare-run";
    this.enabled = options.enabled ?? true;
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS;
    this.minConfidence = options.minConfidence ?? DEFAULT_ROUTER_MIN_CONFIDENCE;
  }

  async suggest(
    task: RunProfileRouterTaskInput,
    context: RunProfileRouterContext,
  ): Promise<RunProfileSuggestionOutcome> {
    if (!this.enabled) {
      return failed({ reason: "router_disabled" });
    }
    if (!this.apiToken) {
      return failed({ reason: "no_token" });
    }
    if (!this.baseUrl || !this.model) {
      return failed({ reason: "not_configured" });
    }

    let endpointUrl: string;
    try {
      endpointUrl = buildAiRouterEndpointUrl(this.baseUrl, this.model, this.apiStyle);
    } catch {
      return failed({ reason: "invalid_endpoint" });
    }

    const prepared = prepareRouterRequest({
      apiStyle: this.apiStyle,
      model: this.model,
      task,
      context,
    });
    if (!prepared.ok) {
      return failed(prepared.failure);
    }
    const requestBody = prepared.request.body;

    const controller = new AbortController();
    // Object state so the flag set inside the timer callback is not narrowed to `false` below.
    const timeoutState = { fired: false };
    const timeoutId = setTimeout(() => {
      timeoutState.fired = true;
      controller.abort(new Error("AI router request timed out"));
    }, this.timeoutMs);
    const onExternalAbort = () => {
      controller.abort(context.signal?.reason);
    };
    if (context.signal) {
      if (context.signal.aborted) {
        clearTimeout(timeoutId);
        return failed({ reason: "aborted" });
      }
      context.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    // Timeouts and external aborts surface as fetch/body-read rejections; classify them before
    // falling back to a generic network failure or an unreadable body.
    const transportFailure = (): RunProfileSuggestionFailure => {
      if (timeoutState.fired) return { reason: "timeout" };
      if (context.signal?.aborted) return { reason: "aborted" };
      return { reason: "network_error" };
    };

    try {
      let response: Response;
      try {
        response = await this.fetchFn(endpointUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        });
      } catch {
        return failed(transportFailure());
      }

      if (!response.ok) {
        // Redact before truncating so a token cut at the boundary cannot survive.
        const bodyText = redactSecret(
          (await response.text().catch(() => "")).trim(),
          this.apiToken,
        ).slice(0, HTTP_ERROR_DETAIL_MAX);
        return failed({
          reason: "http_error",
          status: response.status,
          ...(bodyText ? { detail: bodyText } : {}),
        });
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        const interrupted = timeoutState.fired || context.signal?.aborted === true;
        return failed(interrupted ? transportFailure() : { reason: "bad_response_shape" });
      }

      return prepared.request.parse(json, this.minConfidence);
    } finally {
      clearTimeout(timeoutId);
      if (context.signal) {
        context.signal.removeEventListener("abort", onExternalAbort);
      }
    }
  }
}

export interface TestAiRouterEndpointResult {
  readonly ok: boolean;
  readonly status?: number | undefined;
  readonly error?: string | undefined;
  readonly suggestion?: RunProfileSuggestion | undefined;
}

function redactSecret(text: string, secret: string): string {
  const trimmed = secret.trim();
  if (!trimmed) return text;
  return text.split(trimmed).join("[REDACTED]");
}

/**
 * Sends a tiny diagnostic request to the organisation's AI router endpoint (`POST /api/orgs/:id/ai-router/test`)
 * and reports either `{ ok: true, suggestion }` or `{ ok: false, error, status }` without ever exposing the token.
 */
export async function testAiRouterEndpoint(options: {
  readonly baseUrl: string;
  readonly model: string;
  readonly apiToken: string;
  readonly apiStyle?: AiRouterApiStyle | undefined;
  readonly levels: readonly RunLevel[];
  readonly effortValuesByLevel?: Readonly<Record<string, readonly string[]>> | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly timeoutMs?: number | undefined;
}): Promise<TestAiRouterEndpointResult> {
  const apiStyle = options.apiStyle ?? "cloudflare-run";
  const endpointUrl = buildAiRouterEndpointUrl(options.baseUrl, options.model, apiStyle);
  const apiToken = options.apiToken.trim();
  if (!apiToken) {
    makeRouterValidationError("apiToken", "AI router API token is not set.");
  }

  const prepared = prepareRouterRequest({
    apiStyle,
    model: options.model,
    task: {
      title: "Update button label in settings header",
      description: "Rename the Save button label in the settings header component.",
      checklist: [{ text: "Update label text", done: false }],
      labels: ["ui"],
    },
    context: {
      levels: options.levels,
      ...(options.effortValuesByLevel ? { effortValuesByLevel: options.effortValuesByLevel } : {}),
    },
  });
  if (!prepared.ok) {
    return {
      ok: false,
      error:
        prepared.failure.reason === "invalid_endpoint"
          ? "The model must be @cf/cloudflare/clef or @cf/cloudflare/clef-flash for the Clef API style."
          : apiStyle === "cloudflare-clef"
            ? "The Clef API style needs at least two run levels; the organisation has fewer configured."
            : "Organisation has no run levels configured.",
    };
  }
  const requestBody = prepared.request.body;

  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROUTER_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error("AI router request timed out"));
  }, timeoutMs);

  try {
    const response = await fetchFn(endpointUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      const snippet = redactSecret(errorText.trim().slice(0, 300), apiToken);
      return {
        ok: false,
        status: response.status,
        error: snippet
          ? `Endpoint returned HTTP ${String(response.status)}: ${snippet}`
          : `Endpoint returned HTTP ${String(response.status)}`,
      };
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      return {
        ok: false,
        status: response.status,
        error: "Endpoint did not return valid JSON.",
      };
    }

    // minConfidence 0: the diagnostic checks the response shape, not the model's certainty.
    const outcome = prepared.request.parse(json, 0);
    if (!outcome.ok) {
      return {
        ok: false,
        status: response.status,
        error:
          outcome.failure.reason === "bad_response_shape"
            ? "Endpoint response content was not valid JSON or had an unexpected shape."
            : "Endpoint response did not match the expected run profile schema.",
      };
    }

    return {
      ok: true,
      status: response.status,
      suggestion: outcome.suggestion,
    };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: redactSecret(rawMessage || "Failed to reach AI router endpoint.", apiToken),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}
