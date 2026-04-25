import React from "react";
import type { Command } from "commander";
import {
  type ReportEnvelope,
  type ReportFormatMode,
  type ReportKind,
  type ReportOutputFormat,
} from "@cloudeval/shared";
import {
  renderReportList,
  selectReportModePayload,
  serializeReportOutput,
} from "./reportRender.js";
import { ReportDashboard } from "./ReportDashboard.js";
import { resolveReportProjectId } from "./reportProject.js";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
} from "../frontendLinks.js";
import {
  formatOutput,
  writeFormattedOutput,
  type MachineOutputFormat,
} from "../outputFormatter.js";

type ResolveBaseUrl = (
  options: { baseUrl?: string },
  command?: Command
) => Promise<string>;

export interface RegisterReportsCommandOptions {
  defaultBaseUrl: string;
  resolveBaseUrl: ResolveBaseUrl;
  readStdinValue: () => Promise<string>;
}

type CommonReportOptions = {
  baseUrl?: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  machine?: boolean;
  project?: string;
  format?: ReportOutputFormat;
  raw?: boolean;
  parsed?: boolean;
  formatted?: boolean;
  output?: string;
  open?: boolean;
  printUrl?: boolean;
  frontendUrl?: string;
  nonInteractive?: boolean;
};

const outputFormats = ["tui", "summary", "text", "json", "ndjson", "markdown", "table"];
type CliReportOutputFormat = ReportOutputFormat | "text" | "table";

const addCommonOptions = <T extends Command>(command: T, defaultBaseUrl: string): T =>
  command
    .option("--base-url <url>", "Backend base URL", defaultBaseUrl)
    .option(
      "--api-key <key>",
      "API key (machine workflows only; deprecated for interactive human auth)",
      process.env.CLOUDEVAL_API_KEY
    )
    .option("--api-key-stdin", "Read API key from stdin (recommended for automation)", false)
    .option("--machine", "Allow machine credential fallback (service principal)", false)
    .option("--project <id>", "Project ID to use")
    .option("--format <format>", `Output format: ${outputFormats.join(", ")}`)
    .option("--raw", "Show raw provider/backend payload", false)
    .option("--parsed", "Show normalized parsed report payload", false)
    .option("--formatted", "Show formatted human report payload", false)
    .option("--output <file>", "Output file")
    .option("--open", "Open the matching frontend report page", false)
    .option("--print-url", "Print the matching frontend URL", false)
    .option("--no-open", "Do not launch the browser when a URL is printed")
    .option("--frontend-url <url>", "Frontend base URL")
    .option("--non-interactive", "Disable prompts and browser login", false) as T;

const resolveMode = (options: CommonReportOptions): ReportFormatMode => {
  if (options.raw) return "raw";
  if (options.parsed) return "parsed";
  return "formatted";
};

const resolveFormat = (
  requested: string | undefined,
  tuiDefault: boolean
): CliReportOutputFormat => {
  if (requested && outputFormats.includes(requested)) {
    return requested as CliReportOutputFormat;
  }
  if (requested) {
    throw new Error(`Unsupported format '${requested}'. Use ${outputFormats.join(", ")}.`);
  }
  return tuiDefault && process.stdout.isTTY && !process.env.CI ? "tui" : "summary";
};

const resolveToken = async (
  options: CommonReportOptions,
  baseUrl: string,
  deps: RegisterReportsCommandOptions
): Promise<string | undefined> => {
  if (options.apiKeyStdin) {
    return deps.readStdinValue();
  }
  if (options.apiKey) {
    return options.apiKey;
  }
  const { getAuthToken } = await import("@cloudeval/core");
  try {
    return await getAuthToken({
      apiKey: options.apiKey,
      baseUrl,
      allowMachineAuth: !!options.machine,
    });
  } catch (error: any) {
    const canLogin =
      !options.nonInteractive &&
      !options.machine &&
      process.stdin.isTTY &&
      process.stdout.isTTY &&
      !process.env.CI;
    if (!canLogin) {
      throw error;
    }
    const { login } = await import("@cloudeval/core");
    process.stderr.write("Authentication required. Starting login flow...\n");
    const token = await login(baseUrl, {
      headless: Boolean(process.env.SSH_TTY || process.env.CLOUDEVAL_HEADLESS_LOGIN),
    });
    process.stderr.write("Authentication successful.\n");
    return token;
  }
};

const frontendUrlForReports = (
  baseUrl: string,
  options: CommonReportOptions & {
    tab?: string;
    reportType?: string;
    timeRange?: string;
  },
  projectId?: string
): string =>
  buildFrontendUrl({
    baseUrl: resolveFrontendBaseUrl({
      frontendUrl: options.frontendUrl,
      apiBaseUrl: baseUrl,
    }),
    target: "reports",
    projectId,
    tab: options.tab,
    reportType: options.reportType,
    timeRange: options.timeRange,
  });

const maybeOpenReportUrl = async (url: string, options: CommonReportOptions) => {
  if (options.printUrl) {
    process.stdout.write(`${url}\n`);
  }
  if (options.open !== false && (options.open || options.printUrl)) {
    await openExternalUrl(url);
  }
};

const writeReport = async (
  report: ReportEnvelope,
  options: CommonReportOptions,
  tuiDefault: boolean
) => {
  const mode = resolveMode(options);
  const format = resolveFormat(options.format, tuiDefault);
  if (format === "tui") {
    const { render } = await import("ink");
    render(
      <ReportDashboard
        report={report}
        initialMode={mode === "formatted" ? "overview" : mode}
      />
    );
    return;
  }
  const textFormat = format === "text" || format === "table" ? "summary" : format;
  const text = serializeReportOutput(report, { format: textFormat as any, mode });
  if (options.output) {
    const fs = await import("node:fs/promises");
    await fs.writeFile(options.output, text, "utf8");
    return;
  }
  process.stdout.write(text);
};

const writeReportList = (
  reports: ReportEnvelope[],
  requestedFormat: string | undefined
) => {
  const format = resolveFormat(requestedFormat, false);
  const textFormat = format === "tui" || format === "text" || format === "table" ? "summary" : format;
  process.stdout.write(renderReportList(reports, textFormat));
};

const pickReportDownloadPayload = (value: unknown, view: ReportFormatMode): unknown => {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (view === "raw") {
      return record.raw ?? record.raw_report ?? record;
    }
    if (view === "parsed") {
      return record.parsed ?? record.processed ?? record.normalized ?? record;
    }
    return record.formatted ?? record.summary ?? record.processed ?? record.parsed ?? record;
  }
  return value;
};

const writeDownloadPayload = async (input: {
  command: string;
  payload: unknown;
  format: MachineOutputFormat;
  output?: string;
  frontendUrl?: string;
}): Promise<string[]> => {
  if (!input.output) {
    process.stdout.write(
      formatOutput({
        command: input.command,
        data: input.payload,
        format: input.format,
        frontendUrl: input.frontendUrl,
      })
    );
    return [];
  }
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  await fs.mkdir(path.dirname(input.output), { recursive: true });
  const text = formatOutput({
    command: input.command,
    data: input.payload,
    format: input.format,
    frontendUrl: input.frontendUrl,
  });
  await fs.writeFile(input.output, text, "utf8");
  return [input.output];
};

export const registerReportsCommand = (
  program: Command,
  deps: RegisterReportsCommandOptions
) => {
  const reports = program
    .command("reports")
    .description("Access cost and Well-Architected Framework reports");

  addCommonOptions(
    reports.command("list").description("List available reports"),
    deps.defaultBaseUrl
  )
    .option("--kind <kind>", "Filter by kind: cost, waf, all", "all")
    .action(async (options: CommonReportOptions & { kind?: ReportKind | "all" }, command) => {
      try {
        const baseUrl = await deps.resolveBaseUrl(options, command);
        const token = await resolveToken(options, baseUrl, deps);
        const projectId = await resolveReportProjectId({
          baseUrl,
          token,
          requestedProjectId: options.project,
        });
        const { listReports } = await import("@cloudeval/core");
        const reports = await listReports({
          baseUrl,
          authToken: token,
          projectId,
          kind: options.kind,
        });
        writeReportList(reports, options.format);
      } catch (error: any) {
        console.error(`❌ Failed to list reports: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommonOptions(
    reports.command("download").description("Download report JSON or markdown locally"),
    deps.defaultBaseUrl
  )
    .option("--type <type>", "Report type: cost, waf, architecture, all", "all")
    .option("--view <view>", "Payload view: raw, parsed, formatted", "raw")
    .option("--timestamp <timestamp>", "Historical timestamp")
    .action(async (options: CommonReportOptions & { type?: string; view?: ReportFormatMode; timestamp?: string }, command) => {
      try {
        const baseUrl = await deps.resolveBaseUrl(options, command);
        const token = await resolveToken(options, baseUrl, deps);
        const core = await import("@cloudeval/core");
        const status = token ? await core.checkUserStatus(baseUrl, token) : undefined;
        const projectId = await resolveReportProjectId({
          baseUrl,
          token,
          requestedProjectId: options.project,
        });
        const reportTypes =
          options.type === "all" ? ["cost", "waf"] : [options.type || "cost"];
        const payload: Record<string, unknown> = {};
        for (const type of reportTypes) {
          if (type === "cost") {
            const data = options.timestamp
              ? await core.getCostReportHistory({
                  baseUrl,
                  authToken: token,
                  projectId,
                  userId: status?.user?.id,
                  timestamp: options.timestamp,
                })
              : await core.getCostReportFull({
                  baseUrl,
                  authToken: token,
                  projectId,
                  userId: status?.user?.id,
                });
            payload.cost = pickReportDownloadPayload(data, options.view ?? "raw");
          } else if (type === "waf" || type === "architecture") {
            const data = options.timestamp
              ? await core.getWafReportHistory({
                  baseUrl,
                  authToken: token,
                  projectId,
                  userId: status?.user?.id,
                  timestamp: options.timestamp,
                })
              : await core.getWafReportFull({
                  baseUrl,
                  authToken: token,
                  projectId,
                  userId: status?.user?.id,
                });
            payload.waf = pickReportDownloadPayload(data, options.view ?? "raw");
          } else {
            throw new Error(`Unsupported report type '${type}'.`);
          }
        }
        const frontendUrl = frontendUrlForReports(
          baseUrl,
          {
            ...options,
            tab: options.type === "cost" ? "cost" : options.type === "waf" ? "architecture" : "overview",
            reportType: options.type === "all" ? "all" : options.type,
          },
          projectId
        );
        const data = reportTypes.length === 1 ? payload[reportTypes[0] === "architecture" ? "waf" : reportTypes[0]] : payload;
        if (options.output && reportTypes.length > 1) {
          const fs = await import("node:fs/promises");
          const path = await import("node:path");
          const stat = await fs.stat(options.output).catch(() => undefined);
          if (stat?.isDirectory() || !path.extname(options.output)) {
            await fs.mkdir(options.output, { recursive: true });
            const files: string[] = [];
            for (const [key, value] of Object.entries(payload)) {
              const file = path.join(options.output, `${projectId}-${key}-report.json`);
              files.push(
                ...(await writeDownloadPayload({
                  command: "reports download",
                  payload: value,
                  format: "json",
                  output: file,
                  frontendUrl,
                }))
              );
            }
            await writeFormattedOutput({
              command: "reports download",
              data: { projectId, filesWritten: files },
              format: options.format === "json" ? "json" : "text",
              frontendUrl,
              filesWritten: files,
            });
            await maybeOpenReportUrl(frontendUrl, options);
            return;
          }
        }
        await writeDownloadPayload({
          command: "reports download",
          payload: data,
          format: (options.format === "markdown" ? "markdown" : "json"),
          output: options.output,
          frontendUrl,
        });
        await maybeOpenReportUrl(frontendUrl, options);
      } catch (error: any) {
        console.error(`Failed to download reports: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommonOptions(
    reports.command("rules").description("Show Well-Architected Framework rules"),
    deps.defaultBaseUrl
  )
    .option("--type <type>", "Rule report type: waf", "waf")
    .action(async (options: CommonReportOptions & { type?: string }, command) => {
      try {
        const baseUrl = await deps.resolveBaseUrl(options, command);
        const token = await resolveToken(options, baseUrl, deps);
        const projectId = await resolveReportProjectId({
          baseUrl,
          token,
          requestedProjectId: options.project,
        });
        const { getWafReport } = await import("@cloudeval/core");
        const report = await getWafReport({
          baseUrl,
          authToken: token,
          projectId,
          view: "rules",
        });
        const payload = selectReportModePayload(report, resolveMode(options));
        const rules =
          (payload as any)?.rules ??
          (report.parsed as any)?.rules ??
          (report.raw as any)?.rules ??
          (report.raw as any)?.ruleResults ??
          [];
        await writeFormattedOutput({
          command: "reports rules",
          data: rules,
          format: options.format === "json" || options.format === "ndjson" || options.format === "markdown"
            ? (options.format as MachineOutputFormat)
            : "text",
          output: options.output,
          frontendUrl: frontendUrlForReports(
            baseUrl,
            { ...options, tab: "architecture", reportType: "waf" },
            projectId
          ),
        });
      } catch (error: any) {
        console.error(`Failed to show report rules: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommonOptions(
    reports.command("show").description("Show a report by id").argument("<report-id>", "Report ID"),
    deps.defaultBaseUrl
  ).action(async (reportId: string, options: CommonReportOptions, command) => {
    try {
      const baseUrl = await deps.resolveBaseUrl(options, command);
      const token = await resolveToken(options, baseUrl, deps);
      const projectId = await resolveReportProjectId({
        baseUrl,
        token,
        requestedProjectId: options.project,
      });
      const { getReport } = await import("@cloudeval/core");
      const report = await getReport({
        baseUrl,
        authToken: token,
        projectId,
        reportId,
        view: resolveMode(options),
      });
      await writeReport(report, options, false);
    } catch (error: any) {
      console.error(`❌ Failed to show report: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });

  addCommonOptions(
    reports.command("cost").description("Show the latest cost report"),
    deps.defaultBaseUrl
  )
    .option("--period <period>", "Report period, for example 7d, 30d, 90d", "30d")
    .option("--view <view>", "Cost view: overview, services, recommendations, anomalies, raw")
    .action(async (options: CommonReportOptions & { period?: string; view?: string }, command) => {
      try {
        const baseUrl = await deps.resolveBaseUrl(options, command);
        const token = await resolveToken(options, baseUrl, deps);
        const projectId = await resolveReportProjectId({
          baseUrl,
          token,
          requestedProjectId: options.project,
        });
        const { getCostReport } = await import("@cloudeval/core");
        const report = await getCostReport({
          baseUrl,
          authToken: token,
          projectId,
          period: options.period,
          view: options.view,
        });
        await writeReport(report, options, true);
      } catch (error: any) {
        console.error(`❌ Failed to show cost report: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommonOptions(
    reports.command("waf").description("Show the latest Well-Architected Framework report"),
    deps.defaultBaseUrl
  )
    .option("--report <id>", "Specific report id")
    .option("--severity <severity>", "Filter by severity")
    .option("--view <view>", "WAF view: overview, pillars, rules, resources, raw")
    .action(
      async (
        options: CommonReportOptions & { report?: string; severity?: string; view?: string },
        command
      ) => {
        try {
          const baseUrl = await deps.resolveBaseUrl(options, command);
          const token = await resolveToken(options, baseUrl, deps);
          const projectId = await resolveReportProjectId({
            baseUrl,
            token,
            requestedProjectId: options.project,
          });
          const { getWafReport } = await import("@cloudeval/core");
          const report = await getWafReport({
            baseUrl,
            authToken: token,
            projectId,
            reportId: options.report,
            severity: options.severity,
            view: options.view,
          });
          await writeReport(report, options, true);
        } catch (error: any) {
          console.error(`❌ Failed to show WAF report: ${error?.message ?? "Unknown error"}`);
          process.exit(1);
        }
      }
    );
};
