import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { TEST_AUTH_HEADER, TEST_MCP_TOKEN } from "./constants";

const BASE_URL = "https://bitig.test";

const DB_SETUP_STATEMENTS = [
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  `CREATE TABLE \`projects\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`kind\` text DEFAULT 'hobby' NOT NULL,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL
  )`,
  `CREATE TABLE \`tasks\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`project_id\` text NOT NULL,
    \`title\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`status\` text DEFAULT 'todo' NOT NULL,
    \`is_public\` integer DEFAULT 0 NOT NULL,
    \`due_date\` text,
    \`priority\` text,
    \`labels\` text,
    \`order\` real,
    \`checklist\` text,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `tasks_project_id_idx` ON `tasks` (`project_id`)",
  "CREATE INDEX `tasks_status_idx` ON `tasks` (`status`)",
  "CREATE INDEX `tasks_order_idx` ON `tasks` (`order`)",
];

class WebStreamableTransport implements Transport {
  private readonly inner: StreamableHTTPClientTransport;

  constructor(url: URL, options: ConstructorParameters<typeof StreamableHTTPClientTransport>[1]) {
    this.inner = new StreamableHTTPClientTransport(url, options);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: Parameters<Transport["send"]>[0], options?: Parameters<Transport["send"]>[1]): Promise<void> {
    return this.inner.send(message, options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  set onclose(handler: () => void) {
    this.inner.onclose = handler;
  }

  set onerror(handler: (error: Error) => void) {
    this.inner.onerror = handler;
  }

  set onmessage(handler: NonNullable<Transport["onmessage"]>) {
    this.inner.onmessage = handler;
  }
}

function createMcpClient(token: string = TEST_MCP_TOKEN): {
  client: Client;
  transport: Transport;
} {
  const transport = new WebStreamableTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      return exports.default.fetch(request);
    },
  });

  const client = new Client({ name: "mcp-test-client", version: "1.0.0" }, { capabilities: {} });
  return { client, transport };
}

describe("Remote MCP Authentication", () => {
  it("rejects unauthenticated requests to /mcp with 401", async () => {
    const res = await exports.default.fetch(new Request(`${BASE_URL}/mcp`, { method: "POST" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with invalid Bearer token", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests using Basic Auth credentials on /mcp", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: TEST_AUTH_HEADER },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("rejects requests with empty Bearer header", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/mcp`, {
        method: "POST",
        headers: { Authorization: "Bearer " },
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="bitig-mcp"');
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("Remote MCP Protocol & Tool Execution", () => {
  let activeClient: Client | undefined;

  beforeEach(async () => {
    for (const statement of DB_SETUP_STATEMENTS) {
      await env.DB.prepare(statement).run();
    }
  });

  afterEach(async () => {
    if (activeClient) {
      try {
        await activeClient.close();
      } catch {
        // ignore error on close
      }
      activeClient = undefined;
    }
  });

  it("lists all registered Bitig tools", async () => {
    const { client, transport } = createMcpClient();
    activeClient = client;
    await client.connect(transport);

    const { tools } = await client.listTools();
    const toolNames = tools.map((t) => t.name).sort();

    expect(toolNames).toEqual([
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
  });

  it("executes the full project and task lifecycle over Streamable HTTP", async () => {
    const { client, transport } = createMcpClient();
    activeClient = client;
    await client.connect(transport);

    // 1. Create a project
    const createProjectRes = await client.callTool({
      name: "create_project",
      arguments: {
        name: "Remote Project",
        description: "Testing remote MCP",
        kind: "open_source",
      },
    });
    expect(createProjectRes.isError).toBeFalsy();

    const createdProjectText = (createProjectRes.content as { text: string }[])[0]?.text ?? "{}";
    const project = JSON.parse(createdProjectText) as {
      id: string;
      name: string;
      kind: string;
      bitig_file_content: string;
    };
    expect(project.name).toBe("Remote Project");
    expect(project.kind).toBe("open_source");
    expect(project.bitig_file_content).toContain(project.id);

    // 1b. Update the project
    const updateProjectRes = await client.callTool({
      name: "update_project",
      arguments: {
        id: project.id,
        name: "Remote Project Renamed",
        description: "Updated over remote MCP",
        kind: "paid",
      },
    });
    expect(updateProjectRes.isError).toBeFalsy();
    const updatedProject = JSON.parse((updateProjectRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      name: string;
      description: string;
      kind: string;
    };
    expect(updatedProject).toMatchObject({
      id: project.id,
      name: "Remote Project Renamed",
      description: "Updated over remote MCP",
      kind: "paid",
    });

    // 2. List projects
    const listProjectsRes = await client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(listProjectsRes.isError).toBeFalsy();
    const projectsList = JSON.parse((listProjectsRes.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
      name: string;
    }[];
    expect(projectsList.find((p) => p.id === project.id)?.name).toBe("Remote Project Renamed");

    // 3. Add a task
    const addTaskRes = await client.callTool({
      name: "add_task",
      arguments: {
        projectId: project.id,
        title: "Remote Task 1",
        description: "Remote task description",
        priority: "high",
        dueDate: "2026-11-01",
      },
    });
    expect(addTaskRes.isError).toBeFalsy();
    const task = JSON.parse((addTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      title: string;
      status: string;
      priority: string;
    };
    expect(task.title).toBe("Remote Task 1");
    expect(task.status).toBe("todo");
    expect(task.priority).toBe("high");

    // 4. Get task
    const getTaskRes = await client.callTool({
      name: "get_task",
      arguments: { id: task.id },
    });
    expect(getTaskRes.isError).toBeFalsy();
    const retrievedTask = JSON.parse((getTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      title: string;
    };
    expect(retrievedTask.id).toBe(task.id);

    // 5. List tasks filtered by projectId
    const listTasksRes = await client.callTool({
      name: "list_tasks",
      arguments: { projectId: project.id },
    });
    expect(listTasksRes.isError).toBeFalsy();
    const tasksList = JSON.parse((listTasksRes.content as { text: string }[])[0]?.text ?? "[]") as {
      id: string;
    }[];
    expect(tasksList.some((t) => t.id === task.id)).toBe(true);

    // 6. Complete task
    const completeTaskRes = await client.callTool({
      name: "complete_task",
      arguments: { id: task.id },
    });
    expect(completeTaskRes.isError).toBeFalsy();
    const completedTask = JSON.parse((completeTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      status: string;
    };
    expect(completedTask.status).toBe("done");

    // 7. Update task
    const updateTaskRes = await client.callTool({
      name: "update_task",
      arguments: {
        id: task.id,
        title: "Updated Remote Task Title",
      },
    });
    expect(updateTaskRes.isError).toBeFalsy();
    const updatedTask = JSON.parse((updateTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      title: string;
    };
    expect(updatedTask.title).toBe("Updated Remote Task Title");

    // 8. Delete task
    const deleteTaskRes = await client.callTool({
      name: "delete_task",
      arguments: { id: task.id },
    });
    expect(deleteTaskRes.isError).toBeFalsy();

    // Verify task is deleted
    const getDeletedTaskRes = await client.callTool({
      name: "get_task",
      arguments: { id: task.id },
    });
    expect(getDeletedTaskRes.isError).toBe(true);

    // 9. Delete project
    const deleteProjectRes = await client.callTool({
      name: "delete_project",
      arguments: { id: project.id },
    });
    expect(deleteProjectRes.isError).toBeFalsy();
  });

  it("handles multiple stateless requests without session state", async () => {
    // Client 1 creates a project
    const client1Setup = createMcpClient();
    await client1Setup.client.connect(client1Setup.transport);

    const createRes = await client1Setup.client.callTool({
      name: "create_project",
      arguments: { name: "Stateless Project" },
    });
    expect(createRes.isError).toBeFalsy();
    const proj = JSON.parse((createRes.content as { text: string }[])[0]?.text ?? "{}") as { id: string };
    await client1Setup.client.close();

    // Client 2 lists projects in a new connection and finds the project
    const client2Setup = createMcpClient();
    activeClient = client2Setup.client;
    await client2Setup.client.connect(client2Setup.transport);

    const listRes = await client2Setup.client.callTool({
      name: "list_projects",
      arguments: {},
    });
    expect(listRes.isError).toBeFalsy();
    const list = JSON.parse((listRes.content as { text: string }[])[0]?.text ?? "[]") as { id: string }[];
    expect(list.some((p) => p.id === proj.id)).toBe(true);
  });
});

