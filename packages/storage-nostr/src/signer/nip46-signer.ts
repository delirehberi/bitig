import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import { generateSecretKey } from "nostr-tools/pure";
import { BunkerSigner, parseBunkerInput, type BunkerPointer } from "nostr-tools/nip46";
import type { NostrSigner } from "./signer";

export interface Nip46SignerOptions {
  clientSecretKey?: Uint8Array;
  onAuthUrl?: (url: string) => void;
}

export class Nip46Signer implements NostrSigner {
  private bunkerSigner: BunkerSigner | undefined = undefined;
  private readonly clientSecretKey: Uint8Array;
  private readonly pointerPromise: Promise<BunkerPointer>;

  constructor(
    bunkerInput: string | BunkerPointer,
    private readonly options: Nip46SignerOptions = {},
  ) {
    this.clientSecretKey = options.clientSecretKey ?? generateSecretKey();
    if (typeof bunkerInput === "string") {
      this.pointerPromise = (async () => {
        const parsed = await parseBunkerInput(bunkerInput);
        if (!parsed) {
          throw new Error(`Invalid NIP-46 bunker connection string: ${bunkerInput}`);
        }
        return parsed;
      })();
    } else {
      this.pointerPromise = Promise.resolve(bunkerInput);
    }
  }

  private async getBunker(): Promise<BunkerSigner> {
    if (!this.bunkerSigner) {
      const pointer = await this.pointerPromise;
      const params = this.options.onAuthUrl ? { onauth: this.options.onAuthUrl } : undefined;
      const signer = BunkerSigner.fromBunker(this.clientSecretKey, pointer, params);
      await signer.connect();
      this.bunkerSigner = signer;
    }
    return this.bunkerSigner;
  }

  async getPublicKey(): Promise<string> {
    const bunker = await this.getBunker();
    return bunker.getPublicKey();
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const bunker = await this.getBunker();
    return bunker.signEvent(template);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const bunker = await this.getBunker();
    return bunker.nip44Encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const bunker = await this.getBunker();
    return bunker.nip44Decrypt(senderPubkey, ciphertext);
  }

  async close(): Promise<void> {
    if (this.bunkerSigner) {
      await this.bunkerSigner.close();
      this.bunkerSigner = undefined;
    }
  }
}
