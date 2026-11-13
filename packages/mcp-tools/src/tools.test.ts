import {
  InMemoryStorage,
  T3WorkspaceBusyError,
  type ProjectWorkContext,
  type ProjectWorkSummary,
  type TaskRunProfile,
} from "@bitig/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BITIG_SERVER_INSTRUCTIONS } from "./instructions";
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
      "next_task",
      "get_task",
      "add_task",
      "update_task",
      "complete_task",
      "delete_task",
      "backfill_ticket_codes",
      "list_comments",
      "add_comment",
      "save_checkpoint",
      "resume_from_checkpoint",
      "delete_comment",
      "list_attachments",
      "get_attachment",
      "add_attachment",
      "delete_attachment",
      "list_webhooks",
      "create_webhook",
      "update_webhook",
      "delete_webhook",
      "report_t3_git_metadata",
      "report_child_merge",
      "start_t3_thread",
      "start_ready_children",
      "list_run_levels",
      "suggest_run_profile",
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

  it.each(["in_progress", "done", "archived"])("refuses MCP task creation in %s", async (status) => {
    await call("create_project", { name: "Bitig", key: "BIT" });
    const result = await call("add_task", { projectId: "BIT", title: "Invalid initial status", status });
    expect(result.isError).toBe(true);
    expect(await storage.getTasks()).toEqual([]);
  });

  it("reapplies the agent approval gate after a task returns to Backlog", async () => {
    await call("create_project", { name: "Bitig", key: "BIT" });
    const created = await task("add_task", { projectId: "BIT", title: "Reconsider work", status: "todo" });
    await approve(created.id);
    await task("update_task", { id: created.id, status: "in_progress" });
    await storage.updateTask(created.id, { pendingApproval: true });
    const refused = await call("update_task", { id: created.id, status: "in_progress" });
    expect(refused.isError).toBe(true);
    expect(refused.data).toContain("awaiting human approval");
    expect((await call("complete_task", { id: created.id })).isError).toBe(true);
    expect(await storage.getTask(created.id)).toMatchObject({ status: "todo", pendingApproval: true });
  });

  it("creates tasks awaiting approval and refuses to start or complete them until a person approves", async () => {
    await call("create_project", { name: "Bitig", key: "BIT" });
    const created = (await call("add_task", { projectId: "BIT", title: "Agent idea" })).data as TaskResult & {
      pendingApproval?: true;
    };
    expect(created.pendingApproval).toBe(true);
    expect(created.status).toBe("todo");

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

  it("sets dependencies by ticket code and reports the task as blocked", async () => {
    await call("create_project", { name: "Bitig" });
    const schema = await task("add_task", { projectId: "BIT", title: "Schema" });
    const signup = await task("add_task", { projectId: "BIT", title: "Signup", dependsOn: ["bit-1", schema.id] });
    expect(signup).toMatchObject({ dependsOn: [schema.id], blockedBy: ["BIT-1"] });
    await approve(signup.id);

    expect(await task("get_task", { id: "BIT-2" })).toMatchObject({
      dependsOn: [{ id: schema.id, code: "BIT-1", title: "Schema", status: "todo" }],
      dependents: [],
      blockedBy: ["BIT-1"],
    });
    expect(await task("get_task", { id: "BIT-1" })).toMatchObject({ dependents: [{ code: "BIT-2" }] });
    const refused = await call("update_task", { id: "BIT-2", status: "in_progress" });
    expect(refused.data).toContain("blocked by unfinished dependencies: BIT-1");

    // Clearing the dependencies in the same call lets the task start
    expect(await task("update_task", { id: "BIT-2", status: "in_progress", dependsOn: [] })).not.toHaveProperty(
      "dependsOn",
    );
    // and setting an unfinished one in the same call is refused
    const third = await task("add_task", { projectId: "BIT", title: "Launch" });
    await approve(third.id);
    const blockedStart = await call("update_task", { id: "BIT-3", status: "in_progress", dependsOn: ["BIT-1"] });
    expect(blockedStart.data).toContain("blocked by unfinished dependencies: BIT-1");
    expect(await task("update_task", { id: "BIT-3", dependsOn: null })).not.toHaveProperty("dependsOn");

    // Creating a task already started or done behind an unfinished dependency is refused
    const created = await call("add_task", { projectId: "BIT", title: "Docs", status: "done", dependsOn: ["BIT-1"] });
    expect(created.isError).toBe(true);
    expect(created.data).toContain("todo");
    expect((await call("add_task", { projectId: "BIT", title: "Docs", dependsOn: ["BIT-99"] })).isError).toBe(true);
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

  it("reports the tasks a task mentions and the tasks that mention it", async () => {
    await call("create_project", { name: "Bitig" });
    const schema = await task("add_task", { projectId: "BIT", title: "Schema" });
    await task("add_task", { projectId: "BIT", title: "Signup", description: "After #BIT-1" });
    await task("add_task", {
      projectId: "BIT",
      title: "Launch",
      checklist: [{ text: "Wait for #BIT-2", done: false }],
    });
    await call("add_comment", { taskId: "BIT-1", body: "See #BIT-3 for rollout" });

    expect(await task("get_task", { id: "BIT-2" })).toMatchObject({
      mentions: [{ id: schema.id, code: "BIT-1", title: "Schema", status: "todo" }],
      mentionedIn: [{ code: "BIT-3", title: "Launch", status: "todo" }],
    });
    expect(await task("get_task", { id: "BIT-1" })).toMatchObject({
      mentions: [{ code: "BIT-3" }],
      mentionedIn: [{ code: "BIT-2" }],
    });
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

  describe("next_task", () => {
    type Result = ProjectWorkSummary & { context: ProjectWorkContext | null };

    async function next(projectId: string): Promise<Result> {
      const result = await call("next_task", { projectId });
      expect(result.isError).toBe(false);
      return result.data as Result;
    }

    it("resolves IDs and keys, declares read-only behavior and returns empty states", async () => {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      expect(await next("BIT")).toEqual(await next(project.id));
      expect(await next("BIT")).toMatchObject({ primary: null, context: null, inProgress: [], next: [] });
      const tools = await client.listTools();
      expect(tools.tools.find((entry) => entry.name === "next_task")?.annotations?.readOnlyHint).toBe(true);
      expect((await call("next_task", {})).isError).toBe(true);
      expect((await call("next_task", { projectId: "" })).isError).toBe(true);
      expect((await call("next_task", { projectId: "MISSING" })).isError).toBe(true);
      await storage.deleteProject(project.id);
      expect((await call("next_task", { projectId: project.id })).isError).toBe(true);
    });

    it("resumes with latest checkpoint, recent comments and next unchecked subtask without mutations", async () => {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      const ready = await storage.saveTask({ projectId: project.id, title: "Ready" });
      const active = await storage.saveTask({
        projectId: project.id, title: "Active", status: "in_progress",
        checklist: [{ text: "Done", done: true }, { text: "Validate", done: false }],
      });
      const snapshot = { summary: "Implementation ready", modifiedArtifacts: [], decisionsMade: [], nextStepInstructions: "Run make check" };
      await storage.saveCheckpoint({ taskId: active.id, stepIndex: 2, status: "IN_PROGRESS", stateSnapshot: snapshot });
      await storage.saveCheckpoint({ taskId: active.id, stepIndex: 1, status: "FAILED", stateSnapshot: snapshot });
      await storage.addComment({ taskId: active.id, body: "Review context", authorType: "human", author: "Reviewer" });
      const before = await storage.getTasks();
      const checkpoints = vi.spyOn(storage, "getCheckpoints");
      const comments = vi.spyOn(storage, "getComments");
      const result = await next("BIT");
      expect(result.primary).toMatchObject({ id: active.id, code: "BIT-2", nextSubtask: "Validate" });
      expect(result.next[0]?.id).toBe(ready.id);
      expect(result.context?.checkpoint).toMatchObject({ stepIndex: 2, nextStepInstructions: "Run make check" });
      expect(result.context?.comments[0]).toMatchObject({ author: "Reviewer", body: "Review context" });
      expect(checkpoints).toHaveBeenCalledExactlyOnceWith(active.id, { signal: expect.any(AbortSignal) as AbortSignal });
      expect(comments).toHaveBeenCalledExactlyOnceWith(active.id, { signal: expect.any(AbortSignal) as AbortSignal });
      expect(await storage.getTasks()).toEqual(before);
    });

    it("honors cross-project live gates, canonical ordering and archived dependencies", async () => {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      const other = await storage.createProject({ name: "Other", key: "OTHER" });
      const dependency = await storage.saveTask({ projectId: other.id, title: "Dependency" });
      await storage.saveTask({ projectId: project.id, title: "Gated", status: "in_progress", pendingApproval: true, needsHuman: "Decision", dependsOn: [dependency.id] });
      const first = await storage.saveTask({ projectId: project.id, title: "First", order: 1 });
      await storage.saveTask({ projectId: project.id, title: "Second", order: 2, priority: "urgent" });
      const blocked = await storage.saveTask({ projectId: project.id, title: "Blocked", order: 0, dependsOn: [dependency.id] });
      const result = await next("BIT");
      expect(result.primary?.id).toBe(first.id);
      expect(result.counts).toEqual({ inProgress: 1, actionableTodo: 2, pendingApproval: 1, blocked: 2, needsHuman: 1 });
      expect(JSON.stringify(result)).not.toContain("Dependency");
      await storage.updateTask(dependency.id, { status: "archived" });
      expect((await next("BIT")).primary?.id).toBe(blocked.id);
      await storage.updateProject(project.id, { archived: true });
      expect(await next("BIT")).toMatchObject({ primary: null, context: null, next: [] });
    });

    it("does not fetch context when all tasks are gated and formats storage errors", async () => {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      await storage.saveTask({ projectId: project.id, title: "Waiting", pendingApproval: true });
      const checkpoints = vi.spyOn(storage, "getCheckpoints");
      const comments = vi.spyOn(storage, "getComments");
      expect(await next("BIT")).toMatchObject({ primary: null, context: null });
      expect(checkpoints).not.toHaveBeenCalled();
      expect(comments).not.toHaveBeenCalled();
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
      vi.spyOn(storage, "getTasks").mockRejectedValueOnce(new Error("Storage unavailable"));
      expect((await call("next_task", { projectId: "BIT" })).isError).toBe(true);
      expect(errorLog).toHaveBeenCalled();
      errorLog.mockRestore();
    });

    it("keeps payload bounded despite a large closed history and verbose selected tasks", async () => {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      const largeText = "x".repeat(4000);
      for (let index = 0; index < 30; index += 1) {
        await storage.saveTask({ projectId: project.id, title: "Closed history", description: largeText, status: "done" });
      }
      const active = await storage.saveTask({ projectId: project.id, title: "Resume", status: "in_progress", description: largeText });
      for (let index = 0; index < 5; index += 1) {
        await storage.addComment({ taskId: active.id, body: largeText, authorType: "agent" });
      }
      const result = await next("BIT");
      expect(result.context?.descriptionTruncated).toBe(true);
      expect(result.context?.omittedCommentCount).toBe(3);
      expect(JSON.stringify(result)).not.toContain("Closed history");
      expect(JSON.stringify(result).length).toBeLessThan(6000);
    });
  });

  describe("checkpoints", () => {
    const snapshot = (summary: string) => ({
      summary,
      modifiedArtifacts: ["src/a.ts"],
      decisionsMade: ["keep it small"],
      nextStepInstructions: "Run the tests",
    });

    async function seed(): Promise<{ id: string }> {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      return storage.saveTask({ projectId: project.id, title: "Long job" });
    }

    it("saves by ticket code with a compact confirmation and resumes from the latest step", async () => {
      const task = await seed();
      const saved = await call("save_checkpoint", {
        taskId: "BIT-1", stepIndex: 0, status: "COMPLETED", stateSnapshot: snapshot("Schema done"),
      });
      expect(saved.isError).toBe(false);
      expect(saved.data).toEqual({
        success: true, taskId: "BIT-1", checkpointId: expect.any(String) as string, stepIndex: 0, status: "COMPLETED",
      });
      expect(JSON.stringify(saved.data)).not.toContain("Schema done");
      await call("save_checkpoint", {
        taskId: "BIT-1", stepIndex: 1, status: "IN_PROGRESS", stateSnapshot: snapshot("Routes half done"),
      });

      const resumed = (await call("resume_from_checkpoint", { taskId: "BIT-1" })).data as {
        task: { id: string; code: string };
        checkpoint: { stepIndex: number };
        history: { stepIndex: number; summary: string }[];
      };
      expect(resumed.task).toMatchObject({ id: task.id, code: "BIT-1" });
      expect(resumed.checkpoint.stepIndex).toBe(1);
      expect(resumed.history).toEqual([{ stepIndex: 0, status: "COMPLETED", summary: "Schema done" }]);

      const earlier = (await call("resume_from_checkpoint", { taskId: "BIT-1", stepIndex: 0 })).data as {
        checkpoint: { stepIndex: number };
      };
      expect(earlier.checkpoint.stepIndex).toBe(0);
    });

    it("overwrites a step instead of adding one", async () => {
      const task = await seed();
      const args = { taskId: "BIT-1", stepIndex: 2, status: "IN_PROGRESS" };
      await call("save_checkpoint", { ...args, stateSnapshot: snapshot("first") });
      await call("save_checkpoint", { ...args, status: "FAILED", stateSnapshot: snapshot("second") });
      expect(await storage.getCheckpoints(task.id)).toMatchObject([{ status: "FAILED", stateSnapshot: { summary: "second" } }]);
    });

    it("rejects unknown fields, oversize snapshots, bad steps and unknown tasks", async () => {
      const task = await seed();
      const base = { taskId: "BIT-1", stepIndex: 0, status: "PENDING", stateSnapshot: snapshot("ok") };
      for (const bad of [
        { ...base, stepIndex: -1 },
        { ...base, stepIndex: 1.5 },
        { ...base, status: "done" },
        { ...base, stateSnapshot: { ...snapshot("ok"), extra: true } },
        { ...base, stateSnapshot: snapshot("x".repeat(501)) },
        { ...base, stateSnapshot: { ...snapshot("ok"), nextStepInstructions: "x".repeat(4001) } },
        { ...base, taskId: "BIT-99" },
      ]) {
        expect((await call("save_checkpoint", bad)).isError).toBe(true);
      }
      expect(await storage.getCheckpoints(task.id)).toEqual([]);
      expect((await call("resume_from_checkpoint", { taskId: "BIT-99" })).isError).toBe(true);
    });

    it("never changes approval, blocking or needs-human state, and reports the live gates on resume", async () => {
      const project = await storage.createProject({ name: "Bitig", key: "BIT" });
      const blocker = await storage.saveTask({ projectId: project.id, title: "Blocker" });
      const secondBlocker = await storage.saveTask({ projectId: project.id, title: "Second blocker", status: "in_progress" });
      const gated = await storage.saveTask({
        projectId: project.id,
        title: "Gated",
        pendingApproval: true,
        needsHuman: "Pick a key",
        dependsOn: [blocker.id, secondBlocker.id],
      });
      const before = await storage.getTask(gated.id);
      await call("save_checkpoint", {
        taskId: "BIT-3", stepIndex: 0, status: "WAITING_HUMAN_APPROVAL", stateSnapshot: snapshot("Waiting"),
      });
      expect(await storage.getTask(gated.id)).toEqual(before);

      const refused = await call("update_task", { id: "BIT-3", status: "in_progress" });
      expect(refused.isError).toBe(true);

      interface ResumeGates {
        gates: {
          pendingApproval: boolean;
          needsHuman: string | null;
          dependencies: { id: string; status: string | null; blocked: boolean }[];
        };
      }

      const resumedInitial = (await call("resume_from_checkpoint", { taskId: "BIT-3" })).data as ResumeGates;
      expect(resumedInitial.gates).toEqual({
        pendingApproval: true,
        needsHuman: "Pick a key",
        dependencies: [
          { id: blocker.id, status: "todo", blocked: true },
          { id: secondBlocker.id, status: "in_progress", blocked: true },
        ],
      });

      // Transition first prerequisite: todo -> in_progress -> done -> archived while second remains in_progress
      await call("update_task", { id: "BIT-1", status: "in_progress" });
      expect(((await call("resume_from_checkpoint", { taskId: "BIT-3" })).data as ResumeGates).gates.dependencies).toEqual([
        { id: blocker.id, status: "in_progress", blocked: true },
        { id: secondBlocker.id, status: "in_progress", blocked: true },
      ]);

      await call("complete_task", { id: "BIT-1" });
      expect(((await call("resume_from_checkpoint", { taskId: "BIT-3" })).data as ResumeGates).gates).toEqual({
        pendingApproval: true,
        needsHuman: "Pick a key",
        dependencies: [
          { id: blocker.id, status: "done", blocked: false },
          { id: secondBlocker.id, status: "in_progress", blocked: true },
        ],
      });

      await call("update_task", { id: "BIT-1", status: "archived" });
      const resumedMixed = (await call("resume_from_checkpoint", { taskId: "BIT-3" })).data as ResumeGates;
      expect(resumedMixed.gates).toEqual({
        pendingApproval: true,
        needsHuman: "Pick a key",
        dependencies: [
          { id: blocker.id, status: "archived", blocked: false },
          { id: secondBlocker.id, status: "in_progress", blocked: true },
        ],
      });
      // Consistent with get_task and list_tasks: only unfinished BIT-2 is in blockedBy
      expect((await call("get_task", { id: "BIT-3" })).data).toMatchObject({
        blockedBy: ["BIT-2"],
      });

      // Complete and archive second prerequisite; stored needsHuman and pendingApproval remain intact
      await call("complete_task", { id: "BIT-2" });
      await call("update_task", { id: "BIT-2", status: "archived" });
      const resumedSatisfied = (await call("resume_from_checkpoint", { taskId: "BIT-3" })).data as ResumeGates;
      expect(resumedSatisfied.gates).toEqual({
        pendingApproval: true,
        needsHuman: "Pick a key",
        dependencies: [
          { id: blocker.id, status: "archived", blocked: false },
          { id: secondBlocker.id, status: "archived", blocked: false },
        ],
      });
      expect((await call("get_task", { id: "BIT-3" })).data).not.toHaveProperty("blockedBy");
      expect((await call("list_tasks", { projectId: "BIT", blocked: true })).data).toEqual([]);
    });
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

  it("manages text and binary task attachments and includes them in get_task", async () => {
    await call("create_project", { name: "Bitig", key: "BIT" });
    await task("add_task", { projectId: "BIT", title: "Spec task" });

    const mdAdded = await call("add_attachment", {
      taskId: "BIT-1",
      name: "spec.md",
      content: "# Design\n\nHello world",
    });
    expect(mdAdded.isError).toBe(false);
    const mdMeta = mdAdded.data as { id: string; name: string; mimeType: string; size: number };
    expect(mdMeta).toMatchObject({ name: "spec.md", mimeType: "text/markdown" });

    const pngAdded = await call("add_attachment", {
      taskId: "BIT-1",
      name: "pixel.png",
      data: "iVBORw0KGgo=",
    });
    expect(pngAdded.isError).toBe(false);
    const pngMeta = pngAdded.data as { id: string; name: string; mimeType: string; size: number };
    expect(pngMeta).toMatchObject({ name: "pixel.png", mimeType: "image/png" });

    const listed = await call("list_attachments", { taskId: "BIT-1" });
    expect(listed.isError).toBe(false);
    expect(listed.data).toEqual([mdMeta, pngMeta]);

    const fullTask = await call("get_task", { id: "BIT-1" });
    expect(fullTask.isError).toBe(false);
    expect(fullTask.data).toMatchObject({
      attachmentCount: 2,
      attachments: [mdMeta, pngMeta],
    });

    const fetchedMd = await call("get_attachment", { id: mdMeta.id });
    expect(fetchedMd.isError).toBe(false);
    expect(fetchedMd.data).toEqual({
      ...mdMeta,
      content: "# Design\n\nHello world",
    });

    const fetchedPng = await call("get_attachment", { id: pngMeta.id });
    expect(fetchedPng.isError).toBe(false);
    expect(fetchedPng.data).toEqual({
      ...pngMeta,
      data: "iVBORw0KGgo=",
      downloadUrl: `/api/attachments/${pngMeta.id}`,
    });

    const deleted = await call("delete_attachment", { id: mdMeta.id });
    expect(deleted.isError).toBe(false);
    expect(deleted.data).toEqual({ success: true, deletedAttachmentId: mdMeta.id });
    expect((await call("list_attachments", { taskId: "BIT-1" })).data).toEqual([pngMeta]);
  });
});

describe("start_t3_thread workspace guard (#BIT-134)", () => {
  it("reports a busy root checkout as a WORKSPACE_BUSY tool error", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig", key: "BIT" });
    const task = await storage.saveTask({ projectId: project.id, title: "Wants the root checkout" });
    const busy = new T3WorkspaceBusyError({ threadId: "thread-1", state: "working", taskCode: "BIT-9" });
    const startT3Thread = vi.fn(() => Promise.reject(busy));
    const server = new McpServer({ name: "bitig-test", version: "1.0.0" });
    registerBitigTools(server, storage, { startT3Thread });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      const result = await client.callTool({
        name: "start_t3_thread",
        arguments: { taskId: "BIT-1", workspaceStrategy: "root" },
      });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]?.text).toBe(`[WORKSPACE_BUSY] ${busy.message}`);
      expect(startT3Thread).toHaveBeenCalledWith(expect.objectContaining({ taskId: task.id, workspaceStrategy: "root" }));
      expect((await storage.getTask(task.id))?.status).toBe("todo");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("host-bound project MCP tools (#BIT-151)", () => {
  it("creates a project from a host folder, rolls back on failure, and detaches/reattaches via update_project", async () => {
    const storage = new InMemoryStorage();
    let failRegistration = false;
    const registerProjectHostFolder = vi.fn(
      ({
        projectId,
        workspaceRoot,
        hostId,
      }: {
        readonly projectId: string;
        readonly workspaceRoot: string;
        readonly hostId?: string | undefined;
      }) => {
        if (failRegistration) {
          const err = Object.assign(new Error(`Workspace root ${workspaceRoot} does not exist.`), {
            code: "t3_rejected",
          });
          return Promise.reject(err);
        }
        return Promise.resolve({
          created: true,
          mapping: {
            projectId,
            hostId: hostId ?? "default",
            t3ProjectId: `t3-${hostId ?? "default"}`,
            t3ProjectTitle: "Acme",
            workspaceRoot,
            updatedAt: "2026-11-10T00:00:00.000Z",
          },
        });
      },
    );
    const unregisterProjectHostFolder = vi.fn(() => Promise.resolve({ unregistered: true }));

    const server = new McpServer({ name: "bitig-test", version: "1.0.0" });
    registerBitigTools(server, storage, {
      registerProjectHostFolder,
      unregisterProjectHostFolder,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      // Failed registration rolls back the Bitig project so a retry with the same key succeeds
      failRegistration = true;
      const failedRes = await client.callTool({
        name: "create_project",
        arguments: {
          name: "Acme",
          key: "ACM",
          hostId: "host-a",
          workspaceRoot: "/var/www/missing",
        },
      });
      expect(failedRes.isError).toBe(true);
      expect((failedRes.content as { text: string }[])[0]?.text).toBe(
        "[t3_rejected] Workspace root /var/www/missing does not exist.",
      );
      expect(await storage.getProjects()).toEqual([]);

      // Retry succeeds with an existing folder
      failRegistration = false;
      const createdRes = await client.callTool({
        name: "create_project",
        arguments: {
          name: "Acme",
          key: "ACM",
          hostId: "host-a",
          workspaceRoot: "/var/www/acme/",
        },
      });
      expect(createdRes.isError).toBeFalsy();
      const created = JSON.parse((createdRes.content as { text: string }[])[0]?.text ?? "{}") as {
        id: string;
        key: string;
        mapping: { hostId: string; workspaceRoot: string; t3ProjectId: string };
        created: boolean;
      };
      expect(created).toMatchObject({
        key: "ACM",
        created: true,
        mapping: {
          hostId: "host-a",
          workspaceRoot: "/var/www/acme",
          t3ProjectId: "t3-host-a",
        },
      });

      // Detach via update_project with workspaceRoot: null
      const detachedRes = await client.callTool({
        name: "update_project",
        arguments: {
          id: created.id,
          workspaceRoot: null,
          force: true,
        },
      });
      expect(detachedRes.isError).toBeFalsy();
      expect(unregisterProjectHostFolder).toHaveBeenCalledWith({
        projectId: created.id,
        force: true,
      });
      expect(JSON.parse((detachedRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
        id: created.id,
        mapping: null,
        unregistered: true,
      });

      // Reattach to another host via update_project
      const reattachedRes = await client.callTool({
        name: "update_project",
        arguments: {
          id: created.id,
          hostId: "host-b",
          workspaceRoot: "~/www/acme/",
        },
      });
      expect(reattachedRes.isError).toBeFalsy();
      expect(JSON.parse((reattachedRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
        id: created.id,
        mapping: {
          hostId: "host-b",
          workspaceRoot: "~/www/acme",
          t3ProjectId: "t3-host-b",
        },
        created: true,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("umbrella task child sessions (#BIT-141)", () => {
  async function connect(
    storage: InMemoryStorage,
    options: Parameters<typeof registerBitigTools>[2],
  ): Promise<{ client: Client; server: McpServer }> {
    const server = new McpServer({ name: "bitig-test", version: "1.0.0" });
    registerBitigTools(server, storage, options);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);
    return { client, server };
  }

  it("resolves parentTaskId and does not let a dependency on the umbrella task block its child", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig", key: "BIT" });
    const umbrella = await storage.saveTask({ projectId: project.id, title: "Umbrella", status: "in_progress" });
    const other = await storage.saveTask({ projectId: project.id, title: "Unfinished other" });
    const child = await storage.saveTask({ projectId: project.id, title: "Child", dependsOn: [umbrella.id] });
    const blocked = await storage.saveTask({
      projectId: project.id,
      title: "Blocked child",
      dependsOn: [umbrella.id, other.id],
    });
    const startT3Thread = vi.fn((input: { taskId: string }) =>
      storage.getTask(input.taskId).then((task) => {
        if (!task) throw new Error("missing task");
        return {
          run: {
            id: "0196ed60-0000-7000-8000-000000000099",
            taskId: task.id,
            t3ProjectId: "t3",
            threadId: "thread-child",
            state: "working" as const,
            startedAt: task.createdAt,
            updatedAt: task.createdAt,
          },
          task,
        };
      }),
    );
    const { client, server } = await connect(storage, { startT3Thread });

    try {
      const withoutParent = await client.callTool({ name: "start_t3_thread", arguments: { taskId: "BIT-3" } });
      expect(withoutParent.isError).toBe(true);
      expect(startT3Thread).not.toHaveBeenCalled();

      const started = await client.callTool({
        name: "start_t3_thread",
        arguments: { taskId: "BIT-3", parentTaskId: "BIT-1" },
      });
      expect(started.isError).toBeFalsy();
      expect(startT3Thread).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: child.id, parentTaskId: umbrella.id }),
      );

      const stillBlocked = await client.callTool({
        name: "start_t3_thread",
        arguments: { taskId: blocked.id, parentTaskId: "BIT-1" },
      });
      expect(stillBlocked.isError).toBe(true);
      expect((stillBlocked.content as { text: string }[])[0]?.text).toContain("BIT-2");
      expect(startT3Thread).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("runs onTaskFinished after complete_task and after update_task to done or archived only", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig", key: "BIT" });
    const first = await storage.saveTask({ projectId: project.id, title: "First" });
    const second = await storage.saveTask({ projectId: project.id, title: "Second" });
    const third = await storage.saveTask({ projectId: project.id, title: "Third" });
    const onTaskFinished = vi.fn<(task: { id: string; status: string }) => Promise<void>>().mockResolvedValue(undefined);
    const { client, server } = await connect(storage, { onTaskFinished });

    try {
      await client.callTool({ name: "update_task", arguments: { id: "BIT-1", status: "in_progress" } });
      await client.callTool({ name: "update_task", arguments: { id: "BIT-1", title: "Renamed" } });
      expect(onTaskFinished).not.toHaveBeenCalled();

      await client.callTool({ name: "complete_task", arguments: { id: "BIT-1" } });
      await client.callTool({ name: "update_task", arguments: { id: "BIT-2", status: "done" } });
      await client.callTool({ name: "update_task", arguments: { id: "BIT-3", status: "archived" } });
      expect(onTaskFinished.mock.calls.map(([task]) => task.id)).toEqual([
        first.id,
        second.id,
        third.id,
      ]);
      expect(onTaskFinished).toHaveBeenNthCalledWith(1, expect.objectContaining({ status: "done" }));
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("delegates start_ready_children with resolved parentTaskId and runs onTaskNeedsHuman when needsHuman is set (#BIT-189)", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig", key: "BIT" });
    const umbrella = await storage.saveTask({ projectId: project.id, title: "Umbrella", status: "in_progress" });
    const child = await storage.saveTask({ projectId: project.id, title: "Child", status: "in_progress" });

    const startReadyChildren = vi.fn().mockResolvedValue({
      started: [
        {
          taskId: child.id,
          code: "BIT-2",
          title: "Child",
          threadId: "thread-child-1",
          state: "working" as const,
          queued: false,
          workspaceStrategy: "worktree" as const,
        },
      ],
      skipped: [],
    });
    const onTaskNeedsHuman = vi.fn<(task: { id: string; needsHuman?: string }) => Promise<void>>().mockResolvedValue(
      undefined,
    );
    const { client, server } = await connect(storage, { startReadyChildren, onTaskNeedsHuman });

    try {
      const batchRes = await client.callTool({
        name: "start_ready_children",
        arguments: { parentTaskId: "BIT-1", max: 2 },
      });
      expect(batchRes.isError).toBeFalsy();
      expect(startReadyChildren).toHaveBeenCalledWith(
        expect.objectContaining({ parentTaskId: umbrella.id, max: 2 }),
      );
      expect(JSON.parse((batchRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
        started: [expect.objectContaining({ code: "BIT-2", threadId: "thread-child-1" })],
        skipped: [],
      });

      await client.callTool({
        name: "update_task",
        arguments: { id: "BIT-2", needsHuman: "Need API key" },
      });
      expect(onTaskNeedsHuman).toHaveBeenCalledTimes(1);
      expect(onTaskNeedsHuman).toHaveBeenCalledWith(
        expect.objectContaining({ id: child.id, needsHuman: "Need API key" }),
      );

      await client.callTool({
        name: "update_task",
        arguments: { id: "BIT-2", needsHuman: null },
      });
      expect(onTaskNeedsHuman).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("resolves parentTaskId and childTaskId codes in report_child_merge and records mergedSha (#BIT-190)", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig", key: "BIT" });
    const umbrella = await storage.saveTask({ projectId: project.id, title: "Umbrella" });
    const child = await storage.saveTask({ projectId: project.id, title: "Child" });

    const reportChildMerge = vi.fn((input: { parentTaskId: string; childTaskId: string; mergedSha: string }) =>
      Promise.resolve({
        parentTaskId: input.parentTaskId,
        childTaskId: input.childTaskId,
        state: "done" as const,
        branch: "bitig/BIT-2",
        headSha: "1111111",
        mergedSha: input.mergedSha,
        startedAt: umbrella.createdAt,
        finishedAt: child.updatedAt,
        mergedAt: "2026-11-12T12:00:00.000Z",
      }),
    );
    const { client, server } = await connect(storage, { reportChildMerge });

    try {
      const mergedRes = await client.callTool({
        name: "report_child_merge",
        arguments: {
          parentTaskId: "BIT-1",
          childTaskId: "BIT-2",
          mergedSha: "abcdef1234567890abcdef1234567890abcdef12",
        },
      });
      expect(mergedRes.isError).toBeFalsy();
      expect(reportChildMerge).toHaveBeenCalledWith(
        {
          parentTaskId: umbrella.id,
          childTaskId: child.id,
          mergedSha: "abcdef1234567890abcdef1234567890abcdef12",
        },
        expect.anything(),
      );
      expect(JSON.parse((mergedRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
        child: {
          parentTaskId: umbrella.id,
          childTaskId: child.id,
          mergedSha: "abcdef1234567890abcdef1234567890abcdef12",
          mergedAt: "2026-11-12T12:00:00.000Z",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("run orchestration MCP tools (#BIT-186)", () => {
  it("lists run levels, saves agent run profiles without overwriting manual profiles, returns resolved model in get_task, and passes level/options to start_t3_thread", async () => {
    const storage = new InMemoryStorage();
    const project = await storage.createProject({ name: "Bitig", key: "BIT" });

    const profiles = new Map<string, TaskRunProfile>();

    const levels = [
      { key: "low", label: "Low", description: "Typos, renames, small edits", order: 0 },
      { key: "med", label: "Medium", description: "Single-module work", order: 1 },
      { key: "high", label: "High", description: "Cross-cutting refactors", order: 2 },
    ];

    const saveTaskRunProfile = vi.fn(
      (input: {
        taskId: string;
        level?: string | null | undefined;
        touches?: readonly string[] | null | undefined;
        parallelSafe?: boolean | null | undefined;
        reason?: string | null | undefined;
        source: "manual" | "agent" | "router";
      }) => {
        const existing = profiles.get(input.taskId);
        if (existing?.source === "manual" && input.source !== "manual") {
          return Promise.resolve(existing);
        }
        const saved: TaskRunProfile = {
          ...(input.level ? { level: input.level } : {}),
          touches: [...(input.touches ?? existing?.touches ?? [])],
          ...(typeof input.parallelSafe === "boolean" ? { parallelSafe: input.parallelSafe } : {}),
          ...(input.reason ? { reason: input.reason } : {}),
          source: input.source,
        };
        profiles.set(input.taskId, saved);
        return Promise.resolve(saved);
      },
    );

    const resolveTaskRunProfile = vi.fn((taskId: string) => {
      const profile = profiles.get(taskId) ?? null;
      const levelKey = profile?.level ?? "med";
      return Promise.resolve({
        profile,
        resolved: {
          source: profile?.level ? ("profile_level" as const) : ("project_default_level" as const),
          levelKey,
          selection: {
            providerInstanceId: "claude-main",
            model: levelKey === "high" ? "claude-opus-4-6" : "claude-sonnet-4-6",
            options: [{ id: "effort", value: levelKey === "high" ? "high" : "medium" }],
          },
          skipped: [],
        },
      });
    });

    const startT3Thread = vi.fn((input: { taskId: string; level?: string | undefined; model?: string | undefined }) =>
      storage.getTask(input.taskId).then((task) => {
        if (!task) throw new Error("missing task");
        return {
          run: {
            id: "0196ed60-0000-7000-8000-000000000099",
            taskId: task.id,
            t3ProjectId: "t3",
            threadId: "thread-level",
            state: "working" as const,
            ...(input.model ? { model: input.model } : { model: "claude-opus-4-6" }),
            ...(input.level ? { levelKey: input.level, modelSource: "explicit_level" as const } : {}),
            startedAt: task.createdAt,
            updatedAt: task.createdAt,
          },
          task,
        };
      }),
    );

    const suggestTaskRunProfile = vi.fn(async (input: { taskId: string; actor?: string | undefined }) => {
      const existing = profiles.get(input.taskId);
      if (existing && (existing.source === "manual" || existing.source === "agent")) {
        const resolved = (await resolveTaskRunProfile(input.taskId)).resolved;
        return {
          profile: existing,
          resolved,
          suggestion: null,
          stored: false,
          routerEnabled: true,
        };
      }
      const suggestion = {
        level: "med",
        effort: "medium",
        touches: ["packages/core/**"],
        parallelSafe: true,
        reason: "Router suggested medium level",
        confidence: 0.91,
      };
      const saved: TaskRunProfile = {
        level: suggestion.level,
        effort: suggestion.effort,
        touches: suggestion.touches,
        parallelSafe: suggestion.parallelSafe,
        reason: suggestion.reason,
        confidence: suggestion.confidence,
        source: "router",
      };
      profiles.set(input.taskId, saved);
      const resolved = (await resolveTaskRunProfile(input.taskId)).resolved;
      return {
        profile: saved,
        resolved,
        suggestion,
        stored: true,
        routerEnabled: true,
      };
    });

    const server = new McpServer({ name: "bitig-test", version: "1.0.0" });
    registerBitigTools(server, storage, {
      listRunLevels: () => Promise.resolve(levels),
      saveTaskRunProfile,
      resolveTaskRunProfile,
      startT3Thread,
      suggestTaskRunProfile,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "client-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(clientTransport);

    try {
      // 1. list_run_levels returns levels with descriptions
      const listedLevels = await client.callTool({ name: "list_run_levels", arguments: {} });
      expect(listedLevels.isError).toBeFalsy();
      expect(JSON.parse((listedLevels.content as { text: string }[])[0]?.text ?? "[]")).toEqual(levels);

      // 2. add_task with runProfile saves with source: "agent"
      const addedRes = await client.callTool({
        name: "add_task",
        arguments: {
          projectId: project.id,
          title: "Refactor auth",
          runProfile: {
            level: "high",
            touches: ["apps/worker/src/auth/**"],
            parallelSafe: false,
            reason: "Touches shared auth middleware",
          },
        },
      });
      expect(addedRes.isError).toBeFalsy();
      const addedTask = JSON.parse((addedRes.content as { text: string }[])[0]?.text ?? "{}") as {
        id: string;
        code: string;
        runProfile: { level: string; source: string; touches: string[]; parallelSafe: boolean; reason: string };
      };
      expect(addedTask.runProfile).toMatchObject({
        level: "high",
        touches: ["apps/worker/src/auth/**"],
        parallelSafe: false,
        reason: "Touches shared auth middleware",
        source: "agent",
      });

      // 3. Rejects unknown run level key
      const badLevelRes = await client.callTool({
        name: "update_task",
        arguments: {
          id: addedTask.code,
          runProfile: { level: "ultra" },
        },
      });
      expect(badLevelRes.isError).toBe(true);
      expect((badLevelRes.content as { text: string }[])[0]?.text).toContain("Unknown run level");

      // 4. get_task returns runProfile and resolvedModel
      const gotRes = await client.callTool({
        name: "get_task",
        arguments: { id: addedTask.code },
      });
      expect(gotRes.isError).toBeFalsy();
      const gotTask = JSON.parse((gotRes.content as { text: string }[])[0]?.text ?? "{}") as {
        runProfile: { level: string; source: string };
        resolvedModel: {
          providerInstanceId: string;
          model: string;
          source: string;
          levelKey: string;
          options: { id: string; value: string }[];
        };
      };
      expect(gotTask.runProfile).toMatchObject({ level: "high", source: "agent" });
      expect(gotTask.resolvedModel).toEqual({
        providerInstanceId: "claude-main",
        model: "claude-opus-4-6",
        options: [{ id: "effort", value: "high" }],
        source: "profile_level",
        levelKey: "high",
      });

      // 5. Manual profile is never overwritten by agent update_task
      profiles.set(addedTask.id, {
        level: "low",
        touches: ["README.md"],
        parallelSafe: true,
        reason: "Human locked to low",
        source: "manual",
      });
      const afterManualUpdate = await client.callTool({
        name: "update_task",
        arguments: {
          id: addedTask.code,
          runProfile: { level: "high", reason: "Agent wants high" },
        },
      });
      expect(afterManualUpdate.isError).toBeFalsy();
      const afterManualData = JSON.parse((afterManualUpdate.content as { text: string }[])[0]?.text ?? "{}") as {
        runProfile: { level: string; source: string; reason: string };
      };
      expect(afterManualData.runProfile).toMatchObject({
        level: "low",
        source: "manual",
        reason: "Human locked to low",
      });

      // 6. start_t3_thread accepts level and options alongside model
      await storage.updateTask(addedTask.id, { pendingApproval: null });
      const launched = await client.callTool({
        name: "start_t3_thread",
        arguments: {
          taskId: addedTask.code,
          level: "high",
          options: [{ id: "effort", value: "max" }],
        },
      });
      expect(launched.isError).toBeFalsy();
      expect(startT3Thread).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: addedTask.id,
          level: "high",
          options: [{ id: "effort", value: "max" }],
        }),
      );

      // 7. suggest_run_profile suggests and stores for an unprofiled task, and does not overwrite manual profiles
      const unprofiledTaskRes = await client.callTool({
        name: "add_task",
        arguments: {
          projectId: project.id,
          title: "Unprofiled task for router",
        },
      });
      const unprofiledTask = JSON.parse((unprofiledTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
        id: string;
        code: string;
      };
      const suggestRes = await client.callTool({
        name: "suggest_run_profile",
        arguments: { taskId: unprofiledTask.code },
      });
      expect(suggestRes.isError).toBeFalsy();
      expect(JSON.parse((suggestRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
        stored: true,
        routerEnabled: true,
        profile: {
          level: "med",
          effort: "medium",
          touches: ["packages/core/**"],
          parallelSafe: true,
          source: "router",
          confidence: 0.91,
        },
      });

      const suggestManualRes = await client.callTool({
        name: "suggest_run_profile",
        arguments: { taskId: addedTask.code },
      });
      expect(suggestManualRes.isError).toBeFalsy();
      expect(JSON.parse((suggestManualRes.content as { text: string }[])[0]?.text ?? "{}")).toMatchObject({
        stored: false,
        profile: {
          level: "low",
          source: "manual",
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("includes list_run_levels and runProfile guidance in BITIG_SERVER_INSTRUCTIONS", () => {
    expect(BITIG_SERVER_INSTRUCTIONS).toContain("list_run_levels");
    expect(BITIG_SERVER_INSTRUCTIONS).toContain("runProfile");
    expect(BITIG_SERVER_INSTRUCTIONS).toContain("touches");
    expect(BITIG_SERVER_INSTRUCTIONS).toContain("parallelSafe");
    expect(BITIG_SERVER_INSTRUCTIONS).toContain("start_ready_children");
    expect(BITIG_SERVER_INSTRUCTIONS).toContain("report_child_merge");
  });
});

