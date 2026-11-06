import * as clack from "@clack/prompts";
import { Command } from "commander";
import * as os from "node:os";
import {
  ALL_AGENT_ADAPTERS,
  detectInstalledAgents,
  type AgentAdapter,
  type AgentContext,
  type AgentId,
} from "./agents";
import {
  authenticateAndSave,
  DEFAULT_MCP_URL,
  getCredentialsConfigPath,
  loadSavedCredentials,
  removeSavedCredentials,
  validateMcpToken,
} from "./auth";
import {
  hasAgentSkillsInstalled,
  installAgentSkills,
  removeAgentSkills,
  resolveSkillMarkdown,
} from "./skills";

export interface CliRuntimeDeps {
  readonly homedir?: string | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly fetchFn?: typeof fetch | undefined;
  readonly openBrowserFn?: ((url: string) => Promise<unknown>) | undefined;
  readonly execCommand?: ((cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>) | undefined;
  readonly preferCliForClaude?: boolean | undefined;
}

export async function runConnectCommand(
  opts: {
    token?: string | undefined;
    url?: string | undefined;
    yes?: boolean | undefined;
  },
  deps: CliRuntimeDeps = {},
): Promise<number> {
  const homedir = deps.homedir ?? os.homedir();
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;
  const isHeadless = Boolean(opts.yes);

  if (!isHeadless) {
    clack.intro("Bitig Connect — MCP & Agent Skill Provisioner");
  }

  const { credentials, configPath } = await authenticateAndSave({
    tokenFlag: opts.token,
    urlFlag: opts.url,
    yes: isHeadless,
    env,
    homedir,
    fetchFn,
    openBrowserFn: deps.openBrowserFn,
  });

  const agentCtx: AgentContext = {
    homedir,
    env,
    execCommand: deps.execCommand,
    preferCliForClaude: deps.preferCliForClaude,
  };

  const detected = detectInstalledAgents(agentCtx);
  let selectedAdapters: AgentAdapter[];

  if (isHeadless) {
    selectedAdapters = detected;
  } else {
    const detectedIds = new Set(detected.map((d) => d.id));
    const chosenIds = await clack.multiselect<AgentId>({
      message: "Select coding agents to configure with Bitig MCP & skills:",
      options: ALL_AGENT_ADAPTERS.map((adapter) => ({
        value: adapter.id,
        label: adapter.name,
        hint: detectedIds.has(adapter.id) ? "detected" : "not detected",
      })),
      initialValues: detected.map((d) => d.id),
      required: false,
    });

    if (clack.isCancel(chosenIds)) {
      clack.cancel("Setup cancelled.");
      return 1;
    }

    const chosenSet = new Set(chosenIds);
    selectedAdapters = ALL_AGENT_ADAPTERS.filter((a) => chosenSet.has(a.id));
  }

  const configuredAgents: string[] = [];
  for (const adapter of selectedAdapters) {
    const result = await adapter.configure(agentCtx, {
      url: credentials.url,
      token: credentials.token,
    });
    configuredAgents.push(`${adapter.name} (${result.configPath})`);
  }

  const skillContent = await resolveSkillMarkdown({
    fetchFn,
    skipRemote: deps.fetchFn === undefined,
  });
  const installedSkillPaths = installAgentSkills(
    selectedAdapters.map((a) => a.id),
    homedir,
    skillContent,
  );

  if (isHeadless) {
    console.log(`Saved credentials to ${configPath}`);
    console.log(
      `Configured ${String(configuredAgents.length)} agent(s): ${selectedAdapters.map((a) => a.id).join(", ") || "none"}`,
    );
    console.log(`Installed ${String(installedSkillPaths.length)} skill/command file(s).`);
  } else {
    if (configuredAgents.length > 0) {
      clack.log.success(`Configured MCP for:\n  - ${configuredAgents.join("\n  - ")}`);
    } else {
      clack.log.warn("No local agents selected for MCP configuration.");
    }
    if (installedSkillPaths.length > 0) {
      clack.log.success(`Installed Bitig skills & commands:\n  - ${installedSkillPaths.join("\n  - ")}`);
    }
    clack.outro("Bitig connection complete!");
  }

  return 0;
}

export async function runStatusCommand(
  opts: {
    url?: string | undefined;
    token?: string | undefined;
    json?: boolean | undefined;
  },
  deps: CliRuntimeDeps = {},
): Promise<number> {
  const homedir = deps.homedir ?? os.homedir();
  const env = deps.env ?? process.env;
  const fetchFn = deps.fetchFn ?? fetch;

  const saved = loadSavedCredentials(homedir, env);
  const configPath = getCredentialsConfigPath(homedir, env);
  const mcpUrl = opts.url?.trim() ?? env.BITIG_MCP_URL?.trim() ?? saved?.url ?? DEFAULT_MCP_URL;
  const token = opts.token?.trim() ?? env.BITIG_API_KEY?.trim() ?? saved?.token;

  let endpointReachable = false;
  let endpointError: string | undefined;
  let serverName: string | undefined;
  let serverVersion: string | undefined;

  if (token) {
    const check = await validateMcpToken(mcpUrl, token, fetchFn);
    endpointReachable = check.ok;
    endpointError = check.error;
    serverName = check.serverName;
    serverVersion = check.serverVersion;
  } else {
    endpointError = "No saved credentials or token found.";
  }

  const agentCtx: AgentContext = { homedir, env };
  const agentsStatus = ALL_AGENT_ADAPTERS.map((adapter) => ({
    id: adapter.id,
    name: adapter.name,
    detected: adapter.isDetected(agentCtx),
    mcpConfigured: adapter.isConfigured(agentCtx),
    skillsInstalled: hasAgentSkillsInstalled(adapter.id, homedir),
    configPath: adapter.getConfigPath(agentCtx),
  }));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          url: mcpUrl,
          credentialsFile: configPath,
          hasCredentials: Boolean(token),
          connected: endpointReachable,
          serverName,
          serverVersion,
          error: endpointError,
          agents: agentsStatus,
        },
        null,
        2,
      ),
    );
    return endpointReachable ? 0 : 1;
  }

  console.log(`Bitig MCP Endpoint: ${mcpUrl}`);
  console.log(`Credentials File:   ${configPath} (${token ? "present" : "missing"})`);
  console.log(
    `Connection Status:  ${
      endpointReachable
        ? `Connected${serverName ? ` (${serverName}${serverVersion ? ` v${serverVersion}` : ""})` : ""}`
        : `Disconnected (${endpointError ?? "unknown error"})`
    }`,
  );
  console.log("\nLocal Coding Agents:");
  for (const agent of agentsStatus) {
    const mcpLabel = agent.mcpConfigured ? "MCP: configured" : "MCP: not configured";
    const skillLabel = agent.skillsInstalled ? "Skills: installed" : "Skills: not installed";
    const detectLabel = agent.detected ? "detected" : "not detected";
    console.log(`  - ${agent.name} [${detectLabel}] -> ${mcpLabel}, ${skillLabel}`);
  }

  return endpointReachable ? 0 : 1;
}

export async function runDisconnectCommand(
  opts: {
    yes?: boolean | undefined;
  },
  deps: CliRuntimeDeps = {},
): Promise<number> {
  const homedir = deps.homedir ?? os.homedir();
  const env = deps.env ?? process.env;
  const agentCtx: AgentContext = {
    homedir,
    env,
    execCommand: deps.execCommand,
    preferCliForClaude: deps.preferCliForClaude,
  };

  if (!opts.yes) {
    const confirmed = await clack.confirm({
      message: "Remove Bitig MCP configuration, skills, and saved credentials from all local agents?",
      initialValue: true,
    });
    if (clack.isCancel(confirmed) || !confirmed) {
      clack.cancel("Disconnect cancelled.");
      return 1;
    }
  }

  const removedConfigs: string[] = [];
  for (const adapter of ALL_AGENT_ADAPTERS) {
    const res = await adapter.disconnect(agentCtx);
    if (res.removed) {
      removedConfigs.push(`${adapter.name} (${res.configPath})`);
    }
  }

  const removedSkills = removeAgentSkills(
    ALL_AGENT_ADAPTERS.map((a) => a.id),
    homedir,
  );
  const removedCreds = removeSavedCredentials(homedir, env);

  console.log(
    `Removed Bitig MCP entry from ${String(removedConfigs.length)} agent config(s)${
      removedConfigs.length > 0 ? `: ${removedConfigs.join(", ")}` : "."
    }`,
  );
  console.log(`Removed ${String(removedSkills.length)} skill/command file(s).`);
  if (removedCreds) {
    console.log("Removed saved credentials (~/.config/bitig/config.json).");
  }

  return 0;
}

export async function runCli(
  argv: string[] = process.argv,
  deps: CliRuntimeDeps = {},
): Promise<number> {
  const program = new Command();
  let exitCode = 0;

  program
    .name("bitig")
    .description("Bitig MCP & Agent Skill Provisioner (@bitig/cli)")
    .version("0.1.0");

  program
    .command("connect")
    .description("Authenticate with Bitig MCP and configure local coding agents & skills")
    .option("--token <token>", "Bitig MCP API token (or set BITIG_API_KEY)")
    .option("--url <url>", "Bitig MCP server URL", DEFAULT_MCP_URL)
    .option("-y, --yes", "Headless mode: skip interactive prompts and configure all detected agents")
    .action(async (options: { token?: string; url?: string; yes?: boolean }) => {
      exitCode = await runConnectCommand(options, deps);
    });

  program
    .command("status")
    .description("Verify connection to Bitig MCP and list configured local agents & skills")
    .option("--token <token>", "Bitig MCP API token override")
    .option("--url <url>", "Bitig MCP server URL override")
    .option("--json", "Output status in JSON format")
    .action(async (options: { token?: string; url?: string; json?: boolean }) => {
      exitCode = await runStatusCommand(options, deps);
    });

  program
    .command("disconnect")
    .description("Remove Bitig MCP entry and skill files from all local agent configs")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (options: { yes?: boolean }) => {
      exitCode = await runDisconnectCommand({ yes: options.yes ?? true }, deps);
    });

  try {
    await program.parseAsync(argv);
    return exitCode;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

export * from "./agents";
export * from "./auth";
export * from "./skills";

if (
  import.meta.url.startsWith("file:") &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1])
) {
  runCli()
    .then((code) => {
      if (code !== 0) {
        process.exit(code);
      }
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
