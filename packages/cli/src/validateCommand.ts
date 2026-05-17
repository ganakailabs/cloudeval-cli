import type { Command } from "commander";
import {
  addAuthOptions,
  requireAuthUser,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import { writeFormattedOutput, type MachineOutputFormat } from "./outputFormatter.js";
import {
  parseTemplate,
  validateTemplate,
  waitForTemplateValidationResult,
} from "./templateValidationClient.js";

export interface RegisterValidateCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type ValidateOptions = AuthGuardOptions & {
  format?: MachineOutputFormat;
  output?: string;
  templateFile?: string;
  parametersFile?: string;
  failedOnly?: boolean;
  rule?: string[];
  category?: string;
  pillar?: string;
  minSeverity?: string;
  maxResults?: string;
  project?: string;
  saveReport?: boolean;
  wait?: boolean;
  pollInterval?: string;
  waitTimeout?: string;
  location?: string;
};

const addCommon = <T extends Command>(
  command: T,
  deps: RegisterValidateCommandOptions,
): T =>
  addAuthOptions(command, deps.defaultBaseUrl)
    .requiredOption("--template-file <path>", "Cloud template JSON file")
    .option("--parameters-file <path>", "Optional parameters JSON file")
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file") as T;

const parsePositiveInteger = (
  value?: string,
  optionName = "--max-results",
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

const collectRule = (value: string, previous: string[] = []): string[] => [
  ...previous,
  ...value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
];

export const registerValidateCommand = (
  program: Command,
  deps: RegisterValidateCommandOptions,
) => {
  const validate = program
    .command("validate")
    .description("Validate and parse cloud templates");

  addCommon(validate.command("template").description("Validate a cloud template"), deps)
    .option("--failed-only", "Return failed validation checks only", false)
    .option(
      "--rule <id>",
      "Run a specific validation check id; repeat for multiple checks",
      collectRule,
    )
    .option("--category <name>", "Validation category filter")
    .option("--pillar <name>", "Architecture pillar filter")
    .option("--min-severity <level>", "Minimum severity level")
    .option("--max-results <count>", "Maximum validation results")
    .option("--project <id>", "Project id for saved validation results")
    .option("--save-report", "Persist validation results when a project is provided", false)
    .option("--wait", "Poll an async validation job until results are ready", false)
    .option("--poll-interval <ms>", "Polling interval when --wait is set", "2500")
    .option("--wait-timeout <ms>", "Maximum time to wait when --wait is set", "600000")
    .action(async (options: ValidateOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const submitted = await validateTemplate({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          templatePath: options.templateFile!,
          parametersPath: options.parametersFile,
          failedOnly: options.failedOnly,
          ruleNames: options.rule,
          category: options.category,
          pillar: options.pillar,
          minSeverity: options.minSeverity,
          maxResults: parsePositiveInteger(options.maxResults),
          projectId: options.project,
          saveReport: options.saveReport,
        });
        const data = options.wait
          ? await waitForTemplateValidationResult({
              baseUrl: context.baseUrl,
              authToken: context.token,
              userId: context.user.id,
              submitted,
              pollIntervalMs: parsePositiveInteger(
                options.pollInterval,
                "--poll-interval",
              ),
              waitTimeoutMs: parsePositiveInteger(
                options.waitTimeout,
                "--wait-timeout",
              ),
            })
          : submitted;
        await writeFormattedOutput({
          command: "validate template",
          data,
          format: options.format,
          output: options.output,
        });
      } catch (error: any) {
        console.error(`Failed to validate template: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(validate.command("parse").description("Parse a cloud template"), deps)
    .option("--location <region>", "Default location for resolved resources")
    .action(async (options: ValidateOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const data = await parseTemplate({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          templatePath: options.templateFile!,
          parametersPath: options.parametersFile,
          location: options.location,
          returnAll: true,
        });
        await writeFormattedOutput({
          command: "validate parse",
          data,
          format: options.format,
          output: options.output,
        });
      } catch (error: any) {
        console.error(`Failed to parse template: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });
};
