import { describe, expect, it, vi } from "vitest";
import { InMemoryStorage } from "../memory/memory-storage";
import { createTestRuntime } from "../testing/fixtures";
import { DESCRIPTION_MAX } from "./constants";
import { ValidationError } from "./errors";
import { resolveSentryTasks } from "./webhook-resolution";
import { classifyWebhookPayload, extractTaskFromWebhookPayload } from "./webhooks";

const ISSUE_URL = "https://sentry.io/organizations/example/issues/42/";
const ISSUE = { id: "42", title: "An error", permalink: ISSUE_URL };
const RESOLVED = { action: "resolved", data: { issue: ISSUE } };

async function setup() {
  const storage = new InMemoryStorage(createTestRuntime());
  const project = await storage.createProject({ name: "Project", key: "BIT" });
  const webhook = await storage.createWebhook({ projectId: project.id, name: "Sentry", provider: "sentry" });
  return { storage, project, webhook };
}

describe("Sentry webhook classification", () => {
  it.each(["created", "regressed", "triggered", undefined])("creates for %s", async (action) => {
    const { webhook } = await setup();
    expect(classifyWebhookPayload(webhook, { action, data: { issue: ISSUE } })).toBe("create");
  });

  it.each(["ignored", "assigned", "deleted", "unknown", "unresolved"])("ignores %s", async (action) => {
    const { webhook } = await setup();
    expect(classifyWebhookPayload(webhook, { action })).toBe("ignore");
  });

  it.each([RESOLVED, { issue: { status: "resolved" } }, { data: { issue: { status: "resolved" } } }, { status: "resolved" }])(
    "recognizes resolution without requiring a title: %j", async (payload) => {
      const { webhook } = await setup();
      expect(classifyWebhookPayload(webhook, payload)).toBe("resolve");
    },
  );

  it("does not create for ignored issue status, even with a creation action", async () => {
    const { webhook } = await setup();
    expect(classifyWebhookPayload(webhook, { action: "created", data: { issue: { status: "ignored" } } })).toBe("ignore");
  });

  it.each([null, [], "payload", { action: null }, { action: false }, { action: {} }, { action: " " }])(
    "rejects malformed input %j", async (payload) => {
      const { webhook } = await setup();
      expect(() => classifyWebhookPayload(webhook, payload)).toThrow(ValidationError);
    },
  );

  it.each(["generic", "github", "jira"] as const)("preserves %s provider behavior", async (provider) => {
    const { webhook } = await setup();
    expect(classifyWebhookPayload({ ...webhook, provider }, RESOLVED)).toBe("create");
  });
});

describe("Sentry resolution sync", () => {
  it("completes a pending task with a comment and leaves it unchanged on repeat delivery", async () => {
    const { storage, webhook } = await setup();
    const task = await storage.saveTask(extractTaskFromWebhookPayload(webhook, { data: { issue: ISSUE } }));
    expect(task.pendingApproval).toBe(true);
    expect(await resolveSentryTasks(storage, webhook, RESOLVED)).toEqual({
      status: "resolved", completedTaskIds: [task.id], blockedTaskIds: [],
    });
    const completed = await storage.getTask(task.id);
    expect(completed).toMatchObject({ status: "done", completedBy: "sentry" });
    expect(completed?.pendingApproval).toBeUndefined();
    expect(await storage.getComments(task.id)).toHaveLength(1);
    await resolveSentryTasks(storage, webhook, RESOLVED);
    expect(await storage.getTask(task.id)).toEqual(completed);
    expect(await storage.getComments(task.id)).toHaveLength(1);
    expect(await storage.getTasks()).toHaveLength(1);
  });

  it("matches legacy link metadata but never titles, URL substrings, or other projects", async () => {
    const { storage, webhook, project } = await setup();
    const other = await storage.createProject({ name: "Other", key: "OTH" });
    const description = `- **Sentry Issue:** ${ISSUE_URL}`;
    const matched = await storage.saveTask({ projectId: project.id, title: "Old task", description });
    const foreign = await storage.saveTask({ projectId: other.id, title: "Old task", description });
    const titleOnly = await storage.saveTask({ projectId: project.id, title: ISSUE.title });
    const substring = await storage.saveTask({ projectId: project.id, title: "Different link", description: `${description}extra` });
    await resolveSentryTasks(storage, webhook, RESOLVED);
    expect((await storage.getTask(matched.id))?.status).toBe("done");
    for (const task of [foreign, titleOnly, substring]) {
      expect(await storage.getTask(task.id)).toEqual(task);
      expect(await storage.getComments(task.id)).toEqual([]);
    }
  });

  it("keeps stable ID metadata for mapped and long descriptions", async () => {
    const { storage, webhook } = await setup();
    const mapped = { ...webhook, mapping: { description: "custom" } };
    const input = extractTaskFromWebhookPayload(mapped, { data: { issue: ISSUE }, custom: "x".repeat(DESCRIPTION_MAX) });
    expect(input.description).toHaveLength(DESCRIPTION_MAX);
    const task = await storage.saveTask(input);
    await resolveSentryTasks(storage, webhook, { action: "resolved", data: { issue: { id: ISSUE.id } } });
    expect((await storage.getTask(task.id))?.status).toBe("done");
  });

  it("does not cross webhook boundaries when matching an ID without a link", async () => {
    const { storage, webhook, project } = await setup();
    const other = await storage.createWebhook({ projectId: project.id, name: "Other Sentry", provider: "sentry" });
    const payload = { data: { issue: { id: ISSUE.id, title: ISSUE.title } } };
    const task = await storage.saveTask(extractTaskFromWebhookPayload(other, payload));
    await resolveSentryTasks(storage, webhook, payload);
    expect(await storage.getTask(task.id)).toEqual(task);
  });

  it.each(["done", "archived"] as const)("does not change a %s task or add a comment", async (status) => {
    const { storage, webhook } = await setup();
    const task = await storage.saveTask(extractTaskFromWebhookPayload(webhook, { data: { issue: ISSUE } }));
    const finished = await storage.updateTask(task.id, { status, pendingApproval: null });
    await resolveSentryTasks(storage, webhook, RESOLVED);
    expect(await storage.getTask(task.id)).toEqual(finished);
    expect(await storage.getComments(task.id)).toEqual([]);
  });

  it("acknowledges missing references and unmatched resolutions without creating tasks", async () => {
    const { storage, webhook } = await setup();
    for (const payload of [RESOLVED, { action: "resolved" }, { issue: { id: {}, permalink: "not a URL" } }]) {
      expect((await resolveSentryTasks(storage, webhook, payload)).completedTaskIds).toEqual([]);
    }
    expect(await storage.getTasks()).toEqual([]);
  });

  it("preserves dependency gates and reports blocked tasks", async () => {
    const { storage, webhook, project } = await setup();
    const dependency = await storage.saveTask({ projectId: project.id, title: "Dependency" });
    const task = await storage.saveTask({
      ...extractTaskFromWebhookPayload(webhook, { data: { issue: ISSUE } }), dependsOn: [dependency.id],
    });
    expect((await resolveSentryTasks(storage, webhook, RESOLVED)).blockedTaskIds).toEqual([task.id]);
    expect(await storage.getTask(task.id)).toEqual(task);
    expect(await storage.getComments(task.id)).toEqual([]);
  });

  it("reuses the explanation when retrying after a failed status write", async () => {
    const { storage, webhook } = await setup();
    const task = await storage.saveTask(extractTaskFromWebhookPayload(webhook, { data: { issue: ISSUE } }));
    const update = vi.spyOn(storage, "updateTask").mockRejectedValueOnce(new Error("storage failure"));
    await expect(resolveSentryTasks(storage, webhook, RESOLVED)).rejects.toThrow("storage failure");
    expect((await storage.getTask(task.id))?.status).toBe("todo");
    await resolveSentryTasks(storage, webhook, RESOLVED);
    expect(await storage.getComments(task.id)).toHaveLength(1);
    expect((await storage.getTask(task.id))?.status).toBe("done");
    update.mockRestore();
  });
});
