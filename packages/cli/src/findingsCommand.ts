import path from "node:path";
import type { Command } from "commander";
import {
  buildDraftFix,
  buildFindingEvidence,
} from "./ideContracts.js";
import { IDE_SCHEMA_VERSION } from "./iacCommand.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";

type FindingsOptions = {
  run?: string;
  workspace?: string;
  format?: MachineOutputFormat;
  output?: string;
};

const resolveWorkspace = (value?: string): string => path.resolve(value ?? process.cwd());

export const registerFindingsCommand = (program: Command) => {
  const findings = program
    .command("findings")
    .description("Inspect CloudEval IDE findings and evidence");

  findings
    .command("evidence")
    .description("Show evidence for a finding from a local IDE review run")
    .argument("<finding-id>", "Finding id")
    .requiredOption("--run <run-id>", "IDE run id")
    .option("--workspace <path>", "Workspace directory", ".")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (findingId: string, options: FindingsOptions) => {
      try {
        const data = await buildFindingEvidence({
          workspace: resolveWorkspace(options.workspace),
          runId: options.run!,
          findingId,
        });
        await writeFormattedOutput({
          command: "findings evidence",
          data,
          format: options.format,
          output: options.output,
          traceId: options.run,
          schemaVersion: IDE_SCHEMA_VERSION,
          freshness: data.freshness,
          evidence: data.evidenceRefs,
        });
      } catch (error: any) {
        console.error(`Failed to load finding evidence: ${error?.message ?? "Unknown error"}`);
        process.exitCode = 1;
      }
    });

  findings
    .command("draft-fix")
    .description("Draft a non-mutating fix proposal for a finding")
    .argument("<finding-id>", "Finding id")
    .requiredOption("--run <run-id>", "IDE run id")
    .option("--workspace <path>", "Workspace directory", ".")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (findingId: string, options: FindingsOptions) => {
      try {
        const data = await buildDraftFix({
          workspace: resolveWorkspace(options.workspace),
          runId: options.run!,
          findingId,
        });
        await writeFormattedOutput({
          command: "findings draft-fix",
          data,
          format: options.format,
          output: options.output,
          traceId: options.run,
          schemaVersion: IDE_SCHEMA_VERSION,
          evidence: data.evidenceRefs,
        });
      } catch (error: any) {
        console.error(`Failed to draft finding fix: ${error?.message ?? "Unknown error"}`);
        process.exitCode = 1;
      }
    });
};
