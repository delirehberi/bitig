import { describe, expect, it } from "vitest";
import { defaultIdGenerator, toTimestamp } from "@bitig/core";
import { encodeProjectEvent, decodeProjectEvent } from "./project-codec";
import { encodeTaskEvent, decodeTaskEvent } from "./task-codec";
import { PrivateKeySigner } from "../signer/private-key-signer";
import { NOSTR_KIND_PROJECT, NOSTR_KIND_TASK } from "../kinds";

describe("Nostr codecs", () => {
  const signer = new PrivateKeySigner();

  it("encodes and decodes a Project round-trip", () => {
    const now = toTimestamp(new Date());
    const project = {
      id: defaultIdGenerator(),
      name: "Bitig Nostr",
      description: "Nostr storage implementation",
      kind: "open_source" as const,
      createdAt: now,
      updatedAt: now,
    };

    const template = encodeProjectEvent(project);
    expect(template.kind).toBe(NOSTR_KIND_PROJECT);
    expect(template.content).toBe(project.description);

    const decoded = decodeProjectEvent(template);
    expect(decoded).toEqual(project);
  });

  it("stores project resources as ordered resource tags", () => {
    const now = toTimestamp(new Date());
    const project = {
      id: defaultIdGenerator(),
      name: "Linked",
      description: "",
      kind: "hobby" as const,
      createdAt: now,
      updatedAt: now,
      resources: [
        { type: "repository" as const, label: "GitHub", url: "https://github.com/acme/bitig" },
        { type: "design" as const, label: "Figma", url: "https://www.figma.com/design/abc" },
      ],
    };

    const template = encodeProjectEvent(project);
    expect(template.tags.filter((tag) => tag[0] === "resource")).toEqual([
      ["resource", "https://github.com/acme/bitig", "repository", "GitHub"],
      ["resource", "https://www.figma.com/design/abc", "design", "Figma"],
    ]);
    expect(decodeProjectEvent(template)).toEqual(project);
  });

  it("stores the project key and task number as tags", async () => {
    const pubkey = await signer.getPublicKey();
    const now = toTimestamp(new Date());
    const project = {
      id: defaultIdGenerator(),
      name: "Keyed",
      description: "",
      kind: "hobby" as const,
      createdAt: now,
      updatedAt: now,
      key: "KEY",
    };
    const projectTemplate = encodeProjectEvent(project);
    expect(projectTemplate.tags).toContainEqual(["key", "KEY"]);
    expect(decodeProjectEvent(projectTemplate)).toEqual(project);

    const task = {
      id: defaultIdGenerator(),
      projectId: project.id,
      title: "Numbered",
      description: "",
      status: "todo" as const,
      isPublic: false,
      createdAt: now,
      updatedAt: now,
      number: 12,
    };
    const taskTemplate = await encodeTaskEvent(task, pubkey, signer);
    expect(taskTemplate.tags).toContainEqual(["number", "12"]);
    expect(await decodeTaskEvent(taskTemplate, pubkey, signer)).toEqual(task);
  });

  it("encodes and decodes a public Task in cleartext JSON", async () => {
    const pubkey = await signer.getPublicKey();
    const now = toTimestamp(new Date());
    const task = {
      id: defaultIdGenerator(),
      projectId: defaultIdGenerator(),
      title: "Public announcement",
      description: "Visible to everyone on relays",
      status: "todo" as const,
      isPublic: true,
      dueDate: "2026-12-31",
      priority: "high" as const,
      labels: ["release", "nostr"],
      order: 1.5,
      createdAt: now,
      updatedAt: now,
    };

    const template = await encodeTaskEvent(task, pubkey, signer);
    expect(template.kind).toBe(NOSTR_KIND_TASK);

    // Payload must be cleartext JSON
    const parsed = JSON.parse(template.content) as { title: string; description: string };
    expect(parsed.title).toBe(task.title);
    expect(parsed.description).toBe(task.description);

    const decoded = await decodeTaskEvent(template, pubkey, signer);
    expect(decoded).toEqual(task);
  });

  it("encodes a private Task with NIP-44 encryption", async () => {
    const pubkey = await signer.getPublicKey();
    const now = toTimestamp(new Date());
    const task = {
      id: defaultIdGenerator(),
      projectId: defaultIdGenerator(),
      title: "Secret Task",
      description: "Sensitive notes",
      status: "in_progress" as const,
      isPublic: false,
      priority: "urgent" as const,
      checklist: [{ text: "Hidden subtask", done: false }],
      createdAt: now,
      updatedAt: now,
    };

    const template = await encodeTaskEvent(task, pubkey, signer);
    expect(template.kind).toBe(NOSTR_KIND_TASK);

    // Content must NOT contain the title, description or checklist in cleartext
    expect(template.content).not.toContain("Secret Task");
    expect(template.content).not.toContain("Sensitive notes");
    expect(template.content).not.toContain("Hidden subtask");
    expect(JSON.stringify(template.tags)).not.toContain("Hidden subtask");

    // Decodes cleanly with signer
    const decoded = await decodeTaskEvent(template, pubkey, signer);
    expect(decoded).toEqual(task);
  });
});

