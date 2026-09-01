import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Command } from "commander";
import {
  addAuthOptions,
  requireAuthUser,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import { buildIacIndexData, IDE_SCHEMA_VERSION } from "./iacCommand.js";
import {
  buildReviewLocalRun,
  type ReviewLocalRun,
} from "./ideContracts.js";
import {
  validateTemplate,
  waitForTemplateValidationResult,
  withTemplateValidationDetails,
} from "./templateValidationClient.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";

type ReviewLocalOptions = AuthGuardOptions & {
  file?: string;
  workspace?: string;
  project?: string;
  compare?: string;
  details?: boolean;
  wait?: boolean;
  pollInterval?: string;
  waitTimeout?: string;
  format?: MachineOutputFormat;
  output?: string;
};

export interface RegisterReviewLocalCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

const parsePositiveInteger = (
  value?: string,
  optionName = "--wait-timeout",
): number | undefined => {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${optionName} must be a positive integer.`);
  }
  return parsed;
};

const runProcess = (
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("exit", (code) => {
      const output = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(output.stderr || output.stdout || `${command} exited with ${code}`));
    });
  });

const compileBicepFile = async (filePath: string): Promise<string> => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-review-local-bicep-"));
  const outputPath = path.join(tempDir, "compiled.json");
  try {
    await runProcess("az", ["bicep", "build", "--file", filePath, "--outfile", outputPath]);
    return outputPath;
  } catch (error: any) {
    await fs.rm(tempDir, { recursive: true, force: true });
    if (error?.code === "ENOENT") {
      throw new Error(
        "Bicep local review requires Azure CLI with `az bicep` available.",
      );
    }
    throw new Error(`Failed to compile Bicep file ${filePath}: ${error?.message ?? String(error)}`);
  }
};

const cleanupCompiledFiles = async (files: string[]): Promise<void> => {
  for (const file of files) {
    await fs.rm(path.dirname(file), { recursive: true, force: true });
  }
};

const validateForIndex = async (input: {
  templatePath: string;
  options: ReviewLocalOptions;
  context: ReturnType<typeof requireAuthUser>;
}): Promise<unknown> => {
  const submitted = await validateTemplate({
    baseUrl: input.context.baseUrl,
    authToken: input.context.token,
    userId: input.context.user.id,
    templatePath: input.templatePath,
    failedOnly: true,
    projectId: input.options.project,
  });
  if (input.options.wait === false) {
    return withTemplateValidationDetails(submitted);
  }
  const waited = await waitForTemplateValidationResult({
    baseUrl: input.context.baseUrl,
    authToken: input.context.token,
    userId: input.context.user.id,
    submitted,
    pollIntervalMs: parsePositiveInteger(input.options.pollInterval, "--poll-interval"),
    waitTimeoutMs: parsePositiveInteger(input.options.waitTimeout, "--wait-timeout"),
    templatePath: input.templatePath,
  });
  return withTemplateValidationDetails(waited);
};

export const registerReviewLocalCommand = (
  review: Command,
  deps: RegisterReviewLocalCommandOptions,
) => {
  addAuthOptions(
    review.command("local").description("Review local IaC for IDE pre-merge workflows"),
    deps.defaultBaseUrl,
  )
    .option("--file <path>", "IaC file to review")
    .option("--workspace <path>", "Workspace directory")
    .option("--project <id>", "Cloudeval project id for report comparison/evidence")
    .option("--compare <mode>", "Optional comparison mode, e.g. latest-report")
    .option("--details", "Include normalized finding details", false)
    .option("--no-wait", "Submit validation and return without waiting")
    .option("--poll-interval <ms>", "Polling interval while waiting", "2500")
    .option("--wait-timeout <ms>", "Maximum time to wait", "600000")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .action(async (options: ReviewLocalOptions, command) => {
      const compiledFiles: string[] = [];
      try {
        const workspace = path.resolve(
          options.workspace ??
            (options.file ? path.dirname(path.resolve(options.file)) : process.cwd()),
        );
        const indexData = await buildIacIndexData({
          file: options.file,
          workspace: options.file ? undefined : workspace,
        });
        const indexes = indexData.indexes;
        const fullIndexes = indexes.filter(
          (index) => index.adapter === "arm" || index.adapter === "bicep",
        );
        const warnings = [
          ...indexes
            .filter((index) => index.supportLevel === "indexed_only")
            .map((index) => `${index.adapter} is indexed only; deep findings require scanner-backed evidence.`),
          ...(options.compare
            ? [`Comparison mode '${options.compare}' is accepted but report diffing is not wired in this CLI build.`]
            : []),
        ];
        const validationDetails: unknown[] = [];
        if (fullIndexes.length) {
          const context = requireAuthUser(await resolveAuthContext(options, command, deps));
          for (const index of fullIndexes) {
            const templatePath =
              index.adapter === "bicep"
                ? await compileBicepFile(index.filePath)
                : index.filePath;
            if (index.adapter === "bicep") {
              compiledFiles.push(templatePath);
            }
            const data = await validateForIndex({ templatePath, options, context });
            const details = Array.isArray((data as any)?.details)
              ? (data as any).details
              : [];
            validationDetails.push(...details);
          }
        }
        const run: ReviewLocalRun = await buildReviewLocalRun({
          command: "review local",
          workspace,
          indexes,
          validationData: { details: validationDetails },
          warnings,
        });
        await writeFormattedOutput({
          command: "review local",
          data: run,
          warnings,
          format: options.format === "text" || !options.format ? "json" : options.format,
          output: options.output,
          traceId: run.id,
          schemaVersion: IDE_SCHEMA_VERSION,
          freshness: run.freshness,
          evidence: run.evidence,
        });
      } catch (error: any) {
        console.error(`Failed to run local review: ${error?.message ?? "Unknown error"}`);
        process.exitCode = 1;
      } finally {
        await cleanupCompiledFiles(compiledFiles);
      }
    });
};
