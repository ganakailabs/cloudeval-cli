import type { Command } from "commander";
import {
  addAuthOptions,
  requireAuthUser,
  resolveAuthContext,
  type AuthGuardDeps,
  type AuthGuardOptions,
} from "./authGuard.js";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
} from "./frontendLinks.js";
import {
  formatTextTable,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

export interface RegisterIssuesInventoryCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
  commandName?: string;
  commandDescription?: string;
}

/** @deprecated Use RegisterIssuesInventoryCommandOptions */
export type RegisterActionsCommandOptions = RegisterIssuesInventoryCommandOptions;

type CommonOptions = AuthGuardOptions & {
  format?: MachineOutputFormat;
  output?: string;
  open?: boolean;
  printUrl?: boolean;
  frontendUrl?: string;
  project?: string;
  type?: string;
  severity?: string;
  pillar?: string;
  category?: string;
  resourceType?: string;
  q?: string;
  minMonthlySavings?: string;
  sort?: string;
  limit?: string;
  offset?: string;
  allowFullScan?: boolean;
};

const addCommon = <T extends Command>(command: T): T =>
  command
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .option("--open", "Open the matching frontend page", false)
    .option("--print-url", "Print the matching frontend URL", false)
    .option("--no-open", "Do not launch the browser when a URL is printed")
    .option("--frontend-url <url>", "Frontend base URL") as T;

const frontendBase = (
  context: { baseUrl: string },
  options: { frontendUrl?: string }
): string =>
  resolveFrontendBaseUrl({
    frontendUrl: options.frontendUrl,
    apiBaseUrl: context.baseUrl,
  });

const maybeOpen = async (url: string, options: CommonOptions) => {
  if (options.printUrl) {
    process.stdout.write(`${url}\n`);
  }
  if (options.open !== false && (options.open || options.printUrl)) {
    await openExternalUrl(url);
  }
};

export const splitCsv = (value: string | undefined): string[] | undefined => {
  if (!value) {
    return undefined;
  }
  const parts = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : undefined;
};

const scalar = (value: unknown, fallback = "-"): string => {
  if (value === null || value === undefined || value === "") {
    return fallback;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
};

export const renderActionsListText = (payload: Record<string, unknown>): string => {
  const items = Array.isArray(payload.items) ? payload.items : [];
  return formatTextTable(
    items.map((item) => {
      const record =
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as Record<string, unknown>)
          : {};
      return {
        id: scalar(record.id),
        type: scalar(record.type),
        severity: scalar(record.severity),
        project: scalar(record.project_name),
        title: scalar(record.title),
        resource: scalar(record.resource_name ?? record.resource_id),
        savings: scalar(record.monthly_savings),
      };
    }),
    [
      { key: "id", header: "ID", width: 12 },
      { key: "type", header: "Type", width: 12 },
      { key: "severity", header: "Severity", width: 10 },
      { key: "project", header: "Project", maxWidth: 18 },
      { key: "title", header: "Title", maxWidth: 32 },
      { key: "resource", header: "Resource", maxWidth: 20 },
      { key: "savings", header: "Savings", width: 10 },
    ],
    { emptyMessage: "No issues inventory items found." }
  );
};

const buildIssuesFrontendUrl = (
  context: { baseUrl: string },
  options: CommonOptions
) =>
  buildFrontendUrl({
    baseUrl: frontendBase(context, options),
    target: "issues",
    projectId: options.project,
    severity: options.severity,
    type: options.type,
    q: options.q,
    sort: options.sort,
  });

export const registerIssuesInventoryCommand = (
  program: Command,
  deps: RegisterIssuesInventoryCommandOptions
) => {
  const commandName = deps.commandName || "issues";
  const commandDescription =
    deps.commandDescription ||
    (commandName === "actions"
      ? "Cross-project action center inventory (deprecated; use issues)"
      : "Cross-project issues inventory");
  const inventory = program.command(commandName).description(commandDescription);

  addCommon(addAuthOptions(inventory.command("list").description("List issues inventory items"), deps.defaultBaseUrl))
    .option("--project <id>", "Filter by project id")
    .option("--type <types>", "Filter by type: architecture,cost,unit-tests")
    .option("--severity <levels>", "Filter by severity: critical,high,medium,low")
    .option("--pillar <pillars>", "Filter by pillar")
    .option("--category <categories>", "Filter by category")
    .option("--resource-type <types>", "Filter by resource type")
    .option("--q <query>", "Search query")
    .option("--min-monthly-savings <amount>", "Minimum monthly savings for cost items")
    .option("--sort <sort>", "Sort: priority, severity, savings, project", "priority")
    .option("--limit <n>", "Page size (1-500)", "50")
    .option("--offset <n>", "Page offset", "0")
    .option("--allow-full-scan", "Allow scanning large portfolios without project filter", true)
    .option("--no-allow-full-scan", "Require project scoping for large portfolios")
    .action(async (options: CommonOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const data = await core.listIssuesItems({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          projectIds: splitCsv(options.project),
          types: splitCsv(options.type),
          severities: splitCsv(options.severity),
          pillars: splitCsv(options.pillar),
          categories: splitCsv(options.category),
          resourceTypes: splitCsv(options.resourceType),
          q: options.q,
          minMonthlySavings:
            options.minMonthlySavings !== undefined
              ? Number(options.minMonthlySavings)
              : undefined,
          sort: (options.sort as "priority" | "severity" | "savings" | "project") || "priority",
          limit: Number(options.limit || 50),
          offset: Number(options.offset || 0),
          allowFullScan: options.allowFullScan !== false,
        });
        const url = buildIssuesFrontendUrl(context, options);
        const format = options.format ?? "text";
        if (format === "text") {
          const text = renderActionsListText(
            data && typeof data === "object" ? (data as Record<string, unknown>) : {}
          );
          if (options.output) {
            const fs = await import("node:fs/promises");
            await fs.writeFile(options.output, text, "utf8");
          } else {
            process.stdout.write(text);
          }
        } else {
          await writeFormattedOutput({
            command: `${commandName} list`,
            data,
            format,
            output: options.output,
            frontendUrl: url,
          });
        }
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to list issues inventory: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(addAuthOptions(inventory.command("get <item-id>").description("Get one issues inventory item"), deps.defaultBaseUrl))
    .option("--project <id>", "Optional project scope")
    .option("--allow-full-scan", "Allow scanning large portfolios", true)
    .option("--no-allow-full-scan", "Require project scoping for large portfolios")
    .action(async (itemId: string, options: CommonOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const data = await core.getIssuesItem({
          baseUrl: context.baseUrl,
          authToken: context.token,
          userId: context.user.id,
          itemId,
          projectIds: splitCsv(options.project),
          allowFullScan: options.allowFullScan !== false,
        });
        const payload =
          data && typeof data === "object" ? (data as Record<string, unknown>) : {};
        const items = Array.isArray(payload.items) ? payload.items : [];
        if (items.length === 0) {
          console.error(`Issues item not found: ${itemId}`);
          process.exit(5);
        }
        await writeFormattedOutput({
          command: `${commandName} get`,
          data: items[0],
          format: options.format ?? "json",
          output: options.output,
        });
      } catch (error: any) {
        console.error(`Failed to get issues item: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(addAuthOptions(inventory.command("open").description("Open the issues inventory in the browser"), deps.defaultBaseUrl))
    .option("--project <id>", "Filter by project id")
    .option("--type <types>", "Filter by type")
    .option("--severity <levels>", "Filter by severity")
    .option("--q <query>", "Search query")
    .option("--sort <sort>", "Sort order", "priority")
    .action(async (options: CommonOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const url = buildIssuesFrontendUrl(context, options);
        await maybeOpen(url, { ...options, open: true, printUrl: true });
      } catch (error: any) {
        console.error(`Failed to open issues inventory: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });
};

/** @deprecated Use registerIssuesInventoryCommand */
export const registerActionsCommand = (
  program: Command,
  deps: RegisterActionsCommandOptions
) =>
  registerIssuesInventoryCommand(program, {
    ...deps,
    commandName: "actions",
    commandDescription: "Cross-project action center inventory (deprecated; use issues)",
  });
