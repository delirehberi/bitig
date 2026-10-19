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

