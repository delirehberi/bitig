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
 * Pluggable task run profile router (#BIT-187).
 * Another decider (e.g. an ACP decision model reached through T3) can replace the HTTP router later.
 */
export interface RunProfileRouter {
  suggest(
    task: RunProfileRouterTaskInput,
    context: RunProfileRouterContext,
  ): Promise<RunProfileSuggestion | null>;
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
 * - `cloudflare-run`: appends `<baseUrl>/<model>` directly so `@` and `/` in the model ID are preserved in the URL path.
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

  if (style === "cloudflare-run") {
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

  const sanitizedInput = {
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
): RunProfileSuggestion | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const obj = raw as Record<string, unknown>;

  // Reject unexpected extra keys
  const allowedKeys = new Set(["level", "effort", "touches", "parallelSafe", "reason", "confidence"]);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      return null;
    }
  }

  if (typeof obj.level !== "string") {
    return null;
  }
  const levelKey = obj.level.trim().toLowerCase();
  if (!built.allowedLevels.has(levelKey)) {
    return null;
  }

  let validatedEffort: string | undefined;
  if (obj.effort !== undefined && obj.effort !== null) {
    if (typeof obj.effort !== "string") {
      return null;
    }
    const parsedEffort = RunProfileEffortSchema.safeParse(obj.effort);
    if (!parsedEffort.success) {
      return null;
    }
    const allowedEfforts = built.allowedEffortsByLevel.get(levelKey);
    if (!allowedEfforts?.has(parsedEffort.data)) {
      return null;
    }
    validatedEffort = parsedEffort.data;
  }

  if (!Array.isArray(obj.touches) || !obj.touches.every((item) => typeof item === "string")) {
    return null;
  }
  const parsedTouches = RunProfileTouchesSchema.safeParse(obj.touches);
  if (!parsedTouches.success) {
    return null;
  }

  if (typeof obj.parallelSafe !== "boolean") {
    return null;
  }

  if (typeof obj.reason !== "string") {
    return null;
  }
  const parsedReason = RunProfileReasonSchema.safeParse(obj.reason);
  if (!parsedReason.success) {
    return null;
  }

  if (typeof obj.confidence !== "number" || !Number.isFinite(obj.confidence)) {
    return null;
  }
  const parsedConfidence = RunProfileConfidenceSchema.safeParse(obj.confidence);
  if (!parsedConfidence.success || parsedConfidence.data < minConfidence) {
    return null;
  }

  return {
    level: levelKey,
    ...(validatedEffort !== undefined ? { effort: validatedEffort } : {}),
    touches: parsedTouches.data,
    parallelSafe: obj.parallelSafe,
    reason: parsedReason.data,
    confidence: parsedConfidence.data,
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
  ): Promise<RunProfileSuggestion | null> {
    if (!this.enabled || !this.baseUrl || !this.model || !this.apiToken) {
      return null;
    }

    let endpointUrl: string;
    try {
      endpointUrl = buildAiRouterEndpointUrl(this.baseUrl, this.model, this.apiStyle);
    } catch {
      return null;
    }

    const built = buildRouterRequest(task, context);
    if (!built) {
      return null;
    }

    const requestBody =
      this.apiStyle === "cloudflare-run"
        ? {
            messages: built.messages,
            response_format: {
              type: "json_schema",
              json_schema: built.jsonSchema,
            },
          }
        : {
            model: this.model,
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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(new Error("AI router request timed out"));
    }, this.timeoutMs);
    const onExternalAbort = () => {
      controller.abort(context.signal?.reason);
    };
    if (context.signal) {
      if (context.signal.aborted) {
        clearTimeout(timeoutId);
        return null;
      }
      context.signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const response = await this.fetchFn(endpointUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const json: unknown = await response.json();
      const extracted = extractRawRouterPayload(json, this.apiStyle);
      return validateRouterSuggestionPayload(extracted, built, this.minConfidence);
    } catch {
      return null;
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

  const built = buildRouterRequest(
    {
      title: "Update button label in settings header",
      description: "Rename the Save button label in the settings header component.",
      checklist: [{ text: "Update label text", done: false }],
      labels: ["ui"],
    },
    {
      levels: options.levels,
      ...(options.effortValuesByLevel ? { effortValuesByLevel: options.effortValuesByLevel } : {}),
    },
  );
  if (!built) {
    return { ok: false, error: "Organisation has no run levels configured." };
  }

  const requestBody =
    apiStyle === "cloudflare-run"
      ? {
          messages: built.messages,
          response_format: {
            type: "json_schema",
            json_schema: built.jsonSchema,
          },
        }
      : {
          model: options.model.trim(),
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

    let extracted: unknown;
    try {
      extracted = extractRawRouterPayload(json, apiStyle);
    } catch {
      return {
        ok: false,
        status: response.status,
        error: "Endpoint response content was not valid JSON.",
      };
    }

    const suggestion = validateRouterSuggestionPayload(extracted, built, 0);
    if (!suggestion) {
      return {
        ok: false,
        status: response.status,
        error: "Endpoint response did not match the expected run profile schema.",
      };
    }

    return {
      ok: true,
      status: response.status,
      suggestion,
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
