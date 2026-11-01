const IV_BYTE_LENGTH = 12;
const PKCE_VERIFIER_BYTE_LENGTH = 32;
const OAUTH_STATE_BYTE_LENGTH = 32;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(encoded: string): Uint8Array<ArrayBuffer> {
  const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const paddingLength = (4 - (base64.length % 4)) % 4;
  const padded = base64 + "=".repeat(paddingLength);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function importEncryptionKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length < 32) {
    throw new Error("T3_ENCRYPTION_KEY is not configured or is shorter than 32 characters");
  }
  const rawMaterial = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", rawMaterial);
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export interface EncryptedToken {
  ciphertext: string;
  iv: string;
}

/**
 * Encrypts a T3 OAuth bearer token using AES-256-GCM with a fresh 96-bit IV.
 */
export async function encryptT3Token(plaintext: string, secret: string): Promise<EncryptedToken> {
  const key = await importEncryptionKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTE_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);
  const encryptedBuffer = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return {
    ciphertext: toBase64Url(new Uint8Array(encryptedBuffer)),
    iv: toBase64Url(iv),
  };
}

/**
 * Decrypts a T3 OAuth bearer token encrypted by `encryptT3Token`.
 */
export async function decryptT3Token(encrypted: EncryptedToken, secret: string): Promise<string> {
  const key = await importEncryptionKey(secret);
  const iv = fromBase64Url(encrypted.iv);
  const ciphertext = fromBase64Url(encrypted.ciphertext);
  const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(decryptedBuffer);
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/**
 * Generates an RFC 7636 S256 PKCE verifier and challenge pair.
 */
export async function generatePkcePair(): Promise<PkcePair> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(PKCE_VERIFIER_BYTE_LENGTH));
  const codeVerifier = toBase64Url(verifierBytes);
  const challengeDigest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = toBase64Url(new Uint8Array(challengeDigest));
  return { codeVerifier, codeChallenge };
}

/**
 * Generates a 256-bit random OAuth state token.
 */
export function generateOauthState(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(OAUTH_STATE_BYTE_LENGTH)));
}
