import { describe, expect, it } from "vitest";
import {
  InMemoryStorage,
  STORAGE_MODES,
  ValidationError,
  buildWebhook,
  defaultRuntimeDeps,
  extractTaskFromWebhookPayload,
  isStorageMode,
  resolveJsonPath,
} from "./index";
import { runStorageContractSuite } from "./testing";

const PROJECT_ID = "01940000-0000-7000-8000-000000000001";

describe("isStorageMode", () => {
  it.each(STORAGE_MODES)("accepts %s", (mode) => {
    expect(isStorageMode(mode)).toBe(true);
  });

  it.each([undefined, null, "", "LOCAL", "d1", 1, {}])("rejects %o", (value) => {
    expect(isStorageMode(value)).toBe(false);
  });
});

runStorageContractSuite("InMemoryStorage", (runtime) => ({
  storage: new InMemoryStorage(runtime),
}));

describe("extractTaskFromWebhookPayload", () => {
  it("extracts Sentry issue webhook payloads", () => {
    const webhook = buildWebhook(
      {
        projectId: PROJECT_ID,
        name: "Sentry",
        provider: "sentry",
        defaultLabels: ["monitoring"],
      },
      defaultRuntimeDeps,
    );

    const taskInput = extractTaskFromWebhookPayload(webhook, {
      data: {
        issue: {
          shortId: "BITIG-42",
          title: "TypeError: Cannot read properties of undefined",
          culprit: "apps/worker/src/index.ts",
          level: "error",
          permalink: "https://sentry.io/issues/42/",
          project: { slug: "bitig-worker" },
        },
      },
    });

    expect(taskInput).toMatchObject({
      projectId: PROJECT_ID,
      title: "[BITIG-42] TypeError: Cannot read properties of undefined",
      priority: "high",
      labels: ["monitoring", "sentry", "error"],
    });
    expect(taskInput.description).toContain("https://sentry.io/issues/42/");
    expect(taskInput.description).toContain("apps/worker/src/index.ts");
  });

  it("extracts Jira issue webhook payloads including ADF descriptions", () => {
    const webhook = buildWebhook(
      {
        projectId: PROJECT_ID,
        name: "Jira",
        provider: "jira",
      },
      defaultRuntimeDeps,
    );

    const taskInput = extractTaskFromWebhookPayload(webhook, {
      issue: {
        key: "OPS-19",
        self: "https://acme.atlassian.net/rest/api/3/issue/10019",
        fields: {
          summary: "Upgrade Cloudflare D1 bindings",
          description: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Needs migration 0008." }] }],
          },
          priority: { name: "Highest" },
          issuetype: { name: "Bug" },
          labels: ["infra"],
        },
      },
    });

    expect(taskInput).toMatchObject({
      projectId: PROJECT_ID,
      title: "[OPS-19] Upgrade Cloudflare D1 bindings",
      priority: "urgent",
      labels: ["jira", "infra", "bug"],
    });
    expect(taskInput.description).toContain("Needs migration 0008.");
  });

  it("applies custom dot-path field mappings (e.g. jira.title -> bitig.title)", () => {
    const webhook = buildWebhook(
      {
        projectId: PROJECT_ID,
        name: "Custom Mapped",
        provider: "generic",
        mapping: {
          title: "jira.title",
          description: "jira.details.body",
          priority: "jira.severity",
          labels: "jira.tags",
        },
        defaultLabels: ["synced"],
      },
      defaultRuntimeDeps,
    );

    const taskInput = extractTaskFromWebhookPayload(webhook, {
      jira: {
        title: "Mapped ticket title",
        details: { body: "Mapped description text" },
        severity: "critical",
        tags: ["backend", "webhook"],
      },
    });

    expect(taskInput).toEqual({
      projectId: PROJECT_ID,
      title: "Mapped ticket title",
      description: "Mapped description text",
      priority: "urgent",
      labels: ["synced", "backend", "webhook"],
      status: "todo",
      isPublic: false,
    });
  });

  it("blocks prototype traversal in resolveJsonPath and rejects missing titles", () => {
    expect(resolveJsonPath({ a: 1 }, "__proto__.polluted")).toBeUndefined();
    expect(resolveJsonPath({ a: 1 }, "constructor.prototype")).toBeUndefined();

    const webhook = buildWebhook({ projectId: PROJECT_ID, name: "Generic" }, defaultRuntimeDeps);
    expect(() => extractTaskFromWebhookPayload(webhook, { foo: "bar" })).toThrow(ValidationError);
    expect(() => extractTaskFromWebhookPayload(webhook, null)).toThrow(ValidationError);
  });
});


