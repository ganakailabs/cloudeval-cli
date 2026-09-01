import path from "node:path";
import type { Command } from "commander";
import {
  buildCiInitPlan,
  writeCiInitPlan,
} from "./ideContracts.js";
import { IDE_SCHEMA_VERSION } from "./iacCommand.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";

type CiInitOptions = {
  provider?: string;
  project?: string;
  workspace?: string;
  write?: boolean;
  format?: MachineOutputFormat;
  output?: string;
};

export const registerCiCommand = (program: Command) => {
  const ci = program.command("ci").description("Cloudeval CI gate utilities");

  ci
    .command("init")
    .description("Generate a Cloudeval CI gate using the existing cloudeval review command")
    .requiredOption("--project <id>", "Cloudeval project id")
    .option("--provider <provider>", "github-actions or azure-pipelines", "github-actions")
    .option("--workspace <path>", "Workspace directory", ".")
    .option("--write", "Write generated files to the workspace", false)
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: CiInitOptions) => {
      try {
        const workspace = path.resolve(options.workspace ?? ".");
        const plan = buildCiInitPlan({
          projectId: options.project!,
          provider: options.provider,
          write: options.write,
        });
        const filesWritten = options.write
          ? await writeCiInitPlan(plan, workspace)
          : [];
        await writeFormattedOutput({
          command: "ci init",
          data: {
            ...plan,
            workspace,
            filesWritten,
            note: options.write
              ? "Generated Cloudeval CI gate files."
              : "Preview only. Re-run with --write to create files.",
          },
          filesWritten,
          format: options.format,
          output: options.output,
          schemaVersion: IDE_SCHEMA_VERSION,
        });
      } catch (error: any) {
        console.error(`Failed to initialize CI gate: ${error?.message ?? "Unknown error"}`);
        process.exitCode = 1;
      }
    });
};
