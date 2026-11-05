export const ACCESS_TOKEN_PREFIX = "btg_";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateOpaqueToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function generateAccessToken(): { token: string; prefix: string } {
  const raw = generateOpaqueToken(24);
  const token = `${ACCESS_TOKEN_PREFIX}${raw}`;
  return { token, prefix: token.slice(0, 12) };
}

export function generateSixDigitCode(): string {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  const num = (array[0] ?? 0) % 1_000_000;
  return String(num).padStart(6, "0");
}
