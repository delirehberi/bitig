/**
 * 'bitig mcp' command — starts the STDIO MCP server.
 */
import type { StorageProvider } from "@bitig/core";
import { BITIG_SERVER_INSTRUCTIONS, registerBitigTools } from "@bitig/mcp-tools";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Command } from "commander";

export function registerMcpCommand(program: Command, getStorage: () => Promise<StorageProvider>): void {
  program
    .command("mcp")
    .description("Start the STDIO Model Context Protocol (MCP) server")
    .action(async () => {
      // Ensure all diagnostic logs go to stderr so stdout is purely for JSON-RPC
      console.error("Starting Bitig MCP server on STDIO...");

      const storage = await getStorage();
      const server = new McpServer(
        {
          name: "bitig",
          version: "1.0.0",
        },
        {
          instructions: BITIG_SERVER_INSTRUCTIONS,
        },
      );

      registerBitigTools(server, storage);

      const transport = new StdioServerTransport();

      const shutdown = async () => {
        try {
          await server.close();
        } catch {
          // ignore
        }
      };

      process.on("SIGINT", () => {
        void shutdown().then(() => process.exit(130));
      });
      process.on("SIGTERM", () => {
        void shutdown().then(() => process.exit(143));
      });

      await server.connect(transport);
      console.error("Bitig MCP server connected and listening.");
    });
}

