import type { Command } from "commander";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";
import { buildDomains, cliCommands } from "./cliCommandRegistry.js";
import { getMcpStatusData, mcpToolNames } from "./mcpCommand.js";
import { addAuthOptions, warnIfAccessKeyFromCliOption } from "./authGuard.js";

type ResolveBaseUrl = (
  options: { baseUrl?: string },
  command?: Command
) => Promise<string>;

interface CapabilitiesDeps {
  defaultBaseUrl: string;
  resolveBaseUrl: ResolveBaseUrl;
  readStdinValue: () => Promise<string>;
}

const mcpStatus = getMcpStatusData();

const capabilities = {
  version: 1,
  defaultCommand: "tui",
  stdout: {
    machineReadableCommandsUseStdoutOnly: true,
    promptsWarningsAndBrowserMessagesUseStderr: true,
  },
  formats: ["text", "json", "ndjson", "markdown"],
  commonOptions: [
    "--format",
    "--output",
    "--progress",
    "--quiet",
    "--no-color",
    "--non-interactive",
    "--open",
    "--print-url",
    "--no-open",
    "--frontend-url",
    "--base-url",
    "--profile",
    "--show-sensitive-ids",
    "--no-hooks",
  ],
  exitCodes: {
    success: 0,
    expectedFailure: 1,
    usage: 2,
    authRequired: 3,
    backendUnavailable: 4,
    notFound: 5,
    humanInputRequired: 6,
  },
  commands: cliCommands.map(({ name, description, domain, workflows }) => ({
    name,
    description,
    domain,
    workflows,
  })),
  domains: buildDomains(),
  deeplinks: {
    overview: "/app/overview",
    chat: "/app/chat?threadId=<thread-id>",
    project: "/app/projects/<project-id>?view=preview|code|both&layout=architecture|dependency",
    quickProject: "/app/projects?dialog=quick&template_url=<url>",
    reports: "/app/reports/<project-id>",
    billing: "/app/subscription?tab=plans|usage|billing",
    connection: "/app/connections/<connection-id>",
  },
  mcp: {
    transport: "stdio",
    command: "cloudeval mcp serve",
    protocolVersions: ["2025-06-18", "2025-03-26", "2024-11-05"],
    toolsets: mcpStatus.toolsets,
    resources: mcpStatus.resources,
    prompts: mcpStatus.prompts,
    setupClients: mcpStatus.setupClients,
    auth: {
      preferred: "stored cloudeval login credentials or scoped CLOUDEVAL_ACCESS_KEY",
      stdin: "MCP uses stdin for JSON-RPC, so --access-key-stdin is intentionally unavailable for mcp serve.",
    },
    tools: mcpToolNames,
  },
};

export const registerCapabilitiesCommand = (
  program: Command,
  deps: CapabilitiesDeps
) => {
  addAuthOptions(
    program
      .command("capabilities")
      .description("Show machine-readable CloudEval CLI capabilities"),
    deps.defaultBaseUrl
  )
    .option("--format <format>", "Output format: text, json, markdown", "json")
    .option("--live", "Fetch authenticated backend capability metadata", false)
    .action(async (
      options: {
        format?: MachineOutputFormat;
        live?: boolean;
        baseUrl?: string;
        accessKey?: string;
        accessKeyStdin?: boolean;
      },
	      command
	    ) => {
	      warnIfAccessKeyFromCliOption(options, command);
	      let data: Record<string, unknown> = capabilities;
      if (options.live) {
        const core = await import("@cloudeval/core");
        const baseUrl = await deps.resolveBaseUrl(options, command);
        const accessKey = options.accessKeyStdin
          ? await deps.readStdinValue()
          : options.accessKey;
        const token = await core.getAuthToken({ accessKey, baseUrl });
        const live = await core.getCapabilities({ baseUrl, authToken: token });
        data = { ...capabilities, live };
      }
      await writeFormattedOutput({
        command: "capabilities",
        data,
        format: options.format ?? "json",
      });
    });

  program
    .command("help")
    .argument("[topic]", "Help topic")
    .description("Display help for humans or agents")
    .action((topic?: string) => {
      if (topic === "agents") {
        process.stdout.write(`CloudEval CLI agent contract

Use explicit subcommands for pipeable work. Machine-readable commands write data to stdout; prompts, warnings, auth flow text, and browser-open messages go to stderr.

Preferred agent flags:
  --format json
  --non-interactive
  --profile <name>
  --scope global|project|hybrid|auto
  --print-url --no-open
  --output <file>

Mode-specific commands:
  cloudeval ask <question...>     Direct one-shot answer mode
  cloudeval agent <task...>       Agent/planner mode for deeper execution
  cloudeval recipes list          Discover reusable CloudEval workflows
  cloudeval recipes show <id>     Show skill-style commands, safety, and outputs
  cloudeval recipes run <id>      Run ask/agent recipes or print explicit commands for side-effecting recipes

Progress:
  ask/agent show a live stderr loader and reasoning progress bar in interactive terminals, then write the final answer to stdout. In non-TTY logs this falls back to append-only stderr events. Use --progress none or --quiet to suppress progress, or --format ndjson --progress ndjson to stream progress on stdout.

Scope:
  Use --scope global for account-level chat that should not bind to a default or first project. Use --project <id> or --scope project for report, graph, file, and project-specific remediation work.

Human input:
  Interactive terminals prompt on stderr for CloudEval approval requests and then resume the same thread. With --non-interactive, the command exits 6 and returns HITL_REQUIRED in JSON/NDJSON output.

Sensitive identifiers:
  Account, session, and tenant identifiers are redacted by default. Use --show-sensitive-ids only in trusted local workflows.

Recipes and skills:
  Recipes only cover implemented CloudEval capabilities: projects, reports, billing, credentials, connections, architecture/dependency diagrams, models, sessions, ask/agent, diagnostics, frontend links, and MCP.
  Visualization recipes include cloudeval-architecture-diagram-export and cloudeval-dependency-diagram-export; both require an explicit output path before writing files.
  Public SKILL.md files live under skills/ for agent hosts that support portable skill instructions. MCP remains the preferred execution path.

Installer onboarding:
  Interactive install/update flows can detect Codex, Claude, Cursor, and VS Code, then offer optional MCP setup for detected, all, or selected clients. Use --yes for unattended updates.

Stable JSON envelope:
  { "ok": true, "command": "...", "data": ..., "frontendUrl": "..." }
  { "ok": false, "command": "...", "error": { "message": "..." } }

Discovery:
  cloudeval capabilities --format json
  cloudeval recipes list
  cloudeval mcp serve
  cloudeval doctor --format json
  cloudeval config show --format json
`);
        return;
      }
      program.help();
    });
};
