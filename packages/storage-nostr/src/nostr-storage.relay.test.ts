/**
 * Runs against a real relay instead of the in-process mock. Skipped unless
 * BITIG_NOSTR_RELAY_URL is set; `make test-nostr-relay` starts `nak serve`
 * and sets it. Every storage instance gets a fresh key, so runs sharing one
 * relay never see each other's events.
 */
import { runStorageContractSuite, type TestRuntime } from "@bitig/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOSTR_KIND_DELETE, NOSTR_KIND_PROJECT, NOSTR_KIND_TASK, NOSTR_TAG_A, NOSTR_TAG_D } from "./kinds";
import { NostrStorage } from "./nostr-storage";
import { RelayManager } from "./pool/relay-manager";
import { PrivateKeySigner } from "./signer/private-key-signer";

const RELAY_URL = process.env.BITIG_NOSTR_RELAY_URL ?? "";
const RELAY_CONFIGURED = RELAY_URL !== "";

describe.skipIf(!RELAY_CONFIGURED)("NostrStorage against a real relay", () => {
  runStorageContractSuite("NostrStorage (real relay)", (runtime: TestRuntime) => {
    const storage = new NostrStorage({
      signer: new PrivateKeySigner(),
      relays: [RELAY_URL],
      deps: runtime,
    });

    return Promise.resolve({
      storage,
      dispose: () => {
        storage.getRelayManager().close();
      },
    });
  });

  describe("wire format on the relay", () => {
    let signer: PrivateKeySigner;
    let pubkey: string;
    let storage: NostrStorage;
    /** Independent connection, so assertions read what the relay stored, not the adapter's cache. */
    let observer: RelayManager;

    beforeEach(async () => {
      signer = new PrivateKeySigner();
      pubkey = await signer.getPublicKey();
      storage = new NostrStorage({ signer, relays: [RELAY_URL] });
      observer = new RelayManager({ relays: [RELAY_URL] });
    });

    afterEach(() => {
      storage.getRelayManager().close();
      observer.close();
    });

    function dTag(tags: readonly string[][]): string | undefined {
      return tags.find((tag) => tag[0] === NOSTR_TAG_D)?.[1];
    }

    it("publishes projects as kind 30331 and tasks as kind 30332", async () => {
      const project = await storage.createProject({ name: "Relay Project" });
      const task = await storage.saveTask({ projectId: project.id, title: "Relay Task", isPublic: true });

      const projectEvents = await observer.queryEvents({ kinds: [NOSTR_KIND_PROJECT], authors: [pubkey] });
      const taskEvents = await observer.queryEvents({ kinds: [NOSTR_KIND_TASK], authors: [pubkey] });

      expect(projectEvents.map((e) => dTag(e.tags))).toEqual([project.id]);
      expect(taskEvents.map((e) => dTag(e.tags))).toEqual([task.id]);
    });

    it("stores private task content NIP-44 encrypted to the author", async () => {
      const project = await storage.createProject({ name: "Private Project" });
      const task = await storage.saveTask({
        projectId: project.id,
        title: "Classified Relay Task",
        description: "Confidential relay description",
        isPublic: false,
      });

      const [event] = await observer.queryEvents({ kinds: [NOSTR_KIND_TASK], authors: [pubkey], "#d": [task.id] });

      expect(event).toBeDefined();
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain("Classified Relay Task");
      expect(serialized).not.toContain("Confidential relay description");

      const plaintext = await signer.nip44Decrypt(pubkey, event?.content ?? "");
      expect(JSON.parse(plaintext)).toMatchObject({
        title: "Classified Relay Task",
        description: "Confidential relay description",
      });
    });

    it("publishes NIP-09 deletions that hide deleted entities from a fresh client", async () => {
      const project = await storage.createProject({ name: "Doomed Relay Project" });
      const keptTask = await storage.saveTask({ projectId: project.id, title: "Cascaded" });
      const deletedTask = await storage.saveTask({ projectId: project.id, title: "Deleted first" });

      await storage.deleteTask(deletedTask.id);
      await storage.deleteProject(project.id);

      const deletions = await observer.queryEvents({ kinds: [NOSTR_KIND_DELETE], authors: [pubkey] });
      const deletedCoordinates = deletions.flatMap((e) =>
        e.tags.filter((tag) => tag[0] === NOSTR_TAG_A).map((tag) => tag[1]),
      );
      expect(deletedCoordinates).toEqual(
        expect.arrayContaining([
          `${String(NOSTR_KIND_TASK)}:${pubkey}:${deletedTask.id}`,
          `${String(NOSTR_KIND_PROJECT)}:${pubkey}:${project.id}`,
          `${String(NOSTR_KIND_TASK)}:${pubkey}:${keptTask.id}`,
        ]),
      );

      const freshClient = new NostrStorage({ signer, relays: [RELAY_URL] });
      try {
        expect(await freshClient.getProjects()).toEqual([]);
        expect(await freshClient.getTasks()).toEqual([]);
      } finally {
        freshClient.getRelayManager().close();
      }
    });
  });
});
