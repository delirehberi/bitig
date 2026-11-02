const TOKEN_BYTE_LENGTH = 32;
const HEX_RADIX = 16;
const HEX_BYTE_WIDTH = 2;
const TOKEN_PREFIX = "bitig_mcp_";
export const MANAGED_MCP_TOKEN_PATTERN = /^bitig_mcp_[0-9a-f]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(HEX_RADIX).padStart(HEX_BYTE_WIDTH, "0")).join("");
}

export function generateMcpToken(): string {
  return TOKEN_PREFIX + toHex(crypto.getRandomValues(new Uint8Array(TOKEN_BYTE_LENGTH)));
}

export async function digestMcpToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}
