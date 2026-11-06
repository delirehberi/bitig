import { existsSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claudeAdapter,
  codexAdapter,
  cursorAdapter,
  geminiAdapter,
  opencodeAdapter,
  windsurfAdapter,
  type AgentContext,
} from "./agents";
import { getCredentialsConfigPath, loadSavedCredentials } from "./auth";
import { runCli } from "./index";
import { getAgentSkillPaths, hasAgentSkillsInstalled } from "./skills";

describe("@bitig/cli agent provisioning & non-destructive config merge", () => {
  let tempHome: string;
  let ctx: AgentContext;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "bitig-cli-unit-"));
    ctx = {
      homedir: tempHome,
      env: { PATH: "" },
      preferCliForClaude: false,
    };
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("merges and disconnects ~/.claude.json without losing existing MCP servers or user settings and creates .bak", async () => {
    const claudePath = path.join(tempHome, ".claude.json");
    const initialClaude = {
      numStartups: 42,
      theme: "dark",
      mcpServers: {
        github: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
        },
      },
    };
    await fs.writeFile(claudePath, JSON.stringify(initialClaude, null, 2), "utf8");

    const res = await claudeAdapter.configure(ctx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_test_token_123",
    });

    expect(res.backupPath).toBe(`${claudePath}.bak`);
    expect(existsSync(`${claudePath}.bak`)).toBe(true);

    const backupParsed = JSON.parse(await fs.readFile(`${claudePath}.bak`, "utf8")) as Record<string, unknown>;
    expect(backupParsed).toEqual(initialClaude);

    const merged = JSON.parse(await fs.readFile(claudePath, "utf8")) as {
      numStartups: number;
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(merged.numStartups).toBe(42);
    expect(merged.theme).toBe("dark");
    expect(merged.mcpServers.github).toEqual(initialClaude.mcpServers.github);
    expect(merged.mcpServers.bitig).toEqual({
      type: "http",
      url: "https://bitig.emre.xyz/mcp",
      headers: {
        Authorization: "Bearer btg_test_token_123",
      },
    });
    expect(claudeAdapter.isConfigured(ctx)).toBe(true);

    const disc = await claudeAdapter.disconnect(ctx);
    expect(disc.removed).toBe(true);
    expect(claudeAdapter.isConfigured(ctx)).toBe(false);

    const afterDisconnect = JSON.parse(await fs.readFile(claudePath, "utf8")) as {
      numStartups: number;
      theme: string;
      mcpServers: Record<string, unknown>;
    };
    expect(afterDisconnect.numStartups).toBe(42);
    expect(afterDisconnect.theme).toBe("dark");
    expect(afterDisconnect.mcpServers.github).toEqual(initialClaude.mcpServers.github);
    expect(afterDisconnect.mcpServers.bitig).toBeUndefined();
  });

  it("prefers claude mcp add CLI command when available and falls back cleanly on error", async () => {
    const execCalls: { cmd: string; args: string[] }[] = [];
    const claudePath = path.join(tempHome, ".claude.json");

    const cliCtx: AgentContext = {
      homedir: tempHome,
      env: { PATH: "/usr/bin" },
      preferCliForClaude: true,
      execCommand: async (cmd, args) => {
        execCalls.push({ cmd, args });
        await fs.writeFile(
          claudePath,
          JSON.stringify({
            mcpServers: {
              bitig: {
                type: "http",
                url: "https://bitig.emre.xyz/mcp",
                headers: { Authorization: "Bearer btg_cli_token" },
              },
            },
          }),
          "utf8",
        );
        return { stdout: "Added", stderr: "" };
      },
    };

    const res = await claudeAdapter.configure(cliCtx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_cli_token",
    });

    expect(res.usedCliCommand).toBe(true);
    expect(execCalls[0]).toEqual({
      cmd: "claude",
      args: [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        "bitig",
        "https://bitig.emre.xyz/mcp",
        "--header",
        "Authorization: Bearer btg_cli_token",
      ],
    });
  });

  it("merges and disconnects ~/.codex/config.toml without losing existing TOML tables or MCP servers", async () => {
    const codexDir = path.join(tempHome, ".codex");
    const codexPath = path.join(codexDir, "config.toml");
    await fs.mkdir(codexDir, { recursive: true });

    const initialToml = `model = "gpt-5-codex"
approval_policy = "on-request"

[mcp_servers.existing_tool]
command = "npx"
args = ["-y", "some-mcp-server"]
`;
    await fs.writeFile(codexPath, initialToml, "utf8");

    const res = await codexAdapter.configure(ctx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_codex_secret",
    });

    expect(res.backupPath).toBe(`${codexPath}.bak`);
    expect(existsSync(`${codexPath}.bak`)).toBe(true);

    const mergedRaw = await fs.readFile(codexPath, "utf8");
    const merged = parseToml(mergedRaw) as {
      model: string;
      approval_policy: string;
      mcp_servers: Record<string, unknown>;
    };

    expect(merged.model).toBe("gpt-5-codex");
    expect(merged.approval_policy).toBe("on-request");
    expect(merged.mcp_servers.existing_tool).toEqual({
      command: "npx",
      args: ["-y", "some-mcp-server"],
    });
    expect(merged.mcp_servers.bitig).toEqual({
      url: "https://bitig.emre.xyz/mcp",
      http_headers: {
        Authorization: "Bearer btg_codex_secret",
      },
    });
    expect(codexAdapter.isConfigured(ctx)).toBe(true);

    const disc = await codexAdapter.disconnect(ctx);
    expect(disc.removed).toBe(true);
    expect(codexAdapter.isConfigured(ctx)).toBe(false);

    const afterRaw = await fs.readFile(codexPath, "utf8");
    const after = parseToml(afterRaw) as {
      model: string;
      approval_policy: string;
      mcp_servers: Record<string, unknown>;
    };
    expect(after.model).toBe("gpt-5-codex");
    expect(after.mcp_servers.existing_tool).toEqual({
      command: "npx",
      args: ["-y", "some-mcp-server"],
    });
    expect(after.mcp_servers.bitig).toBeUndefined();
  });

  it("merges and disconnects ~/.config/opencode/opencode.json (including JSONC comments) without losing settings", async () => {
    const opencodeDir = path.join(tempHome, ".config", "opencode");
    const opencodePath = path.join(opencodeDir, "opencode.json");
    await fs.mkdir(opencodeDir, { recursive: true });

    const initialJsonc = `{
  // User custom OpenCode config
  "$schema": "https://opencode.ai/config.json",
  "theme": "tokyonight",
  "mcp": {
    "sentry": {
      "type": "remote",
      "url": "https://mcp.sentry.dev/mcp",
    }
  }
}`;
    await fs.writeFile(opencodePath, initialJsonc, "utf8");

    const res = await opencodeAdapter.configure(ctx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_opencode_tok",
    });

    expect(res.backupPath).toBe(`${opencodePath}.bak`);
    expect(existsSync(`${opencodePath}.bak`)).toBe(true);

    const merged = JSON.parse(await fs.readFile(opencodePath, "utf8")) as {
      $schema: string;
      theme: string;
      mcp: Record<string, unknown>;
    };
    expect(merged.$schema).toBe("https://opencode.ai/config.json");
    expect(merged.theme).toBe("tokyonight");
    expect(merged.mcp.sentry).toEqual({
      type: "remote",
      url: "https://mcp.sentry.dev/mcp",
    });
    expect(merged.mcp.bitig).toEqual({
      type: "remote",
      url: "https://bitig.emre.xyz/mcp",
      headers: {
        Authorization: "Bearer btg_opencode_tok",
      },
    });

    const disc = await opencodeAdapter.disconnect(ctx);
    expect(disc.removed).toBe(true);

    const after = JSON.parse(await fs.readFile(opencodePath, "utf8")) as {
      theme: string;
      mcp: Record<string, unknown>;
    };
    expect(after.theme).toBe("tokyonight");
    expect(after.mcp.sentry).toBeDefined();
    expect(after.mcp.bitig).toBeUndefined();
  });

  it("merges and disconnects ~/.cursor/mcp.json, Windsurf, and Gemini CLI configs safely", async () => {
    const cursorDir = path.join(tempHome, ".cursor");
    const cursorPath = path.join(cursorDir, "mcp.json");
    await fs.mkdir(cursorDir, { recursive: true });
    await fs.writeFile(
      cursorPath,
      JSON.stringify({
        mcpServers: {
          postgres: { command: "mcp-postgres" },
        },
      }),
      "utf8",
    );

    const res = await cursorAdapter.configure(ctx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_cursor_tok",
    });
    expect(res.backupPath).toBe(`${cursorPath}.bak`);

    const merged = JSON.parse(await fs.readFile(cursorPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(merged.mcpServers.postgres).toEqual({ command: "mcp-postgres" });
    expect(merged.mcpServers.bitig).toEqual({
      type: "http",
      url: "https://bitig.emre.xyz/mcp",
      headers: { Authorization: "Bearer btg_cursor_tok" },
    });

    await windsurfAdapter.configure(ctx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_windsurf_tok",
    });
    await geminiAdapter.configure(ctx, {
      url: "https://bitig.emre.xyz/mcp",
      token: "btg_gemini_tok",
    });
    expect(windsurfAdapter.isConfigured(ctx)).toBe(true);
    expect(geminiAdapter.isConfigured(ctx)).toBe(true);

    await cursorAdapter.disconnect(ctx);
    const afterCursor = JSON.parse(await fs.readFile(cursorPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(afterCursor.mcpServers.postgres).toEqual({ command: "mcp-postgres" });
    expect(afterCursor.mcpServers.bitig).toBeUndefined();
  });

  it("runs connect (--token --yes --url), status (--json), and disconnect end-to-end", async () => {
    // Pre-create agent directories so auto-discovery detects Claude, Codex, OpenCode, and Cursor
    await fs.mkdir(path.join(tempHome, ".claude"), { recursive: true });
    await fs.mkdir(path.join(tempHome, ".codex"), { recursive: true });
    await fs.mkdir(path.join(tempHome, ".config", "opencode"), { recursive: true });
    await fs.mkdir(path.join(tempHome, ".cursor"), { recursive: true });

    const mockFetch: typeof fetch = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              serverInfo: { name: "bitig", version: "1.0.0" },
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      ),
    );

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const connectCode = await runCli(
        [
          "node",
          "bitig",
          "connect",
          "--token",
          "btg_headless_token",
          "--url",
          "https://selfhosted.bitig.test/mcp",
          "--yes",
        ],
        {
          homedir: tempHome,
          env: { PATH: "" },
          fetchFn: mockFetch,
          preferCliForClaude: false,
        },
      );
      expect(connectCode).toBe(0);

      // Verify ~/.config/bitig/config.json permissions (0600) and contents
      const credPath = getCredentialsConfigPath(tempHome, {});
      const stat = await fs.stat(credPath);
      expect(stat.mode & 0o777).toBe(0o600);

      const savedCreds = loadSavedCredentials(tempHome, {});
      expect(savedCreds?.token).toBe("btg_headless_token");
      expect(savedCreds?.url).toBe("https://selfhosted.bitig.test/mcp");

      // Verify skills were provisioned across Claude, Codex, and OpenCode
      for (const id of ["claude", "codex", "opencode", "cursor"] as const) {
        expect(hasAgentSkillsInstalled(id, tempHome)).toBe(true);
        for (const skillPath of getAgentSkillPaths(id, tempHome)) {
          const content = await fs.readFile(skillPath, "utf8");
          expect(content).toContain("in_progress");
          expect(content).toContain("in_review");
        }
      }

      // Run status --json
      logSpy.mockClear();
      const statusCode = await runCli(["node", "bitig", "status", "--json"], {
        homedir: tempHome,
        env: { PATH: "" },
        fetchFn: mockFetch,
      });
      expect(statusCode).toBe(0);

      const statusPayload = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as {
        connected: boolean;
        url: string;
        agents: { id: string; mcpConfigured: boolean; skillsInstalled: boolean }[];
      };
      expect(statusPayload.connected).toBe(true);
      expect(statusPayload.url).toBe("https://selfhosted.bitig.test/mcp");
      const claudeStatus = statusPayload.agents.find((a) => a.id === "claude");
      expect(claudeStatus?.mcpConfigured).toBe(true);
      expect(claudeStatus?.skillsInstalled).toBe(true);

      // Run disconnect
      const disconnectCode = await runCli(["node", "bitig", "disconnect", "--yes"], {
        homedir: tempHome,
        env: { PATH: "" },
        preferCliForClaude: false,
      });
      expect(disconnectCode).toBe(0);

      for (const id of ["claude", "codex", "opencode", "cursor"] as const) {
        expect(hasAgentSkillsInstalled(id, tempHome)).toBe(false);
      }
      expect(loadSavedCredentials(tempHome, {})).toBeNull();
    } finally {
      logSpy.mockRestore();
    }
  });
});
