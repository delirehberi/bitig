import * as clack from "@clack/prompts";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import open from "open";

export const DEFAULT_MCP_URL = "https://bitig.emre.xyz/mcp";

export interface BitigCredentials {
  readonly token: string;
  readonly url: string;
  readonly updatedAt: string;
}

export interface ResolveCredentialsOptions {
  readonly tokenFlag?: string | undefined;
  readonly urlFlag?: string | undefined;
  readonly yes?: boolean | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly homedir?: string | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly openBrowserFn?: ((url: string) => Promise<unknown>) | undefined;
}

export interface TokenValidationResult {
  readonly ok: boolean;
  readonly serverName?: string | undefined;
  readonly serverVersion?: string | undefined;
  readonly error?: string | undefined;
}

export function getCredentialsConfigPath(
  homedir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdgConfig = env.XDG_CONFIG_HOME?.trim();
  const baseDir = xdgConfig && xdgConfig.length > 0 ? xdgConfig : path.join(homedir, ".config");
  return path.join(baseDir, "bitig", "config.json");
}

export function deriveTokensSettingsUrl(mcpUrl: string): string {
  try {
    const parsed = new URL(mcpUrl);
    return `${parsed.origin}/settings/tokens`;
  } catch {
    return "https://bitig.emre.xyz/settings/tokens";
  }
}

export function loadSavedCredentials(
  homedir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): BitigCredentials | null {
  const configPath = getCredentialsConfigPath(homedir, env);
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      const rec = raw as Record<string, unknown>;
      if (typeof rec.token === "string" && rec.token.trim().length > 0) {
        return {
          token: rec.token.trim(),
          url: typeof rec.url === "string" && rec.url.trim().length > 0 ? rec.url.trim() : DEFAULT_MCP_URL,
          updatedAt: typeof rec.updatedAt === "string" ? rec.updatedAt : new Date().toISOString(),
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function saveCredentials(
  credentials: BitigCredentials,
  homedir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configPath = getCredentialsConfigPath(homedir, env);
  const dir = path.dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  let existing: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const merged = {
    ...existing,
    token: credentials.token,
    url: credentials.url,
    updatedAt: credentials.updatedAt,
  };

  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  chmodSync(configPath, 0o600);
  return configPath;
}

export function removeSavedCredentials(
  homedir: string = os.homedir(),
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const configPath = getCredentialsConfigPath(homedir, env);
  if (!existsSync(configPath)) {
    return false;
  }
  rmSync(configPath, { force: true });
  return true;
}

export async function validateMcpToken(
  mcpUrl: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenValidationResult> {
  const trimmedToken = token.trim();
  if (trimmedToken.length === 0) {
    return { ok: false, error: "API token must not be empty." };
  }

  try {
    const response = await fetchFn(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${trimmedToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "@bitig/cli",
            version: "0.1.0",
          },
        },
      }),
    });

    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        error: `Authentication failed (HTTP ${String(response.status)}). Verify your Bitig MCP token.`,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: `MCP endpoint returned HTTP ${String(response.status)} ${response.statusText}.`,
      };
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const parsed = parseJsonRpcOrSsePayload(text, contentType);
    if (parsed !== null && typeof parsed === "object" && "result" in parsed) {
      const result = (parsed as { result?: unknown }).result;
      if (typeof result === "object" && result !== null && "serverInfo" in result) {
        const info = (result as { serverInfo?: { name?: unknown; version?: unknown } }).serverInfo;
        return {
          ok: true,
          serverName: typeof info?.name === "string" ? info.name : undefined,
          serverVersion: typeof info?.version === "string" ? info.version : undefined,
        };
      }
    }

    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reach Bitig MCP endpoint (${mcpUrl}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function parseJsonRpcOrSsePayload(body: string, contentType: string): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (line.startsWith("data:")) {
        const data = line.slice("data:".length).trim();
        if (data.length > 0) {
          try {
            return JSON.parse(data) as unknown;
          } catch {
            // continue scanning SSE data lines
          }
        }
      }
    }
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

export async function waitForLoopbackCallbackToken(timeoutMs = 120_000): Promise<{
  port: number;
  callbackUrl: string;
  waitForToken: () => Promise<string | null>;
  close: () => void;
}> {
  let resolveToken: ((token: string | null) => void) | undefined;
  const tokenPromise = new Promise<string | null>((resolve) => {
    resolveToken = resolve;
  });

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (reqUrl.pathname === "/callback") {
      const token = reqUrl.searchParams.get("token")?.trim();
      if (token && token.length > 0) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html><body style=\"font-family:sans-serif;padding:2rem\"><h2>Bitig CLI connected!</h2><p>You can close this tab and return to your terminal.</p></body></html>",
        );
        resolveToken?.(token);
        server.close();
        return;
      }
    }
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Missing token parameter.");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const timer = setTimeout(() => {
    resolveToken?.(null);
    server.close();
  }, timeoutMs);

  return {
    port,
    callbackUrl: `http://127.0.0.1:${String(port)}/callback`,
    waitForToken: async () => {
      try {
        return await tokenPromise;
      } finally {
        clearTimeout(timer);
      }
    },
    close: () => {
      clearTimeout(timer);
      resolveToken?.(null);
      server.close();
    },
  };
}

export async function authenticateAndSave(
  options: ResolveCredentialsOptions = {},
): Promise<{ credentials: BitigCredentials; configPath: string }> {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const fetchFn = options.fetchFn ?? fetch;
  const openBrowserFn = options.openBrowserFn ?? ((url: string) => open(url));

  const saved = loadSavedCredentials(homedir, env);
  const mcpUrl = (options.urlFlag?.trim() ?? env.BITIG_MCP_URL?.trim() ?? saved?.url ?? DEFAULT_MCP_URL);

  let token = options.tokenFlag?.trim() ?? env.BITIG_API_KEY?.trim();

  if (!token || token.length === 0) {
    if (options.yes) {
      if (saved?.token) {
        token = saved.token;
      } else {
        throw new Error(
          "No API token provided in headless mode. Pass --token <btg_token> or set BITIG_API_KEY.",
        );
      }
    } else {
      const settingsUrl = deriveTokensSettingsUrl(mcpUrl);
      const authMethod = await clack.select({
        message: "How would you like to authenticate with Bitig?",
        options: [
          {
            value: "browser",
            label: `Open ${settingsUrl} in browser and paste API token`,
          },
          {
            value: "paste",
            label: "Paste an existing Bitig API token directly",
          },
          ...(saved?.token
            ? [
                {
                  value: "saved",
                  label: "Use saved token from ~/.config/bitig/config.json",
                },
              ]
            : []),
        ],
      });

      if (clack.isCancel(authMethod)) {
        clack.cancel("Authentication cancelled.");
        throw new Error("Authentication cancelled by user.");
      }

      if (authMethod === "saved" && saved?.token) {
        token = saved.token;
      } else {
        if (authMethod === "browser") {
          try {
            await openBrowserFn(settingsUrl);
            clack.log.info(`Opened ${settingsUrl} in your browser.`);
          } catch {
            clack.log.warn(`Could not open browser automatically. Visit: ${settingsUrl}`);
          }
        }

        const entered = await clack.password({
          message: "Paste your Bitig MCP API token:",
          mask: "*",
          validate: (val) => {
            if (!val || val.trim().length === 0) {
              return "API token is required.";
            }
            return undefined;
          },
        });

        if (clack.isCancel(entered)) {
          clack.cancel("Authentication cancelled.");
          throw new Error("Authentication cancelled by user.");
        }
        token = entered.trim();
      }
    }
  }

  const spinner = options.yes ? null : clack.spinner();
  spinner?.start(`Validating token against ${mcpUrl}...`);

  const validation = await validateMcpToken(mcpUrl, token, fetchFn);
  if (!validation.ok) {
    spinner?.stop("Token validation failed.");
    throw new Error(validation.error ?? "Failed to validate Bitig MCP token.");
  }

  spinner?.stop(
    validation.serverName
      ? `Connected to ${validation.serverName}${validation.serverVersion ? ` v${validation.serverVersion}` : ""}`
      : "Authenticated with Bitig MCP server",
  );

  const credentials: BitigCredentials = {
    token,
    url: mcpUrl,
    updatedAt: new Date().toISOString(),
  };

  const configPath = saveCredentials(credentials, homedir, env);
  return { credentials, configPath };
}
