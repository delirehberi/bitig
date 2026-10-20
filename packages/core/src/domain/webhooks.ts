/**
 * Webhook payload extraction and dot-path mapping engine.
 *
 * Converts incoming JSON webhook payloads from built-in providers (`sentry`,
 * `jira`, `github`, `generic`) and/or custom dot-path field mappings into a
 * validated `CreateTaskInput` ready for `storage.saveTask`.
 */
import {
  DESCRIPTION_MAX,
  LABELS_MAX_COUNT,
  LABEL_MAX,
  TASK_PRIORITIES,
  TASK_TITLE_MAX,
} from "./constants";
import { ValidationError, parseOrThrow } from "./errors";
import { CreateTaskInputSchema } from "./schemas";
import type { CreateTaskInput, TaskPriority, Webhook } from "./types";

const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Safely resolves a dot-separated path (e.g. `issue.fields.summary` or `items.0.name`)
 * against an arbitrary parsed JSON value without prototype traversal.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  const segments = path
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) return undefined;

  let current: unknown = root;
  for (const segment of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
      continue;
    }
    return undefined;
  }
  return current;
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

/** Extracts readable plain text from an Atlassian Document Format (ADF) node or string. */
function extractTextOrAdf(value: unknown): string | undefined {
  const direct = asNonEmptyString(value);
  if (direct !== undefined) return direct;
  if (!isRecord(value)) return undefined;

  const chunks: string[] = [];
  function walk(node: unknown): void {
    if (!isRecord(node)) return;
    if (typeof node.text === "string") {
      chunks.push(node.text);
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        walk(child);
      }
      if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") {
        chunks.push("\n");
      }
    }
  }
  walk(value);
  const joined = chunks.join("").trim();
  return joined.length > 0 ? joined : undefined;
}

/** Maps common external priority / severity names to Bitig's `TaskPriority`. */
export function normalizeExternalPriority(value: unknown): TaskPriority | undefined {
  const raw = isRecord(value) ? asNonEmptyString(value.name ?? value.id ?? value.level) : asNonEmptyString(value);
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if ((TASK_PRIORITIES as readonly string[]).includes(lower)) {
    return lower as TaskPriority;
  }
  switch (lower) {
    case "fatal":
    case "blocker":
    case "critical":
    case "highest":
    case "sev0":
    case "sev1":
    case "p0":
    case "p1":
      return "urgent";
    case "error":
    case "high":
    case "major":
    case "sev2":
    case "p2":
      return "high";
    case "warning":
    case "warn":
    case "medium":
    case "normal":
    case "moderate":
    case "sev3":
    case "p3":
      return "medium";
    case "info":
    case "low":
    case "minor":
    case "sev4":
    case "p4":
      return "low";
    case "debug":
    case "trivial":
    case "lowest":
    case "cosmetic":
    case "p5":
      return "trivial";
    default:
      return undefined;
  }
}

function normalizeExternalLabels(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed.length > 0) result.push(trimmed);
    } else if (isRecord(item)) {
      const name = asNonEmptyString(item.name ?? item.label ?? item.key ?? item.value);
      if (name !== undefined) result.push(name);
    }
  }
  return result;
}

interface ExtractedFields {
  title?: string | undefined;
  description?: string | undefined;
  priority?: TaskPriority | undefined;
  labels?: string[] | undefined;
}

function extractSentryFields(payload: Readonly<Record<string, unknown>>): ExtractedFields {
  const data = isRecord(payload.data) ? payload.data : undefined;
  const issue = isRecord(data?.issue) ? data.issue : isRecord(payload.issue) ? payload.issue : undefined;
  const event = isRecord(data?.event) ? data.event : isRecord(payload.event) ? payload.event : undefined;

  const shortId = asNonEmptyString(issue?.shortId ?? payload.short_id);
  const rawTitle =
    asNonEmptyString(issue?.title) ??
    asNonEmptyString(event?.title) ??
    asNonEmptyString(payload.message) ??
    asNonEmptyString(payload.title) ??
    asNonEmptyString(issue?.culprit) ??
    asNonEmptyString(payload.culprit);

  const title =
    rawTitle !== undefined
      ? shortId !== undefined && !rawTitle.startsWith(`[${shortId}]`)
        ? `[${shortId}] ${rawTitle}`
        : rawTitle
      : undefined;

  const culprit = asNonEmptyString(issue?.culprit ?? event?.culprit ?? payload.culprit);
  const level = asNonEmptyString(issue?.level ?? event?.level ?? payload.level);
  const project = asNonEmptyString(
    (isRecord(issue?.project) ? issue.project.slug ?? issue.project.name : undefined) ??
      payload.project_name ??
      payload.project,
  );
  const permalink = asNonEmptyString(issue?.permalink ?? event?.web_url ?? payload.url);
  const message = asNonEmptyString(event?.message ?? payload.message);

  const lines: string[] = [];
  if (message !== undefined && message !== rawTitle) {
    lines.push(message, "");
  }
  const meta: string[] = [];
  if (project !== undefined) meta.push(`- **Project:** ${project}`);
  if (level !== undefined) meta.push(`- **Level:** ${level}`);
  if (culprit !== undefined) meta.push(`- **Location:** \`${culprit}\``);
  if (permalink !== undefined) meta.push(`- **Sentry Issue:** ${permalink}`);
  if (meta.length > 0) lines.push(...meta);

  const labels = ["sentry"];
  if (level !== undefined) labels.push(level.toLowerCase());

  return {
    title,
    description: lines.length > 0 ? lines.join("\n") : undefined,
    priority: normalizeExternalPriority(level),
    labels,
  };
}

function extractJiraFields(payload: Readonly<Record<string, unknown>>): ExtractedFields {
  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const fields = isRecord(issue?.fields) ? issue.fields : isRecord(payload.fields) ? payload.fields : undefined;

  const issueKey = asNonEmptyString(issue?.key ?? payload.key);
  const summary =
    asNonEmptyString(fields?.summary) ??
    asNonEmptyString(payload.summary) ??
    asNonEmptyString(payload.title);

  const title =
    summary !== undefined
      ? issueKey !== undefined && !summary.startsWith(`[${issueKey}]`)
        ? `[${issueKey}] ${summary}`
        : summary
      : undefined;

  const bodyText = extractTextOrAdf(fields?.description ?? payload.description);
  const issueType = isRecord(fields?.issuetype) ? asNonEmptyString(fields.issuetype.name) : undefined;
  const browseUrl = asNonEmptyString(payload.url ?? issue?.self);

  const parts: string[] = [];
  if (bodyText !== undefined) parts.push(bodyText);
  const meta: string[] = [];
  if (issueKey !== undefined) meta.push(`- **Jira Key:** ${issueKey}`);
  if (issueType !== undefined) meta.push(`- **Type:** ${issueType}`);
  if (browseUrl !== undefined) meta.push(`- **Source:** ${browseUrl}`);
  if (meta.length > 0) parts.push(meta.join("\n"));

  const labels = ["jira", ...normalizeExternalLabels(fields?.labels ?? payload.labels)];
  if (issueType !== undefined) labels.push(issueType.toLowerCase().replaceAll(/\s+/g, "-"));

  return {
    title,
    description: parts.length > 0 ? parts.join("\n\n") : undefined,
    priority: normalizeExternalPriority(fields?.priority ?? payload.priority),
    labels,
  };
}

function extractGithubFields(payload: Readonly<Record<string, unknown>>): ExtractedFields {
  const issue = isRecord(payload.issue) ? payload.issue : undefined;
  const pr = isRecord(payload.pull_request) ? payload.pull_request : undefined;
  const commit = isRecord(payload.head_commit) ? payload.head_commit : undefined;
  const repo = isRecord(payload.repository) ? asNonEmptyString(payload.repository.full_name) : undefined;

  const number = asNonEmptyString(issue?.number ?? pr?.number);
  const rawTitle =
    asNonEmptyString(issue?.title) ??
    asNonEmptyString(pr?.title) ??
    asNonEmptyString(commit?.message)?.split("\n")[0] ??
    asNonEmptyString(payload.title);

  const title =
    rawTitle !== undefined
      ? number !== undefined && !rawTitle.startsWith(`#${number}`)
        ? `#${number} ${rawTitle}`
        : rawTitle
      : undefined;

  const body = asNonEmptyString(issue?.body ?? pr?.body ?? payload.body ?? payload.description);
  const htmlUrl = asNonEmptyString(issue?.html_url ?? pr?.html_url ?? commit?.url ?? payload.html_url);

  const parts: string[] = [];
  if (body !== undefined) parts.push(body);
  const meta: string[] = [];
  if (repo !== undefined) meta.push(`- **Repository:** ${repo}`);
  if (htmlUrl !== undefined) meta.push(`- **GitHub Link:** ${htmlUrl}`);
  if (meta.length > 0) parts.push(meta.join("\n"));

  const labels = ["github", ...normalizeExternalLabels(issue?.labels ?? pr?.labels ?? payload.labels)];

  return {
    title,
    description: parts.length > 0 ? parts.join("\n\n") : undefined,
    priority: normalizeExternalPriority(payload.priority ?? payload.severity),
    labels,
  };
}

function extractGenericFields(payload: Readonly<Record<string, unknown>>): ExtractedFields {
  const title =
    asNonEmptyString(payload.title) ??
    asNonEmptyString(payload.summary) ??
    asNonEmptyString(payload.name) ??
    asNonEmptyString(payload.message);

  const description =
    extractTextOrAdf(payload.description) ??
    extractTextOrAdf(payload.body) ??
    extractTextOrAdf(payload.details);

  return {
    title,
    description,
    priority: normalizeExternalPriority(payload.priority ?? payload.severity ?? payload.level),
    labels: normalizeExternalLabels(payload.labels ?? payload.tags),
  };
}

function mergeUniqueLabels(
  defaults: readonly string[] | undefined,
  extracted: readonly string[] | undefined,
): string[] | undefined {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...(defaults ?? []), ...(extracted ?? [])]) {
    const trimmed = raw.trim().slice(0, LABEL_MAX);
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
    if (merged.length >= LABELS_MAX_COUNT) break;
  }
  return merged.length > 0 ? merged : undefined;
}

/**
 * Extracts a validated `CreateTaskInput` from an incoming webhook JSON payload,
 * applying custom dot-path mappings first, then the provider's extractor, and
 * finally the webhook's default priority and labels.
 */
export function extractTaskFromWebhookPayload(webhook: Webhook, payload: unknown): CreateTaskInput {
  if (!isRecord(payload)) {
    throw new ValidationError("webhookPayload", [
      {
        code: "custom",
        path: [],
        message: "Webhook payload must be a JSON object",
      },
    ]);
  }

  let providerFields: ExtractedFields;
  switch (webhook.provider) {
    case "sentry":
      providerFields = extractSentryFields(payload);
      break;
    case "jira":
      providerFields = extractJiraFields(payload);
      break;
    case "github":
      providerFields = extractGithubFields(payload);
      break;
    case "generic":
      providerFields = extractGenericFields(payload);
      break;
  }

  const mappedTitle =
    webhook.mapping?.title !== undefined ? asNonEmptyString(resolveJsonPath(payload, webhook.mapping.title)) : undefined;
  const mappedDescription =
    webhook.mapping?.description !== undefined
      ? extractTextOrAdf(resolveJsonPath(payload, webhook.mapping.description))
      : undefined;
  const mappedPriority =
    webhook.mapping?.priority !== undefined
      ? normalizeExternalPriority(resolveJsonPath(payload, webhook.mapping.priority))
      : undefined;
  const mappedLabels =
    webhook.mapping?.labels !== undefined
      ? normalizeExternalLabels(resolveJsonPath(payload, webhook.mapping.labels))
      : undefined;

  const rawTitle = mappedTitle ?? providerFields.title ?? extractGenericFields(payload).title;
  if (rawTitle === undefined) {
    throw new ValidationError("webhookPayload", [
      {
        code: "custom",
        path: ["title"],
        message: "Could not extract a task title from the webhook payload",
      },
    ]);
  }

  const title = rawTitle.slice(0, TASK_TITLE_MAX);
  const rawDescription = mappedDescription ?? providerFields.description ?? "";
  const description = rawDescription.slice(0, DESCRIPTION_MAX);
  const priority = mappedPriority ?? providerFields.priority ?? webhook.defaultPriority;
  const labels = mergeUniqueLabels(
    webhook.defaultLabels,
    mappedLabels !== undefined && mappedLabels.length > 0 ? mappedLabels : providerFields.labels,
  );

  // Tasks from outside systems wait for a person to approve them, like tasks agents create over MCP.
  const input: CreateTaskInput = {
    projectId: webhook.projectId,
    title,
    description,
    pendingApproval: true,
  };
  if (priority !== undefined) input.priority = priority;
  if (labels !== undefined) input.labels = labels;
  if (typeof payload.dueDate === "string") input.dueDate = payload.dueDate;
  if (typeof payload.needsHuman === "string" && payload.needsHuman.trim().length > 0) {
    input.needsHuman = payload.needsHuman;
  }
  if (Array.isArray(payload.checklist)) {
    input.checklist = payload.checklist as CreateTaskInput["checklist"];
  }

  return parseOrThrow(CreateTaskInputSchema, input, "extractTaskFromWebhookPayload");
}

