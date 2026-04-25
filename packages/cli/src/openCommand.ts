import type { Command } from "commander";
import {
  buildFrontendUrl,
  openExternalUrl,
  resolveFrontendBaseUrl,
} from "./frontendLinks.js";
import { writeFormattedOutput } from "./outputFormatter.js";

type ResolveBaseUrl = (
  options: { baseUrl?: string },
  command?: Command
) => Promise<string>;

export interface RegisterOpenCommandOptions {
  defaultBaseUrl: string;
  resolveBaseUrl: ResolveBaseUrl;
}

const addOpenOptions = <T extends Command>(command: T, defaultBaseUrl: string): T =>
  command
    .option("--base-url <url>", "Backend base URL", defaultBaseUrl)
    .option("--frontend-url <url>", "Frontend base URL")
    .option("--print-url", "Print the frontend URL to stdout", false)
    .option("--no-open", "Do not launch the browser") as T;

const emitOrOpen = async (
  url: string,
  options: { printUrl?: boolean; open?: boolean; format?: string }
) => {
  if (options.printUrl) {
    process.stdout.write(`${url}\n`);
  } else {
    await writeFormattedOutput({
      command: "open",
      data: { url },
      format: options.format === "json" ? "json" : "text",
      frontendUrl: url,
    });
  }
  if (options.open !== false) {
    await openExternalUrl(url);
  }
};

const base = async (
  options: { frontendUrl?: string; baseUrl?: string },
  command: Command,
  deps: RegisterOpenCommandOptions
) =>
  resolveFrontendBaseUrl({
    frontendUrl: options.frontendUrl,
    apiBaseUrl: await deps.resolveBaseUrl(options, command),
  });

export const registerOpenCommand = (
  program: Command,
  deps: RegisterOpenCommandOptions
) => {
  const open = program
    .command("open")
    .description("Open CloudEval frontend deeplinks");

  addOpenOptions(open.command("overview").description("Open overview"), deps.defaultBaseUrl)
    .action(async (options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "overview",
      });
      await emitOrOpen(url, options);
    });

  addOpenOptions(open.command("chat").description("Open chat"), deps.defaultBaseUrl)
    .option("--thread <id>", "Thread id")
    .action(async (options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "chat",
        threadId: options.thread,
      });
      await emitOrOpen(url, options);
    });

  addOpenOptions(open.command("projects").description("Open projects"), deps.defaultBaseUrl)
    .option("--quick", "Open the quick project dialog", false)
    .option("--template-url <url>", "Template URL for quick project creation")
    .option("--name <name>", "Project name")
    .option("--description <text>", "Project description")
    .option("--provider <provider>", "Cloud provider")
    .option("--auto-submit", "Ask frontend quick project dialog to auto-submit", false)
    .action(async (options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "projects",
        quick: options.quick || Boolean(options.templateUrl),
        templateUrl: options.templateUrl,
        name: options.name,
        description: options.description,
        provider: options.provider,
        autoSubmit: options.autoSubmit,
      });
      await emitOrOpen(url, options);
    });

  addOpenOptions(
    open.command("project").description("Open a project").argument("<id>", "Project id"),
    deps.defaultBaseUrl
  )
    .option("--view <view>", "View mode: preview, code, both")
    .option("--layout <layout>", "Preview layout: architecture, dependency")
    .option("--node <id...>", "Node ids to highlight")
    .option("--resource <id>", "Resource id")
    .option("--tab <tab>", "Project/resource tab")
    .option("--file <path>", "Active code file")
    .option("--files <paths...>", "Open code files")
    .option("--cursor <line:col>", "Editor cursor")
    .option("--selection <range>", "Editor selection")
    .option("--workspace-focus", "Hide app chrome", false)
    .option("--presentation", "Open presentation mode", false)
    .action(async (id, options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "project",
        projectId: id,
        view: options.view,
        layout: options.layout,
        node: options.node,
        resource: options.resource,
        tab: options.tab,
        file: options.file,
        files: options.files,
        cursor: options.cursor,
        selection: options.selection,
        workspaceFocus: options.workspaceFocus,
        presentation: options.presentation,
      });
      await emitOrOpen(url, options);
    });

  addOpenOptions(open.command("connections").description("Open connections"), deps.defaultBaseUrl)
    .option("--dialog <dialog>", "Dialog to open, e.g. add-connection")
    .action(async (options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "connections",
        dialog: options.dialog,
      });
      await emitOrOpen(url, options);
    });

  addOpenOptions(
    open.command("connection").description("Open a connection").argument("<id>", "Connection id"),
    deps.defaultBaseUrl
  ).action(async (id, options, command) => {
    const url = buildFrontendUrl({
      baseUrl: await base(options, command, deps),
      target: "connection",
      connectionId: id,
    });
    await emitOrOpen(url, options);
  });

  addOpenOptions(open.command("reports").description("Open reports"), deps.defaultBaseUrl)
    .option("--project <id>", "Project id")
    .option("--tab <tab>", "Reports tab")
    .option("--report-type <type>", "Report type: all, cost, waf")
    .option("--time-range <range>", "Time range")
    .option("--persona <persona>", "Persona")
    .option("--cadence <cadence>", "Cadence")
    .option("--issues-query <query>", "Issues table search")
    .option("--issues-fullscreen", "Open issues fullscreen", false)
    .option("--issues-view <view>", "Issues view: table, breakdown")
    .option("--download-pdf", "Trigger frontend PDF download", false)
    .action(async (options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "reports",
        projectId: options.project,
        tab: options.tab,
        reportType: options.reportType,
        timeRange: options.timeRange,
        persona: options.persona,
        cadence: options.cadence,
        issuesQuery: options.issuesQuery,
        issuesFullscreen: options.issuesFullscreen,
        issuesView: options.issuesView,
        downloadPdf: options.downloadPdf,
      });
      await emitOrOpen(url, options);
    });

  addOpenOptions(open.command("billing").description("Open billing"), deps.defaultBaseUrl)
    .option("--tab <tab>", "Billing tab: plans, usage, billing")
    .action(async (options, command) => {
      const url = buildFrontendUrl({
        baseUrl: await base(options, command, deps),
        target: "billing",
        tab: options.tab,
      });
      await emitOrOpen(url, options);
    });
};
