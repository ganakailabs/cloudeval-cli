import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type McpSetupClient = "codex" | "claude" | "cursor" | "vscode" | "generic";
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
  config?: Record<string, unknown>;
  instructions: string[];
}

export interface BuildMcpClientSetupOptions {
  client: McpSetupClient;
  command?: string;
  toolset?: McpSetupToolset;
  configPath?: string;
}

export const MCP_SETUP_CLIENTS: McpSetupClient[] = ["codex", "claude", "cursor", "vscode", "generic"];

const CLIENTS = new Set<McpSetupClient>(MCP_SETUP_CLIENTS);
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
  throw new Error(`MCP setup client must be one of: ${MCP_SETUP_CLIENTS.join(", ")}.`);
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
  if (client === "vscode") {
    return path.join(process.cwd(), ".vscode", "mcp.json");
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

  if (normalizedClient === "vscode") {
    setup.config = {
      servers: {
        cloudeval: {
          type: "stdio",
          ...server,
        },
      },
    };
    setup.instructions.push(
      `Merge the shown servers.cloudeval entry into ${setup.configPath}. In VS Code, run MCP: List Servers or reload the window after updating the file.`
    );
    setup.instructions.push(
      `For user-profile setup, run: code --add-mcp ${shellQuote(JSON.stringify({ name: "cloudeval", type: "stdio", ...server }))}`
    );
    return setup;
  }

  setup.config = {
    mcpServers: {
      cloudeval: server,
    },
  };
  if (normalizedClient === "generic") {
    setup.instructions.push(
      "Copy the shown mcpServers.cloudeval entry into your MCP client's configuration. Use stdio transport."
    );
    return setup;
  }

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
  const groupKey = setup.client === "vscode" ? "servers" : "mcpServers";
  const nextServer =
    setup.client === "vscode"
      ? { type: "stdio", ...setup.server }
      : setup.server;
  const currentServers =
    current[groupKey] && typeof current[groupKey] === "object" && !Array.isArray(current[groupKey])
      ? current[groupKey] as Record<string, unknown>
      : {};
  const next = {
    ...current,
    [groupKey]: {
      ...currentServers,
      cloudeval: nextServer,
    },
  };
  await fs.mkdir(path.dirname(setup.configPath), { recursive: true });
  await fs.writeFile(setup.configPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return setup.configPath;
};
