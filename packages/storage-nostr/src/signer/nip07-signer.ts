import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";
import type { NostrSigner } from "./signer";

export interface Nip07WindowNostr {
  getPublicKey(): Promise<string>;
  signEvent(event: EventTemplate): Promise<VerifiedEvent>;
  nip44?: {
    encrypt(pubkey: string, plaintext: string): Promise<string>;
    decrypt(pubkey: string, ciphertext: string): Promise<string>;
  };
}

interface GlobalWithNostr {
  nostr?: Nip07WindowNostr;
  window?: {
    nostr?: Nip07WindowNostr;
  };
}

export class Nip07Signer implements NostrSigner {
  private cachedPubkey?: string;

  constructor(private readonly provider?: Nip07WindowNostr) {}

  private getProvider(): Nip07WindowNostr {
    const g = globalThis as unknown as GlobalWithNostr;
    const p = this.provider ?? g.nostr ?? g.window?.nostr;
    if (!p) {
      throw new Error(
        "Nostr extension (window.nostr) not detected. Please install a NIP-07 compatible extension (e.g. Alby, nos2x).",
      );
    }
    return p;
  }

  async getPublicKey(): Promise<string> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const provider = this.getProvider();
    const pubkey = await provider.getPublicKey();
    this.cachedPubkey = pubkey;
    return pubkey;
  }

  async signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const provider = this.getProvider();
    return provider.signEvent(template);
  }

  async nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const provider = this.getProvider();
    if (!provider.nip44?.encrypt) {
      throw new Error(
        "Installed Nostr extension does not support NIP-44 encryption. Please update your extension to a NIP-44 capable version.",
      );
    }
    return provider.nip44.encrypt(recipientPubkey, plaintext);
  }

  async nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const provider = this.getProvider();
    if (!provider.nip44?.decrypt) {
      throw new Error(
        "Installed Nostr extension does not support NIP-44 decryption. Please update your extension to a NIP-44 capable version.",
      );
    }
    return provider.nip44.decrypt(senderPubkey, ciphertext);
  }
}

