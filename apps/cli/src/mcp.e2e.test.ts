import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type ToolArguments = Record<string, unknown>;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface ProjectResult {
  id: string;
  name: string;
  description?: string;
  kind: string;
}

interface TaskResult {
  id: string;
  projectId: string;
  title: string;
  status: string;
  priority?: string;
  labels?: string[];
  needsHuman?: string;
  pendingApproval?: true;
  code?: string;
}

/** Extracts the JSON payload every Bitig tool returns as its first text block. */
function parseToolJson(result: ToolResult): unknown {
  const content = result.content as { type: string; text?: string }[];
  const first = content[0];
  if (first?.type !== "text" || first.text === undefined) {
    throw new Error(`tool result has no text content: ${JSON.stringify(result)}`);
  }
  return JSON.parse(first.text);
}

const cliPath = path.resolve(import.meta.dirname, "../dist/bitig.js");

describe("Bitig CLI STDIO MCP Server E2E", () => {
  let tempDir: string;
  let dataHome: string;
  let configHome: string;
  let client: Client;
  let transport: StdioClientTransport;

  async function callToolJson<T>(name: string, args: ToolArguments = {}): Promise<T> {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError, `${name} returned an error: ${JSON.stringify(result.content)}`).toBeFalsy();
    return parseToolJson(result) as T;
  }

  /** What a person does: approve over the CLI, since agents have no MCP tool for it. */
  async function approveWithCli(taskRef: string): Promise<void> {
    await promisify(execFile)("node", [cliPath, "tasks", "approve", taskRef], {
      env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: configHome },
    });
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-e2e-mcp-"));
    dataHome = path.join(tempDir, "data");
    configHome = path.join(tempDir, "config");
    await fs.mkdir(dataHome, { recursive: true, mode: 0o700 });
    await fs.mkdir(configHome, { recursive: true, mode: 0o700 });


    transport = new StdioClientTransport({
      command: "node",
      args: [cliPath, "mcp"],
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        XDG_CONFIG_HOME: configHome,
      },
    });

    client = new Client({ name: "e2e-test-client", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("completes full MCP project and task lifecycle over STDIO", async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBe(27);

    // 1. Create project
    const proj = await callToolJson<ProjectResult & { bitig_file_content: string }>("create_project", {
      name: "E2E Project",
      kind: "open_source",
    });
    expect(proj.name).toBe("E2E Project");

    // 2. Add task
    const task = await callToolJson<TaskResult>("add_task", {
      projectId: proj.id,
      title: "E2E Task",
      priority: "urgent",
      dueDate: "2026-10-30",
    });
    expect(task.title).toBe("E2E Task");
    expect(task.pendingApproval).toBe(true);

    // 3. Agents cannot complete it until a person approves it
    const refused = await client.callTool({ name: "complete_task", arguments: { id: task.id } });
    expect(refused.isError).toBe(true);
    await approveWithCli(task.id);

    // 4. Complete task
    const completed = await callToolJson<TaskResult>("complete_task", { id: task.id });
    expect(completed.status).toBe("done");
  });

  it("exercises every registered tool over STDIO", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_attachment",
      "add_comment",
      "add_task",
      "backfill_ticket_codes",
      "complete_task",
      "create_project",
      "create_webhook",
      "delete_attachment",
      "delete_comment",
      "delete_project",
      "delete_task",
      "delete_webhook",
      "get_attachment",
      "get_task",
      "list_attachments",
      "list_comments",
      "list_projects",
      "list_tasks",
      "list_webhooks",
      "next_task",
      "report_t3_git_metadata",
      "resume_from_checkpoint",
      "save_checkpoint",
      "start_t3_thread",
      "update_project",
      "update_task",
      "update_webhook",
    ]);

    // Projects: create, list, update
    const project = await callToolJson<ProjectResult>("create_project", { name: "All Tools" });
    const other = await callToolJson<ProjectResult>("create_project", { name: "Other Project" });

    const projects = await callToolJson<ProjectResult[]>("list_projects");
    expect(projects.map((p) => p.id).sort()).toEqual([project.id, other.id].sort());

    const updatedProject = await callToolJson<ProjectResult>("update_project", {
      id: project.id,
      name: "All Tools Renamed",
      description: "Updated over STDIO",
      kind: "personal",
      resources: [{ type: "repository", label: "Code", url: "https://github.com/acme/all-tools" }],
    });
    expect(updatedProject).toMatchObject({
      id: project.id,
      name: "All Tools Renamed",
      description: "Updated over STDIO",
      kind: "personal",
      resources: [{ type: "repository", label: "Code", url: "https://github.com/acme/all-tools" }],
    });

    // Tasks: add, list (filtered), get, update, complete
    const task = await callToolJson<TaskResult>("add_task", { projectId: project.id, title: "First" });
    await callToolJson<TaskResult>("add_task", { projectId: other.id, title: "Elsewhere" });

    const projectTasks = await callToolJson<TaskResult[]>("list_tasks", { projectId: project.id });
    expect(projectTasks.map((t) => t.id)).toEqual([task.id]);
    expect(await callToolJson<TaskResult[]>("list_tasks")).toHaveLength(2);

    const fetched = await callToolJson<TaskResult>("get_task", { id: task.id });
    expect(fetched).toMatchObject({ id: task.id, projectId: project.id, title: "First" });

    const updatedTask = await callToolJson<TaskResult>("update_task", {
      id: task.id,
      title: "First (edited)",
      priority: "high",
      labels: ["e2e"],
      checklist: [
        { text: "Step one", done: true },
        { text: "Step two", done: false },
      ],
    });
    expect(updatedTask).toMatchObject({
      title: "First (edited)",
      priority: "high",
      labels: ["e2e"],
      checklist: [
        { text: "Step one", done: true },
        { text: "Step two", done: false },
      ],
    });

    // Needs-human flag: set with a reason, filter on it, clear it
    const flagged = await callToolJson<TaskResult>("update_task", { id: task.id, needsHuman: "Pick a name" });
    expect(flagged).toMatchObject({ needsHuman: "Pick a name" });
    const waiting = await callToolJson<TaskResult[]>("list_tasks", { needsHuman: true });
    expect(waiting.map((t) => t.id)).toEqual([task.id]);
    expect(await callToolJson<TaskResult[]>("list_tasks", { needsHuman: false })).toHaveLength(1);
    const answered = await callToolJson<TaskResult>("update_task", { id: task.id, needsHuman: null });
    expect(answered).not.toHaveProperty("needsHuman");

    // Ticket codes stand in for IDs
    expect(task.code).toBe("ALL-1");
    const awaiting = await callToolJson<TaskResult[]>("list_tasks", { pendingApproval: true });
    expect(awaiting).toHaveLength(2);
    expect(await callToolJson("next_task", { projectId: "ALL" })).toMatchObject({
      primary: null, context: null, counts: { pendingApproval: 1, actionableTodo: 0 },
    });
    await approveWithCli("ALL-1");
    expect(await callToolJson("next_task", { projectId: project.id })).toMatchObject({
      primary: { id: task.id, code: "ALL-1", nextSubtask: "Step two" },
      context: { checkpoint: null, comments: [] },
      counts: { pendingApproval: 0, actionableTodo: 1 },
    });
    // T3 launches need the worker's T3 connection; the STDIO server registers the shared tool but refuses it
    const t3Refused = await client.callTool({ name: "start_t3_thread", arguments: { taskId: "ALL-1" } });
    expect(t3Refused.isError).toBe(true);
    expect(JSON.stringify(t3Refused.content)).toContain("T3 integration is not configured on this server");
    expect(await callToolJson("get_task", { id: "ALL-1" })).toMatchObject({ status: "todo" });
    const completed = await callToolJson<TaskResult>("complete_task", { id: "all-1" });
    expect(completed).toMatchObject({ id: task.id, status: "done", code: "ALL-1" });
    expect(await callToolJson("backfill_ticket_codes")).toEqual({ keyedProjects: 0, numberedTasks: 0 });

    // Comments: add, list, read with the task, delete
    const comment = await callToolJson<{ id: string }>("add_comment", { taskId: "ALL-1", body: "Context for later" });
    expect(comment).toMatchObject({ taskId: task.id, body: "Context for later", authorType: "agent" });
    expect(await callToolJson("list_comments", { taskId: task.id })).toEqual([comment]);
    expect(await callToolJson("get_task", { id: "ALL-1" })).toMatchObject({ comments: [comment] });
    expect(await callToolJson("delete_comment", { id: comment.id })).toEqual({
      success: true,
      deletedCommentId: comment.id,
    });
    expect(await callToolJson("list_comments", { taskId: task.id })).toEqual([]);

    // Attachments: add, list, get, read with the task, delete
    const attachment = await callToolJson<{ id: string }>("add_attachment", {
      taskId: "ALL-1",
      name: "notes.md",
      content: "# E2E Notes",
    });
    expect(attachment).toMatchObject({ taskId: task.id, name: "notes.md", mimeType: "text/markdown" });
    expect(await callToolJson("list_attachments", { taskId: task.id })).toEqual([attachment]);
    expect(await callToolJson("get_attachment", { id: attachment.id })).toEqual({
      ...attachment,
      content: "# E2E Notes",
    });
    expect(await callToolJson("get_task", { id: "ALL-1" })).toMatchObject({ attachments: [attachment] });
    expect(await callToolJson("delete_attachment", { id: attachment.id })).toEqual({
      success: true,
      deletedAttachmentId: attachment.id,
    });
    expect(await callToolJson("list_attachments", { taskId: task.id })).toEqual([]);

    // Checkpoints: save, overwrite a step, resume, gone with the task
    const stateSnapshot = {
      summary: "Halfway",
      modifiedArtifacts: ["src/a.ts"],
      decisionsMade: [],
      nextStepInstructions: "Finish the rest",
    };
    expect(
      await callToolJson("save_checkpoint", { taskId: "ALL-1", stepIndex: 0, status: "IN_PROGRESS", stateSnapshot }),
    ).toMatchObject({ success: true, taskId: "ALL-1", stepIndex: 0, status: "IN_PROGRESS" });
    await callToolJson("save_checkpoint", { taskId: "ALL-1", stepIndex: 0, status: "COMPLETED", stateSnapshot });
    expect(await callToolJson("resume_from_checkpoint", { taskId: "ALL-1" })).toMatchObject({
      task: { id: task.id, code: "ALL-1" },
      gates: { pendingApproval: false, needsHuman: null, dependencies: [] },
      checkpoint: { stepIndex: 0, status: "COMPLETED", stateSnapshot: { summary: "Halfway" } },
    });

    // Deletion: task, then project with its remaining tasks
    expect(await callToolJson("delete_task", { id: task.id })).toEqual({ success: true, deletedTaskId: task.id });

    const missing = await client.callTool({ name: "get_task", arguments: { id: task.id } });
    expect(missing.isError).toBe(true);

    expect(await callToolJson("delete_project", { id: other.id })).toEqual({
      success: true,
      deletedProjectId: other.id,
    });

    const remainingProjects = await callToolJson<ProjectResult[]>("list_projects");
    expect(remainingProjects.map((p) => p.id)).toEqual([project.id]);
    expect(await callToolJson<TaskResult[]>("list_tasks")).toEqual([]);
  });
});
