import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BITIG_SERVER_INSTRUCTIONS, registerBitigTools } from "@bitig/mcp-tools";
import { DEFAULT_RUN_LEVELS, ValidationError, hasMinimumOrgRole } from "@bitig/core";
import { ForbiddenRoleError } from "../auth";
import type { AppEnv } from "../index";
import { registerHostFolder, unregisterHostFolder } from "../t3/host-folders";
import {
  launchTaskInT3,
  reportTaskT3GitMetadata,
  resolveTaskRunProfileWithSelection,
  startReadyChildrenInT3,
  suggestTaskRunProfile,
} from "../t3/service";
import { buildHostFolderDeps, buildServiceDeps, requireOrgOwner } from "./t3";
import { handBackFinishedTaskInBackground, handBackNeedsHumanTaskInBackground } from "./tasks";

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
  const useD1RunProfiles = !c.get("customStorageFactory");
  registerBitigTools(server, storage, {
    reportT3GitMetadata: (input, signal) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "editor")) {
        throw new ForbiddenRoleError("Forbidden: editor role required to report Git metadata");
      }
      return reportTaskT3GitMetadata(t3Deps, input, signal);
    },
    fallbackActor: () => lastInitializedClientName,
    startT3Thread: (input) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "editor")) {
        throw new ForbiddenRoleError("Forbidden: editor role required to start a run");
      }
      return launchTaskInT3(t3Deps, {
        taskRef: input.taskId,
        workspaceStrategy: input.workspaceStrategy,
        providerInstanceId: input.providerInstanceId,
        model: input.model,
        options: input.options,
        level: input.level,
        actor: input.actor,
        parentTaskRef: input.parentTaskId,
      });
    },
    startReadyChildren: (input) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "editor")) {
        throw new ForbiddenRoleError("Forbidden: editor role required to start child runs");
      }
      return startReadyChildrenInT3(t3Deps, {
        parentTaskRef: input.parentTaskId,
        max: input.max,
        actor: input.actor ?? "mcp",
      });
    },
    registerProjectHostFolder: (input) => {
      requireOrgOwner(c);
      return registerHostFolder(
        buildHostFolderDeps(c),
        input.projectId,
        input.workspaceRoot,
        input.hostId,
      );
    },
    unregisterProjectHostFolder: (input) => {
      requireOrgOwner(c);
      return unregisterHostFolder(buildHostFolderDeps(c), input.projectId, {
        force: input.force,
      });
    },
    // Resumes an umbrella task's T3 session waiting on the finished task (#BIT-141, #BIT-189).
    onTaskFinished: (task) => handBackFinishedTaskInBackground(c, task.id),
    onTaskNeedsHuman: (task) => handBackNeedsHumanTaskInBackground(c, task.id),
    getUmbrellaParentTaskId: async (taskId) =>
      (await t3Deps.store.getAgentRunByTaskId(taskId).catch(() => null))?.parentTaskId,
    listRunLevels: async () => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "viewer")) {
        throw new ForbiddenRoleError("Forbidden: viewer role required to list run levels");
      }
      return await t3Deps.store.listRunLevels().catch(() => DEFAULT_RUN_LEVELS);
    },
    ...(useD1RunProfiles
      ? {
          getTaskRunProfileWithSelection: async (taskId) => {
            try {
              const { profile, resolved, nextLevelUp } = await resolveTaskRunProfileWithSelection(t3Deps, taskId);
              return {
                profile: profile ?? null,
                resolved,
                ...(nextLevelUp ? { nextLevelUp } : {}),
              };
            } catch {
              return {
                profile: null,
                resolved: { source: "default" as const, skipped: [] },
              };
            }
          },
          saveTaskRunProfile: async (input) => {
            if (input.level !== undefined && input.level !== null) {
              const levels = await t3Deps.store.listRunLevels();
              if (!levels.some((l) => l.key === input.level)) {
                throw new ValidationError("taskRunProfile", [
                  {
                    code: "custom",
                    path: ["runProfile", "level"],
                    message: `Run level "${input.level}" does not exist in this organisation.`,
                    input: input.level,
                  },
                ]);
              }
            }
            return await t3Deps.store.saveTaskRunProfile({
              taskId: input.taskId,
              ...(input.level !== undefined ? { level: input.level } : {}),
              ...(input.effort !== undefined ? { effort: input.effort } : {}),
              ...(input.selection !== undefined ? { selection: input.selection } : {}),
              ...(input.touches !== undefined ? { touches: input.touches } : {}),
              ...(input.parallelSafe !== undefined ? { parallelSafe: input.parallelSafe } : {}),
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              source: input.source,
              updatedBy: c.get("user")?.id ?? input.actor,
            });
          },
          suggestTaskRunProfile: async (input) => {
            const role = c.get("orgRole");
            if (!role || !hasMinimumOrgRole(role, "editor")) {
              throw new ForbiddenRoleError("Forbidden: editor role required to suggest a run profile");
            }
            return await suggestTaskRunProfile(t3Deps, input.taskId, {
              actor: c.get("user")?.id ?? input.actor,
              cache: caches.default,
              signal: input.signal,
            });
          },
        }
      : {}),
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
