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
  testTemplate,
  validateTemplate,
  formatTemplateProgressEvent,
  templateProgressEventKey,
  waitForTemplateValidationResult,
  withTemplateTestDetails,
  withTemplateValidationDetails,
  type TemplateProgressEvent,
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
  details?: boolean;
  wait?: boolean;
  pollInterval?: string;
  waitTimeout?: string;
  location?: string;
  test?: string[];
  skipTest?: string[];
  group?: string[];
  verbose?: boolean;
  progress?: string | boolean;
};

type TemplateProgressMode = "auto" | "stderr" | "ndjson" | "none";

const normalizeTemplateProgressMode = (value: unknown): TemplateProgressMode => {
  if (value === true) {
    return "stderr";
  }
  if (value === undefined || value === false || value === null) {
    return "none";
  }
  const mode = String(value).trim().toLowerCase();
  if (mode === "auto" || mode === "stderr" || mode === "ndjson" || mode === "none") {
    return mode;
  }
  throw new Error("--progress must be one of: auto, stderr, ndjson, none");
};

const createTemplateProgressReporter = (
  command: string,
  progress: unknown,
): ((event: TemplateProgressEvent) => void) | undefined => {
  const requestedMode = normalizeTemplateProgressMode(progress);
  const mode =
    requestedMode === "auto"
      ? process.stderr.isTTY
        ? "stderr"
        : "none"
      : requestedMode;
  if (mode === "none") {
    return undefined;
  }
  let lastStatusKey: string | undefined;
  return (event) => {
    if (event.phase === "status") {
      const key = templateProgressEventKey(event);
      if (key === lastStatusKey) {
        return;
      }
      lastStatusKey = key;
    }
    if (mode === "ndjson") {
      process.stderr.write(
        `${JSON.stringify({ type: "template_progress", command, ...event })}\n`,
      );
      return;
    }
    for (const line of formatTemplateProgressEvent(event, command)) {
      process.stderr.write(`${line}\n`);
    }
  };
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
    .option("--details", "Include frontend-style per-check evidence details", false)
    .option("--wait", "Poll an async validation job until results are ready", false)
    .option("--poll-interval <ms>", "Polling interval when --wait is set", "2500")
    .option("--wait-timeout <ms>", "Maximum time to wait when --wait is set", "600000")
    .option(
      "--progress [mode]",
      "Progress events while waiting: auto, stderr, ndjson, none",
      "none",
    )
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
              templatePath: options.templateFile!,
              parametersPath: options.parametersFile,
              onProgress: createTemplateProgressReporter(
                "validate template",
                options.progress,
              ),
            })
          : submitted;
        const outputData = options.details
          ? withTemplateValidationDetails(data)
          : data;
        await writeFormattedOutput({
          command: "validate template",
          data: outputData,
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

  addCommon(validate.command("tests").description("Run cloud template test checks"), deps)
    .option("--test <name>", "Run a specific template test; repeat for multiple tests", collectRule)
    .option("--skip-test <name>", "Skip a specific template test; repeat for multiple tests", collectRule)
    .option("--category <name>", "Template test category")
    .option("--group <name>", "Template test group; repeat for multiple groups", collectRule)
    .option("--verbose", "Request verbose template test output", false)
    .option("--wait", "Poll an async template test job until results are ready", false)
    .option("--poll-interval <ms>", "Polling interval when --wait is set", "2500")
    .option("--wait-timeout <ms>", "Maximum time to wait when --wait is set", "600000")
    .option(
      "--progress [mode]",
      "Progress events while waiting: auto, stderr, ndjson, none",
      "none",
    )
    .action(async (options: ValidateOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const submitted = await testTemplate({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          templatePath: options.templateFile!,
          parametersPath: options.parametersFile,
          includeTests: options.test,
          skipTests: options.skipTest,
          testCategories: options.category ? [options.category] : undefined,
          testGroups: options.group,
          verboseOutput: options.verbose,
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
              templatePath: options.templateFile!,
              parametersPath: options.parametersFile,
              onProgress: createTemplateProgressReporter(
                "validate tests",
                options.progress,
              ),
            })
          : submitted;
        await writeFormattedOutput({
          command: "validate tests",
          data: withTemplateTestDetails(data, {
            templatePath: options.templateFile!,
            parametersPath: options.parametersFile,
          }),
          format: options.format,
          output: options.output,
        });
      } catch (error: any) {
        console.error(`Failed to run template tests: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });
};
