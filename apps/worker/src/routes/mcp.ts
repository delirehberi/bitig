import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { BITIG_SERVER_INSTRUCTIONS, registerBitigTools } from "@bitig/mcp-tools";
import { DEFAULT_RUN_LEVELS, ValidationError, hasMinimumOrgRole } from "@bitig/core";
import { D1WorkQueueStore } from "@bitig/storage-d1";
import { ForbiddenRoleError } from "../auth";
import type { AppEnv } from "../index";
import { registerHostFolder, unregisterHostFolder } from "../t3/host-folders";
import {
  WorkQueueNothingToQueueError,
  confirmWorkQueue,
  listWorkQueues,
  planWorkQueuePrompt,
} from "../work-queue/service";
import {
  assertHierarchyMutationAllowed,
  getLegacyHierarchyInventory,
  launchTaskInT3,
  reportChildMerge,
  reportTaskT3GitMetadata,
  resolveEffectiveHierarchyMode,
  resolveTaskRunProfileWithSelection,
  startReadyChildrenInT3,
  suggestTaskRunProfile,
} from "../t3/service";
import { buildHostFolderDeps, buildServiceDeps, requireOrgOwner } from "./t3";
import { handBackFinishedTaskInBackground, handBackNeedsHumanTaskInBackground } from "./tasks";

const MCP_SERVER_NAME = "bitig";
const MCP_SERVER_VERSION = "1.0.0";
/** `queue_tasks` result reason when no listed task can be queued (#BIT-204). */
const NOTHING_TO_QUEUE_REASON = "nothing_to_queue";

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
    reportChildMerge: (input, signal) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "editor")) {
        throw new ForbiddenRoleError("Forbidden: editor role required to report a child merge");
      }
      return reportChildMerge(t3Deps, input, signal);
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
    planWorkQueue: async (input) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "viewer")) {
        throw new ForbiddenRoleError("Forbidden: viewer role required to plan a work queue");
      }
      const user = c.get("user");
      const orgId = c.get("orgId");
      if (!user || !orgId) {
        throw new ForbiddenRoleError("Forbidden: a signed-in person is required to plan a work queue");
      }
      // `route: false` guarantees `plan_work_queue` makes no writes (#BIT-204).
      return await planWorkQueuePrompt(
        { t3: t3Deps, queueStore: new D1WorkQueueStore(c.env.DB, orgId) },
        {
          prompt: input.prompt,
          ...(input.items !== undefined ? { items: input.items } : {}),
          route: false,
          actor: {
            id: user.id,
            name: user.displayName,
            ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
          },
          signal: c.req.raw.signal,
        },
      );
    },
    queueWorkTasks: async (input) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "editor")) {
        throw new ForbiddenRoleError("Forbidden: editor role required to queue tasks");
      }
      const user = c.get("user");
      const orgId = c.get("orgId");
      if (!user || !orgId) {
        throw new ForbiddenRoleError("Forbidden: a signed-in person is required to queue tasks");
      }
      // Approvals are never passed: over MCP, tasks pending approval stay out of the queue (#BIT-204).
      try {
        const result = await confirmWorkQueue(
          { t3: t3Deps, queueStore: new D1WorkQueueStore(c.env.DB, orgId) },
          {
            prompt: input.prompt,
            items: input.items,
            approvals: [],
            overrides: [],
            actor: {
              id: user.id,
              name: user.displayName,
              ...(user.avatarUrl !== undefined ? { avatarUrl: user.avatarUrl } : {}),
            },
          },
        );
        return { queued: true, ...result };
      } catch (error: unknown) {
        if (error instanceof WorkQueueNothingToQueueError) {
          return { queued: false, reason: NOTHING_TO_QUEUE_REASON, message: error.message, plan: error.plan };
        }
        throw error;
      }
    },
    listWorkQueues: async (input) => {
      const role = c.get("orgRole");
      if (!role || !hasMinimumOrgRole(role, "viewer")) {
        throw new ForbiddenRoleError("Forbidden: viewer role required to list work queues");
      }
      const orgId = c.get("orgId");
      if (!orgId) {
        throw new ForbiddenRoleError("Forbidden: an organisation is required to list work queues");
      }
      return await listWorkQueues(
        { t3: t3Deps, queueStore: new D1WorkQueueStore(c.env.DB, orgId) },
        { includeClosed: input.includeClosed },
      );
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
    hierarchyMode: t3Deps.hierarchyMode,
    isLegacyHierarchyParent: async (parentTaskId) => {
      const run = await t3Deps.store.getAgentRunByTaskId(parentTaskId).catch(() => null);
      return resolveEffectiveHierarchyMode(t3Deps, run) === "legacy";
    },
    getUmbrellaParentTaskId: async (taskId) => {
      const run = await t3Deps.store.getAgentRunByTaskId(taskId).catch(() => null);
      if (!run?.parentTaskId) return undefined;
      return resolveEffectiveHierarchyMode(t3Deps, run) === "legacy" ? run.parentTaskId : undefined;
    },
    assertHierarchyMutationAllowed: (input) => assertHierarchyMutationAllowed(t3Deps, input),
    listLegacyHierarchyInventory: (input) => getLegacyHierarchyInventory(t3Deps, input),
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
