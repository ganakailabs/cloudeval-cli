import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type McpSetupClient = "codex" | "claude" | "cursor";
export type McpSetupToolset = "all" | "readonly" | "projects" | "reports" | "billing";

export interface McpServerConfig {
  command: string;
  args: string[];
}

export interface McpClientSetup {
  client: McpSetupClient;
  transport: "stdio";
  configPath?: string;
  server: McpServerConfig;
  config?: {
    mcpServers: {
      cloudeval: McpServerConfig;
    };
  };
  instructions: string[];
}

export interface BuildMcpClientSetupOptions {
  client: McpSetupClient;
  command?: string;
  toolset?: McpSetupToolset;
  configPath?: string;
}

const CLIENTS = new Set<McpSetupClient>(["codex", "claude", "cursor"]);
const TOOLSETS = new Set<McpSetupToolset>([
  "all",
  "readonly",
  "projects",
  "reports",
  "billing",
]);

export const normalizeMcpSetupClient = (value: string): McpSetupClient => {
  const normalized = value.toLowerCase() as McpSetupClient;
  if (CLIENTS.has(normalized)) {
    return normalized;
  }
  throw new Error("MCP setup client must be one of: codex, claude, cursor.");
};

export const normalizeMcpSetupToolset = (value?: string): McpSetupToolset => {
  const normalized = (value ?? "all").toLowerCase() as McpSetupToolset;
  if (TOOLSETS.has(normalized)) {
    return normalized;
  }
  throw new Error("MCP toolset must be one of: all, readonly, projects, reports, billing.");
};

const defaultConfigPath = (client: McpSetupClient): string | undefined => {
  if (client === "claude") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json"
    );
  }
  if (client === "cursor") {
    return path.join(os.homedir(), ".cursor", "mcp.json");
  }
  return undefined;
};

const buildServer = (command: string, toolset: McpSetupToolset): McpServerConfig => ({
  command,
  args: [
    "mcp",
    "serve",
    ...(toolset === "all" ? [] : ["--toolset", toolset]),
  ],
});

const shellQuote = (value: string): string =>
  /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;

export const buildMcpClientSetup = ({
  client,
  command = "cloudeval",
  toolset = "all",
  configPath,
}: BuildMcpClientSetupOptions): McpClientSetup => {
  const normalizedClient = normalizeMcpSetupClient(client);
  const normalizedToolset = normalizeMcpSetupToolset(toolset);
  const server = buildServer(command, normalizedToolset);
  const setup: McpClientSetup = {
    client: normalizedClient,
    transport: "stdio",
    configPath: configPath ?? defaultConfigPath(normalizedClient),
    server,
    instructions: [],
  };

  if (normalizedClient === "codex") {
    setup.instructions.push(
      `codex mcp add cloudeval -- ${[server.command, ...server.args].map(shellQuote).join(" ")}`
    );
    return setup;
  }

  setup.config = {
    mcpServers: {
      cloudeval: server,
    },
  };
  setup.instructions.push(
    `Merge the shown mcpServers.cloudeval entry into ${setup.configPath}. Restart ${normalizedClient === "claude" ? "Claude Desktop" : "Cursor"} after updating the file.`
  );
  return setup;
};

const readJsonObject = async (filePath: string): Promise<Record<string, unknown>> => {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw error;
  }
};

export const writeMcpClientConfig = async (setup: McpClientSetup): Promise<string | undefined> => {
  if (!setup.configPath || !setup.config) {
    return undefined;
  }
  const current = await readJsonObject(setup.configPath);
  const currentServers =
    current.mcpServers && typeof current.mcpServers === "object" && !Array.isArray(current.mcpServers)
      ? current.mcpServers as Record<string, unknown>
      : {};
  const next = {
    ...current,
    mcpServers: {
      ...currentServers,
      cloudeval: setup.server,
    },
  };
  await fs.mkdir(path.dirname(setup.configPath), { recursive: true });
  await fs.writeFile(setup.configPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return setup.configPath;
};
