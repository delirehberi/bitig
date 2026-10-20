import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { RealtimeEventSchema, type RealtimeEvent } from "@bitig/core";
import { TEST_ALLOWED_ORIGIN, TEST_AUTH_HEADER, TEST_MCP_TOKEN } from "./constants";

const BASE_URL = "https://bitig.test";

const DB_SETUP_STATEMENTS = [
  "DROP TABLE IF EXISTS `comments`",
  "DROP TABLE IF EXISTS `tasks`",
  "DROP TABLE IF EXISTS `projects`",
  `CREATE TABLE \`projects\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`name\` text NOT NULL,
    \`description\` text DEFAULT '' NOT NULL,
    \`kind\` text DEFAULT 'hobby' NOT NULL,
    \`resources\` text,
    \`key\` text,
    \`archived\` integer,
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
    \`needs_human\` text,
    \`number\` integer,
    \`created_at\` integer NOT NULL,
    \`updated_at\` integer NOT NULL,
    FOREIGN KEY (\`project_id\`) REFERENCES \`projects\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `tasks_project_id_idx` ON `tasks` (`project_id`)",
  "CREATE INDEX `tasks_status_idx` ON `tasks` (`status`)",
  "CREATE INDEX `tasks_order_idx` ON `tasks` (`order`)",
  "CREATE INDEX `tasks_project_number_idx` ON `tasks` (`project_id`,`number`)",
  `CREATE TABLE \`comments\` (
    \`id\` text PRIMARY KEY NOT NULL,
    \`task_id\` text NOT NULL,
    \`body\` text NOT NULL,
    \`author_type\` text NOT NULL,
    \`author\` text,
    \`created_at\` integer NOT NULL,
    FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\`(\`id\`) ON UPDATE no action ON DELETE cascade
  )`,
  "CREATE INDEX `comments_task_id_idx` ON `comments` (`task_id`)",
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

function createMcpClient(): { client: Client; transport: Transport } {
  const transport = new WebStreamableTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${TEST_MCP_TOKEN}`,
      },
    },
    fetch: (input: string | URL | Request, init?: RequestInit) => exports.default.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "mcp-realtime-test", version: "1.0.0" }, { capabilities: {} });
  return { client, transport };
}

async function openRealtimeSocket(headers?: Record<string, string>): Promise<{
  ws: WebSocket;
  events: RealtimeEvent[];
}> {
  const res = await exports.default.fetch(
    new Request(`${BASE_URL}/api/realtime`, {
      headers: {
        Authorization: TEST_AUTH_HEADER,
        Upgrade: "websocket",
        ...headers,
      },
    }),
  );
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("Expected webSocket on 101 response");
  ws.accept();

  const events: RealtimeEvent[] = [];
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
    const parsed = RealtimeEventSchema.safeParse(JSON.parse(event.data));
    if (parsed.success) events.push(parsed.data);
  });

  return { ws, events };
}

describe("GET /api/realtime authentication & security", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/realtime`, {
        headers: { Upgrade: "websocket" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 426 when Upgrade: websocket header is missing", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/realtime`, {
        headers: { Authorization: TEST_AUTH_HEADER },
      }),
    );
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: "upgrade_required" });
  });

  it("blocks cross-origin WebSocket upgrades from untrusted origins with 403", async () => {
    const res = await exports.default.fetch(
      new Request(`${BASE_URL}/api/realtime`, {
        headers: {
          Authorization: TEST_AUTH_HEADER,
          Upgrade: "websocket",
          Origin: "https://evil.example.com",
        },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "forbidden" });
  });

  it("allows WebSocket upgrades from self-origin and ALLOWED_ORIGINS", async () => {
    const { ws } = await openRealtimeSocket({ Origin: TEST_ALLOWED_ORIGIN });
    ws.close();
  });
});

describe("RealtimeHub Durable Object broadcasts", () => {
  let activeClient: Client | undefined;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    await env.DB.batch(DB_SETUP_STATEMENTS.map((sql) => env.DB.prepare(sql)));
  });

  afterEach(async () => {
    while (openSockets.length > 0) {
      const ws = openSockets.pop();
      ws?.close();
    }
    if (activeClient) {
      await activeClient.close();
      activeClient = undefined;
    }
  });

  it("broadcasts MCP project, task, and comment mutations to connected WebSockets", async () => {
    const { ws, events } = await openRealtimeSocket();
    openSockets.push(ws);

    const { client, transport } = createMcpClient();
    activeClient = client;
    await client.connect(transport);

    // 1. Create project via MCP
    const createProjectRes = await client.callTool({
      name: "create_project",
      arguments: { name: "Bitig Realtime", key: "BIT" },
    });
    expect(createProjectRes.isError).toBeFalsy();
    const project = JSON.parse((createProjectRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
    };

    // 2. Add task via MCP
    const addTaskRes = await client.callTool({
      name: "add_task",
      arguments: {
        projectId: "BIT",
        title: "Realtime Update in web ui",
        status: "todo",
        priority: "urgent",
      },
    });
    expect(addTaskRes.isError).toBeFalsy();
    const createdTask = JSON.parse((addTaskRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
      code: string;
    };

    // 3. Move task from todo -> in_progress via MCP
    const updateTaskRes = await client.callTool({
      name: "update_task",
      arguments: {
        id: createdTask.code,
        status: "in_progress",
      },
    });
    expect(updateTaskRes.isError).toBeFalsy();

    // 4. Complete task (in_progress -> done) via MCP
    const completeTaskRes = await client.callTool({
      name: "complete_task",
      arguments: { id: createdTask.code },
    });
    expect(completeTaskRes.isError).toBeFalsy();

    // 5. Add comment via MCP
    const addCommentRes = await client.callTool({
      name: "add_comment",
      arguments: {
        taskId: createdTask.code,
        body: "Moved to done",
        author: "antigravity",
      },
    });
    expect(addCommentRes.isError).toBeFalsy();
    const comment = JSON.parse((addCommentRes.content as { text: string }[])[0]?.text ?? "{}") as {
      id: string;
    };

    // 6. Delete comment, task, and project via MCP
    await client.callTool({ name: "delete_comment", arguments: { id: comment.id } });
    await client.callTool({ name: "delete_task", arguments: { id: createdTask.id } });
    await client.callTool({ name: "delete_project", arguments: { id: project.id } });

    expect(events.map((e) => e.type)).toEqual([
      "project.created",
      "task.created",
      "task.updated",
      "task.updated",
      "comment.created",
      "comment.deleted",
      "task.deleted",
      "project.deleted",
    ]);

    expect(events[1]).toMatchObject({
      type: "task.created",
      task: { id: createdTask.id, status: "todo", title: "Realtime Update in web ui" },
    });
    expect(events[2]).toMatchObject({
      type: "task.updated",
      task: { id: createdTask.id, status: "in_progress" },
    });
    expect(events[3]).toMatchObject({
      type: "task.updated",
      task: { id: createdTask.id, status: "done" },
    });
  });

  it("broadcasts REST API mutations to multiple connected WebSocket clients", async () => {
    const clientA = await openRealtimeSocket();
    const clientB = await openRealtimeSocket();
    openSockets.push(clientA.ws, clientB.ws);

    const createProjRes = await exports.default.fetch(
      new Request(`${BASE_URL}/api/projects`, {
        method: "POST",
        headers: {
          Authorization: TEST_AUTH_HEADER,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "REST Project" }),
      }),
    );
    expect(createProjRes.status).toBe(201);
    const project = await createProjRes.json<{ id: string }>();

    const updateProjRes = await exports.default.fetch(
      new Request(`${BASE_URL}/api/projects/${project.id}`, {
        method: "PATCH",
        headers: {
          Authorization: TEST_AUTH_HEADER,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "REST Project Updated" }),
      }),
    );
    expect(updateProjRes.status).toBe(200);

    expect(clientA.events.map((e) => e.type)).toEqual(["project.created", "project.updated"]);
    expect(clientB.events.map((e) => e.type)).toEqual(["project.created", "project.updated"]);
  });
});
