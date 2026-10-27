import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NOSTR_KIND_CHECKPOINT,
  NOSTR_KIND_COMMENT,
  NOSTR_KIND_DELETE,
  NOSTR_KIND_PROJECT,
  NOSTR_KIND_TASK,
  NOSTR_TAG_A,
  NOSTR_TAG_D,
} from "./kinds";
import { NostrStorage } from "./nostr-storage";
import { PrivateKeySigner } from "./signer/private-key-signer";
import { startMockRelay, type MockRelay } from "./testing/mock-relay";

describe("NostrStorage extra & wire-level verification", () => {
  let relay: MockRelay;
  let signer: PrivateKeySigner;
  let storage: NostrStorage;

  beforeEach(async () => {
    relay = await startMockRelay();
    signer = new PrivateKeySigner();
    storage = new NostrStorage({
      signer,
      relays: [relay.url],
    });
  });

  afterEach(async () => {
    storage.getRelayManager().close();
    await relay.close();
  });

  it("ensures private tasks never leak title or description in wire events", async () => {
    const project = await storage.createProject({ name: "Secret Ops" });
    const task = await storage.saveTask({
      projectId: project.id,
      title: "Classified Mission Alpha",
      description: "Extremely confidential blueprint",
      isPublic: false,
    });

    const events = relay.getEvents();
    const taskEvent = events.find((e) => e.kind === NOSTR_KIND_TASK);

    expect(taskEvent).toBeDefined();
    // Verify ciphertext in content
    expect(taskEvent?.content).not.toContain("Classified Mission Alpha");
    expect(taskEvent?.content).not.toContain("Extremely confidential blueprint");

    // Verify tags do not leak title or description
    for (const tag of taskEvent?.tags ?? []) {
      for (const val of tag) {
        expect(val).not.toContain("Classified Mission Alpha");
        expect(val).not.toContain("Extremely confidential blueprint");
      }
    }

    // But reading it back through NostrStorage decrypts it correctly
    const readBack = await storage.getTask(task.id);
    expect(readBack?.title).toBe("Classified Mission Alpha");
    expect(readBack?.description).toBe("Extremely confidential blueprint");
  });

  it("encrypts comments, even on public tasks, and reads them back from relays", async () => {
    const project = await storage.createProject({ name: "Open" });
    const task = await storage.saveTask({ projectId: project.id, title: "Public", isPublic: true });
    const comment = await storage.addComment({
      taskId: task.id,
      body: "The staging key is in the vault",
      authorType: "agent",
      author: "claude",
    });

    const event = relay.getEvents().find((e) => e.kind === NOSTR_KIND_COMMENT);
    expect(event?.tags).toContainEqual(["task", task.id]);
    expect(event?.tags).toContainEqual(["author_type", "agent"]);
    expect(JSON.stringify(event)).not.toContain("staging key");
    expect(JSON.stringify(event)).not.toContain("claude");

    const fresh = new NostrStorage({ signer, relays: [relay.url] });
    try {
      expect(await fresh.getComments(task.id)).toEqual([comment]);
      await fresh.deleteTask(task.id);
    } finally {
      fresh.getRelayManager().close();
    }

    const deletion = relay.getEvents().find((e) => e.kind === NOSTR_KIND_DELETE);
    const pubkey = await signer.getPublicKey();
    expect(deletion?.tags).toContainEqual([NOSTR_TAG_A, `${String(NOSTR_KIND_COMMENT)}:${pubkey}:${comment.id}`]);
  });

  it("encrypts checkpoints, even on public tasks, and a re-saved step supersedes its earlier event", async () => {
    const project = await storage.createProject({ name: "Open" });
    const task = await storage.saveTask({ projectId: project.id, title: "Public", isPublic: true });
    const snapshot = (summary: string) => ({
      summary,
      modifiedArtifacts: ["secret/path.ts"],
      decisionsMade: ["rotate the vault token"],
      nextStepInstructions: "Call the internal admin API",
    });
    const first = await storage.saveCheckpoint({
      taskId: task.id, stepIndex: 7, status: "WAITING_HUMAN_APPROVAL", stateSnapshot: snapshot("first draft"),
    });
    const second = await storage.saveCheckpoint({
      taskId: task.id, stepIndex: 7, status: "COMPLETED", stateSnapshot: snapshot("final draft"),
    });
    expect(second.id).toBe(first.id);

    const events = relay.getEvents().filter((e) => e.kind === NOSTR_KIND_CHECKPOINT);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const wire = JSON.stringify(event);
      for (const secret of ["draft", "secret/path.ts", "vault token", "admin API", "WAITING_HUMAN_APPROVAL", "COMPLETED"]) {
        expect(wire).not.toContain(secret);
      }
      expect(event.tags).toContainEqual(["task", task.id]);
      expect(event.tags.some((tag) => tag[0] === "step" || tag[0] === "status")).toBe(false);
    }
    // Same `d` tag, strictly later event time: a relay keeps only the newest.
    expect(new Set(events.map((e) => e.tags.find((t) => t[0] === NOSTR_TAG_D)?.[1])).size).toBe(1);
    expect(new Set(events.map((e) => e.created_at)).size).toBe(events.length);

    const fresh = new NostrStorage({ signer, relays: [relay.url] });
    try {
      expect(await fresh.getCheckpoints(task.id)).toEqual([second]);
      await fresh.deleteTask(task.id);
    } finally {
      fresh.getRelayManager().close();
    }

    const deletion = relay.getEvents().find((e) => e.kind === NOSTR_KIND_DELETE);
    const pubkey = await signer.getPublicKey();
    expect(deletion?.tags).toContainEqual([NOSTR_TAG_A, `${String(NOSTR_KIND_CHECKPOINT)}:${pubkey}:${first.id}`]);
  });

  it("publishes cleartext JSON for public tasks", async () => {
    const project = await storage.createProject({ name: "Public Road" });
    const task = await storage.saveTask({
      projectId: project.id,
      title: "Public Roadmap Item",
      description: "Open community notes",
      isPublic: true,
    });

    const events = relay.getEvents();
    const taskEvent = events.find(
      (e) => e.kind === NOSTR_KIND_TASK && e.tags.some((t) => t[0] === NOSTR_TAG_D && t[1] === task.id),
    );

    expect(taskEvent).toBeDefined();
    const parsed = JSON.parse(taskEvent?.content ?? "{}") as { title: string; description: string };
    expect(parsed.title).toBe("Public Roadmap Item");
    expect(parsed.description).toBe("Open community notes");
  });

  it("publishes NIP-09 deletion events covering project and child tasks on cascade delete", async () => {
    const project = await storage.createProject({ name: "Doomed Project" });
    const task1 = await storage.saveTask({ projectId: project.id, title: "Task 1" });
    const task2 = await storage.saveTask({ projectId: project.id, title: "Task 2" });

    await storage.deleteProject(project.id);

    const pubkey = await signer.getPublicKey();
    const events = relay.getEvents();
    const deleteEvent = events.find((e) => e.kind === NOSTR_KIND_DELETE);

    expect(deleteEvent).toBeDefined();
    const aTags = deleteEvent?.tags.filter((t) => t[0] === NOSTR_TAG_A).map((t) => t[1]);

    expect(aTags).toContain(`${String(NOSTR_KIND_PROJECT)}:${pubkey}:${project.id}`);
    expect(aTags).toContain(`${String(NOSTR_KIND_TASK)}:${pubkey}:${task1.id}`);
    expect(aTags).toContain(`${String(NOSTR_KIND_TASK)}:${pubkey}:${task2.id}`);
  });

  it("keeps a private task's dependencies encrypted and drops a deleted dependency on relays", async () => {
    const project = await storage.createProject({ name: "Deps" });
    const blocker = await storage.saveTask({ projectId: project.id, title: "Blocker", isPublic: true });
    const waiting = await storage.saveTask({
      projectId: project.id,
      title: "Waiting",
      isPublic: false,
      dependsOn: [blocker.id],
    });

    const waitingEvent = relay
      .getEvents()
      .find((e) => e.kind === NOSTR_KIND_TASK && e.tags.some((t) => t[0] === NOSTR_TAG_D && t[1] === waiting.id));
    expect(JSON.stringify(waitingEvent)).not.toContain(blocker.id);

    // The cleanup keeps updatedAt, so it must still win over the original event on a fresh read.
    await storage.deleteTask(blocker.id);
    const fresh = new NostrStorage({ signer, relays: [relay.url] });
    try {
      const read = await fresh.getTask(waiting.id);
      expect(read).not.toHaveProperty("dependsOn");
      expect(read).toEqual({ ...waiting, dependsOn: undefined });
    } finally {
      fresh.getRelayManager().close();
    }
  });
});
