import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BITIG_SERVER_INSTRUCTIONS, registerBitigTools } from "@bitig/mcp-tools";
import { hasMinimumOrgRole } from "@bitig/core";
import { ForbiddenRoleError } from "../auth";
import type { AppEnv } from "../index";
import { launchTaskInT3, reportTaskT3GitMetadata } from "../t3/service";
import { buildServiceDeps } from "./t3";
import { handBackFinishedTaskInBackground } from "./tasks";

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

  const t3Deps = buildServiceDeps(c);
  registerBitigTools(server, storage, {
    reportT3GitMetadata: (input, signal) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "editor")) {
        throw new ForbiddenRoleError("Forbidden: editor role required to report Git metadata");
      }
      return reportTaskT3GitMetadata(t3Deps, input, signal);
    },
    fallbackActor: () => lastInitializedClientName,
    startT3Thread: (input) =>
      launchTaskInT3(t3Deps, {
        taskRef: input.taskId,
        workspaceStrategy: input.workspaceStrategy,
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        actor: input.actor,
        parentTaskRef: input.parentTaskId,
      }),
    // Resumes an umbrella task's T3 session waiting on the finished task (#BIT-141).
    onTaskFinished: (task) => handBackFinishedTaskInBackground(c, task.id),
    getUmbrellaParentTaskId: async (taskId) =>
      (await t3Deps.store.getAgentRunByTaskId(taskId).catch(() => null))?.parentTaskId,
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
