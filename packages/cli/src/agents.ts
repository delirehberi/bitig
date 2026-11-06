import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

const execFileAsync = promisify(execFile);

export type AgentId = "claude" | "codex" | "opencode" | "cursor" | "windsurf" | "gemini";

export interface AgentContext {
  readonly homedir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly execCommand?: ((cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>) | undefined;
  readonly preferCliForClaude?: boolean | undefined;
}

export interface AgentConnectionConfig {
  readonly url: string;
  readonly token: string;
}

export interface AgentConfigureResult {
  readonly agentId: AgentId;
  readonly configPath: string;
  readonly backupPath: string | null;
  readonly usedCliCommand: boolean;
}

export interface AgentDisconnectResult {
  readonly agentId: AgentId;
  readonly configPath: string;
  readonly backupPath: string | null;
  readonly removed: boolean;
}

export interface AgentAdapter {
  readonly id: AgentId;
  readonly name: string;
  readonly binaries: readonly string[];
  getConfigPath(ctx: AgentContext): string;
  getDetectDirs(ctx: AgentContext): readonly string[];
  isDetected(ctx: AgentContext): boolean;
  isConfigured(ctx: AgentContext): boolean;
  configure(ctx: AgentContext, config: AgentConnectionConfig): Promise<AgentConfigureResult>;
  disconnect(ctx: AgentContext): Promise<AgentDisconnectResult>;
}

export function isBinaryInPath(
  binary: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const pathEnv = env.PATH ?? "";
  if (pathEnv.length === 0) {
    return false;
  }
  const dirs = pathEnv.split(path.delimiter).filter((d) => d.length > 0);
  const extensions = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${binary}${ext}`);
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          return true;
        }
      } catch {
        // Ignore unreadable PATH entries
      }
    }
  }
  return false;
}

export function stripJsonCommentsAndTrailingCommas(input: string): string {
  let out = "";
  let inString = false;
  let stringQuote = '"';
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      out += ch ?? "";
      if (ch === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (ch === stringQuote) {
        inString = false;
      }
      i += 1;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      i += 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < input.length && input[i] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) {
        i += 1;
      }
      i += 2;
      continue;
    }

    out += ch ?? "";
    i += 1;
  }

  return out.replace(/,\s*([}\]])/g, "$1");
}

export function parseJsonOrJsoncObject(content: string, filePath: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    try {
      parsed = JSON.parse(stripJsonCommentsAndTrailingCommas(trimmed)) as unknown;
    } catch (err) {
      throw new Error(
        `Failed to parse JSON config at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected top-level JSON object in ${filePath}`);
  }
  return { ...(parsed as Record<string, unknown>) };
}

export function backupFileIfExists(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const backupPath = `${filePath}.bak`;
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function readJsonFileOrEmpty(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf8");
  return parseJsonOrJsoncObject(raw, filePath);
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function mergeJsonMcpKey(
  filePath: string,
  containerKey: "mcpServers" | "mcp",
  bitigPayload: Record<string, unknown>,
): { backupPath: string | null } {
  const existing = readJsonFileOrEmpty(filePath);
  const backupPath = backupFileIfExists(filePath);

  const currentContainer = existing[containerKey];
  const containerObj =
    typeof currentContainer === "object" && currentContainer !== null && !Array.isArray(currentContainer)
      ? { ...(currentContainer as Record<string, unknown>) }
      : {};

  const currentBitig = containerObj.bitig;
  const bitigObj =
    typeof currentBitig === "object" && currentBitig !== null && !Array.isArray(currentBitig)
      ? { ...(currentBitig as Record<string, unknown>), ...bitigPayload }
      : { ...bitigPayload };

  containerObj.bitig = bitigObj;
  existing[containerKey] = containerObj;

  writeJsonFile(filePath, existing);
  return { backupPath };
}

function removeJsonMcpKey(
  filePath: string,
  containerKey: "mcpServers" | "mcp",
): { backupPath: string | null; removed: boolean } {
  if (!existsSync(filePath)) {
    return { backupPath: null, removed: false };
  }

  const existing = readJsonFileOrEmpty(filePath);
  const currentContainer = existing[containerKey];
  if (
    typeof currentContainer !== "object" ||
    currentContainer === null ||
    Array.isArray(currentContainer) ||
    !("bitig" in currentContainer)
  ) {
    return { backupPath: null, removed: false };
  }

  const backupPath = backupFileIfExists(filePath);
  const containerObj = { ...(currentContainer as Record<string, unknown>) };
  delete containerObj.bitig;
  existing[containerKey] = containerObj;

  writeJsonFile(filePath, existing);
  return { backupPath, removed: true };
}

function hasJsonMcpKey(filePath: string, containerKey: "mcpServers" | "mcp"): boolean {
  if (!existsSync(filePath)) {
    return false;
  }
  try {
    const existing = readJsonFileOrEmpty(filePath);
    const currentContainer = existing[containerKey];
    return (
      typeof currentContainer === "object" &&
      currentContainer !== null &&
      !Array.isArray(currentContainer) &&
      "bitig" in currentContainer
    );
  } catch {
    return false;
  }
}

function createJsonMcpAdapter(opts: {
  id: AgentId;
  name: string;
  binaries: readonly string[];
  configRelPath: string;
  detectRelDirs: readonly string[];
  containerKey: "mcpServers" | "mcp";
  buildEntry: (config: AgentConnectionConfig) => Record<string, unknown>;
  preferCliCommand?: (
    ctx: AgentContext,
    config: AgentConnectionConfig,
  ) => Promise<boolean>;
  removeCliCommand?: (ctx: AgentContext) => Promise<boolean>;
}): AgentAdapter {
  return {
    id: opts.id,
    name: opts.name,
    binaries: opts.binaries,
    getConfigPath(ctx: AgentContext): string {
      return path.join(ctx.homedir, opts.configRelPath);
    },
    getDetectDirs(ctx: AgentContext): readonly string[] {
      return opts.detectRelDirs.map((rel) => path.join(ctx.homedir, rel));
    },
    isDetected(ctx: AgentContext): boolean {
      const configPath = this.getConfigPath(ctx);
      if (existsSync(configPath)) {
        return true;
      }
      for (const dir of this.getDetectDirs(ctx)) {
        if (existsSync(dir)) {
          return true;
        }
      }
      for (const bin of opts.binaries) {
        if (isBinaryInPath(bin, ctx.env)) {
          return true;
        }
      }
      return false;
    },
    isConfigured(ctx: AgentContext): boolean {
      return hasJsonMcpKey(this.getConfigPath(ctx), opts.containerKey);
    },
    async configure(
      ctx: AgentContext,
      config: AgentConnectionConfig,
    ): Promise<AgentConfigureResult> {
      const configPath = this.getConfigPath(ctx);
      let usedCliCommand = false;
      let preCliBackup: string | null = null;

      if (opts.preferCliCommand) {
        preCliBackup = backupFileIfExists(configPath);
        usedCliCommand = await opts.preferCliCommand(ctx, config);
      }

      if (usedCliCommand && hasJsonMcpKey(configPath, opts.containerKey)) {
        return {
          agentId: opts.id,
          configPath,
          backupPath: preCliBackup,
          usedCliCommand: true,
        };
      }

      const { backupPath } = mergeJsonMcpKey(
        configPath,
        opts.containerKey,
        opts.buildEntry(config),
      );
      return {
        agentId: opts.id,
        configPath,
        backupPath: preCliBackup ?? backupPath,
        usedCliCommand,
      };
    },
    async disconnect(ctx: AgentContext): Promise<AgentDisconnectResult> {
      const configPath = this.getConfigPath(ctx);
      if (opts.removeCliCommand) {
        await opts.removeCliCommand(ctx);
      }
      const { backupPath, removed } = removeJsonMcpKey(configPath, opts.containerKey);
      return {
        agentId: opts.id,
        configPath,
        backupPath,
        removed,
      };
    },
  };
}

export const claudeAdapter: AgentAdapter = createJsonMcpAdapter({
  id: "claude",
  name: "Claude Code",
  binaries: ["claude"],
  configRelPath: ".claude.json",
  detectRelDirs: [".claude"],
  containerKey: "mcpServers",
  buildEntry: ({ url, token }) => ({
    type: "http",
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }),
  preferCliCommand: async (ctx, { url, token }) => {
    if (ctx.preferCliForClaude === false) {
      return false;
    }
    const isDefaultHome = path.resolve(ctx.homedir) === path.resolve(os.homedir());
    if (!isDefaultHome && !ctx.execCommand) {
      return false;
    }
    if (!isBinaryInPath("claude", ctx.env) && !ctx.execCommand) {
      return false;
    }
    const execFn =
      ctx.execCommand ??
      ((cmd: string, args: string[]) => execFileAsync(cmd, args, { env: { ...process.env, ...ctx.env } }));
    try {
      await execFn("claude", [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        "user",
        "bitig",
        url,
        "--header",
        `Authorization: Bearer ${token}`,
      ]);
      return true;
    } catch {
      return false;
    }
  },
  removeCliCommand: async (ctx) => {
    if (ctx.preferCliForClaude === false) {
      return false;
    }
    const isDefaultHome = path.resolve(ctx.homedir) === path.resolve(os.homedir());
    if (!isDefaultHome && !ctx.execCommand) {
      return false;
    }
    if (!isBinaryInPath("claude", ctx.env) && !ctx.execCommand) {
      return false;
    }
    const execFn =
      ctx.execCommand ??
      ((cmd: string, args: string[]) => execFileAsync(cmd, args, { env: { ...process.env, ...ctx.env } }));
    try {
      await execFn("claude", ["mcp", "remove", "--scope", "user", "bitig"]);
      return true;
    } catch {
      return false;
    }
  },
});

export const codexAdapter: AgentAdapter = {
  id: "codex",
  name: "OpenAI Codex CLI",
  binaries: ["codex"],
  getConfigPath(ctx: AgentContext): string {
    return path.join(ctx.homedir, ".codex", "config.toml");
  },
  getDetectDirs(ctx: AgentContext): readonly string[] {
    return [path.join(ctx.homedir, ".codex")];
  },
  isDetected(ctx: AgentContext): boolean {
    if (existsSync(this.getConfigPath(ctx))) {
      return true;
    }
    for (const dir of this.getDetectDirs(ctx)) {
      if (existsSync(dir)) {
        return true;
      }
    }
    return isBinaryInPath("codex", ctx.env);
  },
  isConfigured(ctx: AgentContext): boolean {
    const configPath = this.getConfigPath(ctx);
    if (!existsSync(configPath)) {
      return false;
    }
    try {
      const parsed = parseToml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
      const servers = parsed.mcp_servers;
      return (
        typeof servers === "object" &&
        servers !== null &&
        !Array.isArray(servers) &&
        "bitig" in servers
      );
    } catch {
      return false;
    }
  },
  configure(
    ctx: AgentContext,
    config: AgentConnectionConfig,
  ): Promise<AgentConfigureResult> {
    const configPath = this.getConfigPath(ctx);
    let parsed: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      const raw = readFileSync(configPath, "utf8");
      if (raw.trim().length > 0) {
        parsed = parseToml(raw);
      }
    }

    const backupPath = backupFileIfExists(configPath);
    const currentServers = parsed.mcp_servers;
    const serversObj =
      typeof currentServers === "object" && currentServers !== null && !Array.isArray(currentServers)
        ? { ...(currentServers as Record<string, unknown>) }
        : {};

    const currentBitig = serversObj.bitig;
    const bitigEntry =
      typeof currentBitig === "object" && currentBitig !== null && !Array.isArray(currentBitig)
        ? { ...(currentBitig as Record<string, unknown>) }
        : {};

    bitigEntry.url = config.url;
    bitigEntry.http_headers = {
      Authorization: `Bearer ${config.token}`,
    };

    serversObj.bitig = bitigEntry;
    parsed.mcp_servers = serversObj;

    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${stringifyToml(parsed).trimEnd()}\n`, "utf8");

    return Promise.resolve({
      agentId: "codex",
      configPath,
      backupPath,
      usedCliCommand: false,
    });
  },
  disconnect(ctx: AgentContext): Promise<AgentDisconnectResult> {
    const configPath = this.getConfigPath(ctx);
    if (!existsSync(configPath)) {
      return Promise.resolve({
        agentId: "codex",
        configPath,
        backupPath: null,
        removed: false,
      });
    }

    const raw = readFileSync(configPath, "utf8");
    const parsed = (raw.trim().length > 0 ? parseToml(raw) : {}) as Record<string, unknown>;
    const currentServers = parsed.mcp_servers;
    if (
      typeof currentServers !== "object" ||
      currentServers === null ||
      Array.isArray(currentServers) ||
      !("bitig" in currentServers)
    ) {
      return Promise.resolve({
        agentId: "codex",
        configPath,
        backupPath: null,
        removed: false,
      });
    }

    const backupPath = backupFileIfExists(configPath);
    const serversObj = { ...(currentServers as Record<string, unknown>) };
    delete serversObj.bitig;
    parsed.mcp_servers = serversObj;

    writeFileSync(configPath, `${stringifyToml(parsed).trimEnd()}\n`, "utf8");
    return Promise.resolve({
      agentId: "codex",
      configPath,
      backupPath,
      removed: true,
    });
  },
};

export const opencodeAdapter: AgentAdapter = createJsonMcpAdapter({
  id: "opencode",
  name: "OpenCode",
  binaries: ["opencode"],
  configRelPath: path.join(".config", "opencode", "opencode.json"),
  detectRelDirs: [path.join(".config", "opencode")],
  containerKey: "mcp",
  buildEntry: ({ url, token }) => ({
    type: "remote",
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }),
});

export const cursorAdapter: AgentAdapter = createJsonMcpAdapter({
  id: "cursor",
  name: "Cursor",
  binaries: ["cursor"],
  configRelPath: path.join(".cursor", "mcp.json"),
  detectRelDirs: [".cursor"],
  containerKey: "mcpServers",
  buildEntry: ({ url, token }) => ({
    type: "http",
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }),
});

export const windsurfAdapter: AgentAdapter = createJsonMcpAdapter({
  id: "windsurf",
  name: "Windsurf",
  binaries: ["windsurf"],
  configRelPath: path.join(".codeium", "windsurf", "mcp_config.json"),
  detectRelDirs: [path.join(".codeium", "windsurf"), ".windsurf"],
  containerKey: "mcpServers",
  buildEntry: ({ url, token }) => ({
    serverUrl: url,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }),
});

export const geminiAdapter: AgentAdapter = createJsonMcpAdapter({
  id: "gemini",
  name: "Gemini CLI",
  binaries: ["gemini"],
  configRelPath: path.join(".gemini", "settings.json"),
  detectRelDirs: [".gemini"],
  containerKey: "mcpServers",
  buildEntry: ({ url, token }) => ({
    httpUrl: url,
    url,
    headers: {
      Authorization: `Bearer ${token}`,
    },
  }),
});

export const ALL_AGENT_ADAPTERS: readonly AgentAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  cursorAdapter,
  windsurfAdapter,
  geminiAdapter,
];

export function detectInstalledAgents(ctx: AgentContext): AgentAdapter[] {
  return ALL_AGENT_ADAPTERS.filter((adapter) => adapter.isDetected(ctx));
}

export function getAgentAdapter(id: AgentId): AgentAdapter | undefined {
  return ALL_AGENT_ADAPTERS.find((a) => a.id === id);
}
