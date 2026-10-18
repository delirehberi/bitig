import type { EventTemplate, VerifiedEvent } from "nostr-tools/pure";

/**
 * Universal Nostr signer interface.
 * Abstracts over browser extensions (NIP-07), remote bunkers (NIP-46),
 * and local private keys.
 */
export interface NostrSigner {
  /**
   * Returns the hex-encoded 32-byte public key of the signer.
   */
  getPublicKey(): Promise<string>;

  /**
   * Signs an event template and returns the verified event with id and sig.
   */
  signEvent(template: EventTemplate): Promise<VerifiedEvent>;

  /**
   * Encrypts plaintext for a recipient pubkey using NIP-44.
   * For self-encryption, recipientPubkey is equal to the signer's own pubkey.
   */
  nip44Encrypt(recipientPubkey: string, plaintext: string): Promise<string>;

  /**
   * Decrypts ciphertext from a sender pubkey using NIP-44.
   * For self-encryption, senderPubkey is equal to the signer's own pubkey.
   */
  nip44Decrypt(senderPubkey: string, ciphertext: string): Promise<string>;
}

