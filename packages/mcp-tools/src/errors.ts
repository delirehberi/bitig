/**
 * Error formatting for MCP tool results.
 */
import { isBitigError } from "@bitig/core";

export interface McpToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function formatErrorResult(error: unknown): McpToolResult {
  if (isBitigError(error)) {
    return {
      isError: true,
      content: [{ type: "text", text: `[${error.code}] ${error.message}` }],
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  // Log unexpected errors to stderr
  console.error("Unexpected MCP tool error:", error);

  return {
    isError: true,
    content: [{ type: "text", text: `Internal error: ${message}` }],
  };
}

export function formatSuccessResult(data: unknown): McpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}
