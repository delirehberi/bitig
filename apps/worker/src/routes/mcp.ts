import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BITIG_SERVER_INSTRUCTIONS, registerBitigTools } from "@bitig/mcp-tools";
import { T3D1Store } from "@bitig/storage-d1";
import type { AppEnv } from "../index";
import { publishRealtimeEvent } from "../realtime";
import { launchTaskInT3 } from "../t3/service";

const MCP_SERVER_NAME = "bitig";
const MCP_SERVER_VERSION = "1.0.0";

let lastInitializedClientName: string | undefined;

export const mcpRouter = new Hono<AppEnv>().all("*", async (c) => {
  const storage = c.get("storage");
  const server = new McpServer(
    {
      name: MCP_SERVER_NAME,
      version: MCP_SERVER_VERSION,
    },
    {
      instructions: BITIG_SERVER_INSTRUCTIONS,
    },
  );

  registerBitigTools(server, storage, {
    fallbackActor: () => lastInitializedClientName,
    startT3Thread: (input) =>
      launchTaskInT3(
        {
          store: new T3D1Store(c.env.DB),
          storage,
          encryptionKey: c.get("config").T3_ENCRYPTION_KEY,
          fetchFn: c.get("t3Fetch"),
          publishRealtime: (event) => publishRealtimeEvent(c.env, event),
        },
        {
          taskRef: input.taskId,
          workspaceStrategy: input.workspaceStrategy,
          providerInstanceId: input.providerInstanceId,
          model: input.model,
          actor: input.actor,
        },
      ),
  });

  // Stateless mode: session management is disabled when sessionIdGenerator is omitted
  const transport = new WebStandardStreamableHTTPServerTransport();

  await server.connect(transport);

  const response = await transport.handleRequest(c.req.raw);
  const initializedClientName = server.server.getClientVersion()?.name.trim();
  if (initializedClientName) {
    lastInitializedClientName = initializedClientName;
  }
  return response;
});
