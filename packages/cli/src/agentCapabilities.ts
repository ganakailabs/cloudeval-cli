import type { Command } from "commander";
import {
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

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
    "--quiet",
    "--no-color",
    "--non-interactive",
    "--open",
    "--print-url",
    "--no-open",
    "--frontend-url",
    "--base-url",
  ],
  exitCodes: {
    success: 0,
    expectedFailure: 1,
    usage: 2,
    authRequired: 3,
    backendUnavailable: 4,
    notFound: 5,
  },
  domains: {
    chat: ["ask", "chat", "open chat"],
    reports: ["reports list", "reports show", "reports cost", "reports waf", "reports download", "reports rules"],
    projects: ["projects list", "projects get", "projects open", "projects create"],
    connections: ["connections list", "connections get", "connections open"],
    billing: ["credits", "billing summary", "billing usage", "billing ledger", "billing invoices", "billing topups", "billing plans", "billing notifications"],
    frontend: ["open overview", "open chat", "open projects", "open project", "open connections", "open connection", "open reports", "open billing"],
  },
  deeplinks: {
    overview: "/app/overview",
    chat: "/app/chat?threadId=<thread-id>",
    project: "/app/projects/<project-id>?view=preview|code|both&layout=architecture|dependency",
    quickProject: "/app/projects?dialog=quick&template_url=<url>",
    reports: "/app/reports/<project-id>",
    billing: "/app/subscription?tab=plans|usage|billing",
    connection: "/app/connections/<connection-id>",
  },
};

export const registerCapabilitiesCommand = (program: Command) => {
  program
    .command("capabilities")
    .description("Show machine-readable CloudEval CLI capabilities")
    .option("--format <format>", "Output format: text, json, markdown", "json")
    .action(async (options: { format?: MachineOutputFormat }) => {
      await writeFormattedOutput({
        command: "capabilities",
        data: capabilities,
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
  --print-url --no-open
  --output <file>

Stable JSON envelope:
  { "ok": true, "command": "...", "data": ..., "frontendUrl": "..." }
  { "ok": false, "command": "...", "error": { "message": "..." } }

Discovery:
  cloudeval capabilities --format json
`);
        return;
      }
      program.help();
    });
};
