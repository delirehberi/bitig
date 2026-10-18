import { finalizeEvent, generateSecretKey, getPublicKey, type EventTemplate, type VerifiedEvent } from "nostr-tools/pure";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrSigner } from "./signer";

export class PrivateKeySigner implements NostrSigner {
  private readonly secretKey: Uint8Array;
  private readonly publicKey: string;
  private readonly conversationKeys = new Map<string, Uint8Array>();

  constructor(secretKey?: Uint8Array) {
    this.secretKey = secretKey ?? generateSecretKey();
    this.publicKey = getPublicKey(this.secretKey);
  }

  getPublicKey(): Promise<string> {
    return Promise.resolve(this.publicKey);
  }

  signEvent(template: EventTemplate): Promise<VerifiedEvent> {
    const event = finalizeEvent(template, this.secretKey);
    return Promise.resolve(event);
  }

  private getSharedKey(peerPubkey: string): Uint8Array {
    let key = this.conversationKeys.get(peerPubkey);
    if (!key) {
      key = getConversationKey(this.secretKey, peerPubkey);
      this.conversationKeys.set(peerPubkey, key);
    }
    return key;
  }

  nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string> {
    const key = this.getSharedKey(recipientPubkey);
    const ciphertext = encrypt(plaintext, key);
    return Promise.resolve(ciphertext);
  }

  nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string> {
    const key = this.getSharedKey(senderPubkey);
    const plaintext = decrypt(ciphertext, key);
    return Promise.resolve(plaintext);
  }

  getRawSecretKey(): Uint8Array {
    return this.secretKey;
  }
}

