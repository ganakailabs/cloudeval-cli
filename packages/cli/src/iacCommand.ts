import type { Command } from "commander";
import fs from "node:fs/promises";
import path from "node:path";
import {
  detectIacTargets,
  indexIacDocument,
  readWorkspaceFilePaths,
  type IacDetectionResult,
  type IacDocumentIndex,
} from "./iacIndex.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";

export const IDE_SCHEMA_VERSION = "2026-07-ide-v1";

type IacCommandOptions = {
  workspace?: string;
  file?: string;
  format?: MachineOutputFormat;
  output?: string;
};

export interface IacDetectData {
  schemaVersion: typeof IDE_SCHEMA_VERSION;
  workspace: string;
  detection: IacDetectionResult;
}

export interface IacIndexData {
  schemaVersion: typeof IDE_SCHEMA_VERSION;
  workspace?: string;
  file?: string;
  indexes: IacDocumentIndex[];
}

const observedFreshness = () => ({
  source: "local",
  observedAt: new Date().toISOString(),
  stale: false,
});

export const buildIacDetectData = async (input: {
  workspace?: string;
}): Promise<IacDetectData> => {
  const workspace = path.resolve(input.workspace ?? process.cwd());
  const paths = await readWorkspaceFilePaths(workspace);
  return {
    schemaVersion: IDE_SCHEMA_VERSION,
    workspace,
    detection: detectIacTargets(paths),
  };
};

const readIndexForFile = async (filePath: string): Promise<IacDocumentIndex> => {
  const absolutePath = path.resolve(filePath);
  return indexIacDocument({
    path: filePath,
    content: await fs.readFile(absolutePath, "utf8"),
  });
};

export const buildIacIndexData = async (input: {
  file?: string;
  workspace?: string;
}): Promise<IacIndexData> => {
  if (input.file) {
    return {
      schemaVersion: IDE_SCHEMA_VERSION,
      file: path.resolve(input.file),
      indexes: [await readIndexForFile(input.file)],
    };
  }

  const workspace = path.resolve(input.workspace ?? process.cwd());
  const detection = await buildIacDetectData({ workspace });
  const indexes: IacDocumentIndex[] = [];
  for (const target of detection.detection.targets) {
    const filePath = path.join(workspace, target.path);
    indexes.push(
      indexIacDocument({
        path: target.path,
        content: await fs.readFile(filePath, "utf8"),
      }),
    );
  }
  return {
    schemaVersion: IDE_SCHEMA_VERSION,
    workspace,
    indexes,
  };
};

const addCommonOptions = <T extends Command>(command: T): T =>
  command
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file") as T;

export const registerIacCommand = (program: Command) => {
  const iac = program
    .command("iac")
    .description("Detect and index local infrastructure-as-code files");

  addCommonOptions(
    iac.command("detect").description("Detect ARM, Bicep, Terraform, and OpenTofu files"),
  )
    .option("--workspace <path>", "Workspace directory", ".")
    .action(async (options: IacCommandOptions) => {
      try {
        const data = await buildIacDetectData({ workspace: options.workspace });
        await writeFormattedOutput({
          command: "iac detect",
          data,
          format: options.format,
          output: options.output,
          schemaVersion: IDE_SCHEMA_VERSION,
          freshness: observedFreshness(),
        });
      } catch (error: any) {
        console.error(`Failed to detect IaC files: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommonOptions(
    iac.command("index").description("Index resources in an IaC file or workspace"),
  )
    .option("--file <path>", "IaC file to index")
    .option("--workspace <path>", "Workspace directory")
    .action(async (options: IacCommandOptions) => {
      try {
        const data = await buildIacIndexData({
          file: options.file,
          workspace: options.workspace,
        });
        await writeFormattedOutput({
          command: "iac index",
          data,
          format: options.format,
          output: options.output,
          schemaVersion: IDE_SCHEMA_VERSION,
          freshness: observedFreshness(),
        });
      } catch (error: any) {
        console.error(`Failed to index IaC files: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });
};
