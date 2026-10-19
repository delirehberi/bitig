import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-e2e-mcp-"));
    dataHome = path.join(tempDir, "data");
    configHome = path.join(tempDir, "config");
    await fs.mkdir(dataHome, { recursive: true, mode: 0o700 });
    await fs.mkdir(configHome, { recursive: true, mode: 0o700 });

    const cliPath = path.resolve(import.meta.dirname, "../dist/bitig.js");

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
    expect(tools.length).toBe(10);

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

    // 3. Complete task
    const completed = await callToolJson<TaskResult>("complete_task", { id: task.id });
    expect(completed.status).toBe("done");
  });

  it("exercises every registered tool over STDIO", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "add_task",
      "complete_task",
      "create_project",
      "delete_project",
      "delete_task",
      "get_task",
      "list_projects",
      "list_tasks",
      "update_project",
      "update_task",
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

    const completed = await callToolJson<TaskResult>("complete_task", { id: task.id });
    expect(completed.status).toBe("done");

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
