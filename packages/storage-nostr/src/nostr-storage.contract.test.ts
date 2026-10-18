import { runStorageContractSuite, type TestRuntime } from "@bitig/core/testing";
import { NostrStorage } from "./nostr-storage";
import { PrivateKeySigner } from "./signer/private-key-signer";
import { startMockRelay, type MockRelay } from "./testing/mock-relay";

runStorageContractSuite("NostrStorage", async (runtime: TestRuntime) => {
  const relay: MockRelay = await startMockRelay();
  const signer = new PrivateKeySigner();

  const storage = new NostrStorage({
    signer,
    relays: [relay.url],
    deps: runtime,
  });

  return {
    storage,
    dispose: async () => {
      storage.getRelayManager().close();
      await relay.close();
    },
  };
});

