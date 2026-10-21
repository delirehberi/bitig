import { InMemoryStorage } from "@bitig/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerBitigTools, resolveMcpActor } from "./register";

describe("MCP Tools integration", () => {
  let storage: InMemoryStorage;
  let server: McpServer;
  let client: Client;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    server = new McpServer({ name: "bitig-test", version: "1.0.0" });
    registerBitigTools(server, storage);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: "client-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("lists tools and executes project and task lifecycles", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_projects",
      "create_project",
      "update_project",
      "delete_project",
      "list_tasks",
      "get_task",
      "add_task",
      "update_task",
      "complete_task",
      "delete_task",
      "backfill_ticket_codes",
      "list_comments",
      "add_comment",
      "delete_comment",
      "list_webhooks",
      "create_webhook",
      "update_webhook",
      "delete_webhook",
    ]);

    // Create project
    const createProjResult = await client.callTool({
      name: "create_project",
      arguments: { name: "Test Project", kind: "hobby" },
    });
    expect(createProjResult.isError).toBeFalsy();
    const projData = JSON.parse((createProjResult.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      bitig_file_content: string;
    };
    expect(projData.id).toBeDefined();
    expect(projData.bitig_file_content).toContain(`project_id: ${projData.id}`);

    // Add task
    const addTaskResult = await client.callTool({
      name: "add_task",
      arguments: {
        projectId: projData.id,
        title: "Test Task",
        priority: "high",
        dueDate: "2026-10-20",
      },
    });
    expect(addTaskResult.isError).toBeFalsy();
    const taskData = JSON.parse((addTaskResult.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      title: string;
      status: string;
    };
    expect(taskData.title).toBe("Test Task");
    expect(taskData.status).toBe("todo");
    await approve(taskData.id);

    // Complete task
    const completeResult = await client.callTool({
      name: "complete_task",
      arguments: { id: taskData.id },
    });
    expect(completeResult.isError).toBeFalsy();
    const completedData = JSON.parse((completeResult.content as { text: string }[])[0]?.text ?? "{}") as {
      status: string;
    };
    expect(completedData.status).toBe("done");

    // List tasks
    const listTasksResult = await client.callTool({
      name: "list_tasks",
      arguments: { projectId: projData.id },
    });
    const tasksList = JSON.parse((listTasksResult.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
    }[];
    expect(tasksList).toHaveLength(1);

    // Delete task
    const delTaskResult = await client.callTool({
      name: "delete_task",
      arguments: { id: taskData.id },
    });
    expect(delTaskResult.isError).toBeFalsy();

    // Verify task is gone
    const getTaskResult = await client.callTool({
      name: "get_task",
      arguments: { id: taskData.id },
    });
    expect(getTaskResult.isError).toBe(true);
  });

  /** Calls a tool; `data` is the parsed JSON result, or the error text when the call failed. */
  async function call(name: string, args: Record<string, unknown>): Promise<{ data: unknown; isError: boolean }> {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[])[0]?.text ?? "null";
    const data: unknown = result.isError ? text : JSON.parse(text);
    return { data, isError: result.isError === true };
  }

  interface TaskResult {
    id: string;
    code: string;
    title: string;
    status: string;
  }

  async function task(name: string, args: Record<string, unknown>): Promise<TaskResult> {
    const { data, isError } = await call(name, args);
    expect(isError).toBe(false);
    return data as TaskResult;
  }

  /** What a person does in the web UI or CLI; agents have no MCP tool for it. */
  async function approve(id: string): Promise<void> {
    await storage.updateTask(id, { pendingApproval: null });
  }

  it("creates tasks awaiting approval and refuses to start or complete them until a person approves", async () => {
    await call("create_project", { name: "Bitig", key: "BIT" });
    const created = (await call("add_task", { projectId: "BIT", title: "Agent idea" })).data as TaskResult & {
      pendingApproval?: true;
    };
    expect(created.pendingApproval).toBe(true);

    // An agent cannot opt out at creation or approve through update_task
    const optedOut = (await call("add_task", { projectId: "BIT", title: "Sneaky", pendingApproval: false }))
      .data as { pendingApproval?: true };
    expect(optedOut.pendingApproval).toBe(true);
    await call("update_task", { id: "BIT-1", pendingApproval: null });
    expect((await storage.getTask(created.id))?.pendingApproval).toBe(true);

    for (const status of ["in_progress", "done"]) {
      const refused = await call("update_task", { id: "BIT-1", status });
      expect(refused.isError).toBe(true);
      expect(refused.data).toContain("awaiting human approval");
    }
    const refusedComplete = await call("complete_task", { id: "BIT-1" });
    expect(refusedComplete.isError).toBe(true);
    expect(refusedComplete.data).toContain("awaiting human approval");
    expect((await storage.getTask(created.id))?.status).toBe("todo");

    // Edits other than starting or completing still work
    expect((await task("update_task", { id: "BIT-1", title: "Agent idea, refined" })).title).toBe(
      "Agent idea, refined",
    );

    const pending = (await call("list_tasks", { projectId: "BIT", pendingApproval: true })).data as TaskResult[];
    expect(pending.map((t) => t.code)).toEqual(["BIT-1", "BIT-2"]);

    await approve(created.id);
    const approvedList = (await call("list_tasks", { pendingApproval: false })).data as TaskResult[];
    expect(approvedList.map((t) => t.code)).toEqual(["BIT-1"]);
    expect((await task("update_task", { id: "BIT-1", status: "in_progress" })).status).toBe("in_progress");
    expect((await task("complete_task", { id: "BIT-1" })).status).toBe("done");
  });

  it("refuses to start or complete a blocked task until its dependencies are done or archived", async () => {
    const project = (await call("create_project", { name: "Bitig", key: "BIT" })).data as { id: string };
    const other = (await call("create_project", { name: "Other", key: "OTH" })).data as { id: string };
    // add_task does not take dependsOn yet, and its tasks need approval: set them up as a person would
    const first = await storage.saveTask({ projectId: project.id, title: "Schema" });
    const elsewhere = await storage.saveTask({ projectId: other.id, title: "Elsewhere" });
    const blocked = await storage.saveTask({
      projectId: project.id,
      title: "Signup",
      dependsOn: [first.id, elsewhere.id],
    });

    for (const status of ["in_progress", "done"]) {
      const refused = await call("update_task", { id: "BIT-2", status });
      expect(refused.isError).toBe(true);
      expect(refused.data).toContain("blocked by unfinished dependencies: BIT-1, OTH-1");
    }
    const refusedComplete = await call("complete_task", { id: "BIT-2" });
    expect(refusedComplete.isError).toBe(true);
    expect(refusedComplete.data).toContain("BIT-1, OTH-1");
    expect((await storage.getTask(blocked.id))?.status).toBe("todo");

    // Agents see why, and can find the tasks that are free to start
    expect(await task("get_task", { id: "BIT-2" })).toMatchObject({ blockedBy: ["BIT-1", "OTH-1"] });
    const blockedList = (await call("list_tasks", { blocked: true })).data as TaskResult[];
    expect(blockedList.map((t) => t.code)).toEqual(["BIT-2"]);
    expect(blockedList[0]).toMatchObject({ blockedBy: ["BIT-1", "OTH-1"] });
    const free = (await call("list_tasks", { projectId: "BIT", blocked: false })).data as TaskResult[];
    expect(free.map((t) => t.code)).toEqual(["BIT-1"]);
    expect(free[0]).not.toHaveProperty("blockedBy");

    // Other edits still work, and done or archived dependencies stop blocking
    expect((await task("update_task", { id: "BIT-2", title: "Signup flow" })).title).toBe("Signup flow");
    expect(await task("complete_task", { id: "BIT-1" })).not.toHaveProperty("blockedBy");
    expect(await task("get_task", { id: "BIT-2" })).toMatchObject({ blockedBy: ["OTH-1"] });
    await task("update_task", { id: "OTH-1", status: "archived" });
    const started = await task("update_task", { id: "BIT-2", status: "in_progress" });
    expect(started.status).toBe("in_progress");
    expect(started).not.toHaveProperty("blockedBy");
    expect((await task("complete_task", { id: "BIT-2" })).status).toBe("done");
  });

  it("names tasks by ticket code and accepts codes and keys in place of IDs", async () => {
    const project = (await call("create_project", { name: "Bitig" })).data as { id: string; key: string };
    expect(project.key).toBe("BIT");

    const first = await task("add_task", { projectId: "bit", title: "One" });
    const second = await task("add_task", { projectId: project.id, title: "Two" });
    expect([first.code, second.code]).toEqual(["BIT-1", "BIT-2"]);

    expect((await task("get_task", { id: "bit-2" })).id).toBe(second.id);
    expect((await task("update_task", { id: "BIT-1", title: "Uno" })).title).toBe("Uno");
    await approve(first.id);
    expect((await task("complete_task", { id: "BIT-1" })).status).toBe("done");
    const listed = (await call("list_tasks", { projectId: "BIT" })).data as TaskResult[];
    expect(listed.map((t) => t.code)).toEqual(["BIT-1", "BIT-2"]);

    const renamed = (await call("update_project", { id: project.id, key: "bt" })).data as { key: string };
    expect(renamed.key).toBe("BT");
    expect((await task("get_task", { id: "BT-2" })).code).toBe("BT-2");

    const missing = await call("get_task", { id: "BIT-2" });
    expect(missing.isError).toBe(true);
    expect(missing.data).toContain("NOT_FOUND");
    expect((await call("get_task", { id: "nonsense" })).isError).toBe(true);

    const deleted = (await call("delete_task", { id: "BT-2" })).data as { deletedTaskId: string };
    expect(deleted.deletedTaskId).toBe(second.id);
  });

  it("backfills codes for projects and tasks created before them", async () => {
    await storage.importProject({
      version: 1,
      exportedAt: "2026-01-01T00:00:00.000Z",
      project: {
        id: "01940000-0000-7000-8000-0000000000a1",
        name: "Legacy",
        description: "",
        kind: "hobby",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      tasks: [
        {
          id: "01940000-0000-7000-8000-0000000000a2",
          projectId: "01940000-0000-7000-8000-0000000000a1",
          title: "Old",
          description: "",
          status: "todo",
          isPublic: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    expect((await call("backfill_ticket_codes", {})).data).toEqual({ keyedProjects: 1, numberedTasks: 1 });
    expect(((await call("list_tasks", {})).data as TaskResult[]).map((t) => t.code)).toEqual(["LEG-1"]);
    expect((await call("backfill_ticket_codes", {})).data).toEqual({ keyedProjects: 0, numberedTasks: 0 });
  });

  it("adds, lists and deletes comments by ticket code, and returns them with the task", async () => {
    const project = await storage.createProject({ name: "Bitig" });
    const task = await storage.saveTask({ projectId: project.id, title: "Needs a key" });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBeFalsy();
      return JSON.parse((result.content as { text: string }[])[0]?.text ?? "null") as unknown;
    };

    const asked = (await call("add_comment", { taskId: "BIT-1", body: "Which key?", author: "claude" })) as {
      id: string;
    };
    expect(asked).toMatchObject({ taskId: task.id, body: "Which key?", authorType: "agent", author: "claude" });
    await storage.addComment({ taskId: task.id, body: "The staging one." });

    expect(await call("list_comments", { taskId: "BIT-1" })).toMatchObject([
      { authorType: "agent" },
      { authorType: "human", body: "The staging one." },
    ]);
    expect(await call("get_task", { id: "BIT-1" })).toMatchObject({
      code: "BIT-1",
      comments: [{ id: asked.id }, { body: "The staging one." }],
    });

    await call("delete_comment", { id: asked.id });
    expect(await storage.getComments(task.id)).toMatchObject([{ body: "The staging one." }]);
  });

  it("creates, lists, updates and deletes webhooks using project keys", async () => {
    await storage.createProject({ name: "Bitig", key: "BIT" });

    const created = (
      await call("create_webhook", {
        projectId: "BIT",
        name: "Sentry Alerts",
        provider: "sentry",
        defaultPriority: "high",
        mapping: { title: "data.issue.title" },
      })
    ).data as { id: string; token: string; provider: string; enabled: boolean };

    expect(created.provider).toBe("sentry");
    expect(created.enabled).toBe(true);
    expect(created.token).toMatch(/^whk_[0-9a-f]{32,64}$/);

    const listed = (await call("list_webhooks", { projectId: "bit" })).data as { id: string }[];
    expect(listed.map((w) => w.id)).toEqual([created.id]);

    const updated = (
      await call("update_webhook", {
        id: created.id,
        name: "Jira Alerts",
        provider: "jira",
        enabled: false,
        regenerateToken: true,
      })
    ).data as { id: string; name: string; provider: string; enabled: boolean; token: string };

    expect(updated.name).toBe("Jira Alerts");
    expect(updated.provider).toBe("jira");
    expect(updated.enabled).toBe(false);
    expect(updated.token).not.toBe(created.token);

    expect((await call("delete_webhook", { id: created.id })).data).toEqual({
      success: true,
      deletedWebhookId: created.id,
    });
    expect((await call("list_webhooks", {})).data).toEqual([]);
  });

  it("automatically attributes task creation, status changes, updates, and completion to the MCP client", async () => {
    const project = (await call("create_project", { name: "Bitig", key: "BIT" })).data as { id: string };

    const created = (await call("add_task", {
      projectId: project.id,
      title: "LLM Marked Task",
    })) as {
      data: {
        id: string;
        createdBy?: string;
        updatedBy?: string;
        activity?: { action: string; actor: string; toStatus?: string }[];
      };
    };
    expect(created.data.createdBy).toBe("client-test");
    expect(created.data.updatedBy).toBe("client-test");
    expect(created.data.activity).toEqual([
      expect.objectContaining({ action: "created", actor: "client-test", toStatus: "todo" }),
    ]);
    await approve(created.data.id);

    const started = (await call("update_task", {
      id: "BIT-1",
      status: "in_progress",
    })) as {
      data: {
        startedBy?: string;
        updatedBy?: string;
        activity?: { action: string; actor: string; fromStatus?: string; toStatus?: string }[];
      };
    };
    expect(started.data.startedBy).toBe("client-test");
    expect(started.data.updatedBy).toBe("client-test");
    expect(started.data.activity).toHaveLength(2);
    expect(started.data.activity?.[1]).toMatchObject({
      action: "status_changed",
      actor: "client-test",
      fromStatus: "todo",
      toStatus: "in_progress",
    });

    const completed = (await call("complete_task", { id: "BIT-1" })) as {
      data: {
        completedBy?: string;
        updatedBy?: string;
        activity?: { action: string; actor: string; fromStatus?: string; toStatus?: string }[];
      };
    };
    expect(completed.data.completedBy).toBe("client-test");
    expect(completed.data.updatedBy).toBe("client-test");
    expect(completed.data.activity).toHaveLength(3);
    expect(completed.data.activity?.[2]).toMatchObject({
      action: "completed",
      actor: "client-test",
      fromStatus: "in_progress",
      toStatus: "done",
    });
  });

  it("resolves actor precedence across headers, clientInfo, fallback, and user-agent", () => {
    const freshServer = new McpServer({ name: "bitig", version: "1.0.0" });
    expect(
      resolveMcpActor(
        server,
        { requestInfo: { headers: { "x-bitig-agent": "antigravity" } } },
        "fallback-agent",
      ),
    ).toBe("antigravity");
    expect(resolveMcpActor(server, undefined, "fallback-agent")).toBe("client-test");
    expect(resolveMcpActor(freshServer, undefined, () => "claude-code")).toBe("claude-code");
    expect(
      resolveMcpActor(freshServer, {
        requestInfo: { headers: { "user-agent": "claude-desktop/1.2.0" } },
      }),
    ).toBe("claude-desktop");
    expect(
      resolveMcpActor(freshServer, {
        requestInfo: { headers: { "user-agent": "node-fetch/3.0" } },
      }),
    ).toBe("mcp");
  });
});
