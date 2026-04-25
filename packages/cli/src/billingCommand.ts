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
  writeFormattedOutput,
  type MachineOutputFormat,
} from "./outputFormatter.js";

export interface RegisterBillingCommandOptions extends AuthGuardDeps {
  defaultBaseUrl: string;
}

type CommonOptions = AuthGuardOptions & {
  format?: MachineOutputFormat;
  output?: string;
  open?: boolean;
  printUrl?: boolean;
  frontendUrl?: string;
};

const addCommon = <T extends Command>(command: T): T =>
  command
    .option("--format <format>", "Output format: text, json, ndjson, markdown", "text")
    .option("--output <file>", "Output file")
    .option("--open", "Open the matching frontend page", false)
    .option("--print-url", "Print the matching frontend URL", false)
    .option("--no-open", "Do not launch the browser when a URL is printed")
    .option("--frontend-url <url>", "Frontend base URL") as T;

const billingUrl = (
  context: { baseUrl: string },
  options: CommonOptions & { tab?: string }
): string =>
  buildFrontendUrl({
    baseUrl: resolveFrontendBaseUrl({
      frontendUrl: options.frontendUrl,
      apiBaseUrl: context.baseUrl,
    }),
    target: "billing",
    tab: options.tab,
  });

const maybeOpen = async (url: string, options: CommonOptions) => {
  if (options.printUrl) {
    process.stdout.write(`${url}\n`);
  }
  if (options.open !== false && (options.open || options.printUrl)) {
    await openExternalUrl(url);
  }
};

const write = async (
  command: string,
  data: unknown,
  options: CommonOptions,
  frontendUrl?: string
) => {
  await writeFormattedOutput({
    command,
    data,
    format: options.format,
    output: options.output,
    frontendUrl,
  });
};

const rangeToDates = (range?: string): { startAt?: string; endAt?: string } => {
  if (!range || range === "all") {
    return {};
  }
  const days = range === "7d" ? 7 : range === "90d" ? 90 : 30;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  start.setHours(0, 0, 0, 0);
  return { startAt: start.toISOString(), endAt: end.toISOString() };
};

export const registerBillingCommands = (
  program: Command,
  deps: RegisterBillingCommandOptions
) => {
  addCommon(
    addAuthOptions(
      program.command("credits").description("Show current credit stats"),
      deps.defaultBaseUrl
    )
  ).action(async (options: CommonOptions, command) => {
    try {
      const context = requireAuthUser(await resolveAuthContext(options, command, deps));
      const core = await import("@cloudeval/core");
      const entitlement = await core.getBillingEntitlement({
        baseUrl: context.baseUrl,
        authToken: context.token,
      });
      const status = core.getCreditStatus(entitlement);
      const url = billingUrl(context, { ...options, tab: "usage" });
      await write("credits", { status, entitlement }, options, url);
      await maybeOpen(url, options);
    } catch (error: any) {
      console.error(`Failed to show credits: ${error?.message ?? "Unknown error"}`);
      process.exit(1);
    }
  });

  const billing = program.command("billing").description("Billing and usage utilities");

  addCommon(addAuthOptions(billing.command("summary").description("Show billing summary"), deps.defaultBaseUrl))
    .action(async (options: CommonOptions, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const [entitlement, subscriptionStatus] = await Promise.all([
          core.getBillingEntitlement({ baseUrl: context.baseUrl, authToken: context.token }),
          core.getSubscriptionStatus({ baseUrl: context.baseUrl, authToken: context.token }),
        ]);
        const url = billingUrl(context, { ...options, tab: "plans" });
        await write(
          "billing summary",
          { creditStatus: core.getCreditStatus(entitlement), entitlement, subscriptionStatus },
          options,
          url
        );
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to show billing summary: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(addAuthOptions(billing.command("plans").description("Show billing plans"), deps.defaultBaseUrl))
    .action(async (options: CommonOptions, command) => {
      try {
        const context = await resolveAuthContext(options, command, deps);
        const core = await import("@cloudeval/core");
        const data = await core.getBillingConfig({ baseUrl: context.baseUrl, authToken: context.token });
        const url = billingUrl(context, { ...options, tab: "plans" });
        await write("billing plans", data, options, url);
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to show billing plans: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(addAuthOptions(billing.command("usage").description("Show billing usage summary"), deps.defaultBaseUrl))
    .option("--range <range>", "Usage range: 7d, 30d, 90d, all", "30d")
    .option("--start-at <iso>", "Start timestamp")
    .option("--end-at <iso>", "End timestamp")
    .option("--granularity <value>", "Granularity: hour, day, month", "day")
    .option("--action-type <type>", "Action type filter")
    .option("--model <name>", "Model filter")
    .option("--outcome <outcome>", "Outcome filter")
    .option("--charge-status <status>", "Charge status filter")
    .action(async (options: CommonOptions & any, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const range = rangeToDates(options.range);
        const data = await core.getBillingUsageSummary({
          baseUrl: context.baseUrl,
          authToken: context.token,
          startAt: options.startAt ?? range.startAt,
          endAt: options.endAt ?? range.endAt,
          granularity: options.granularity,
          actionType: options.actionType,
          modelName: options.model,
          outcome: options.outcome,
          chargeStatus: options.chargeStatus,
        });
        const url = billingUrl(context, { ...options, tab: "usage" });
        await write("billing usage", data, options, url);
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to show billing usage: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  addCommon(addAuthOptions(billing.command("ledger").description("Show billing ledger"), deps.defaultBaseUrl))
    .option("--range <range>", "Usage range: 7d, 30d, 90d, all", "30d")
    .option("--start-at <iso>", "Start timestamp")
    .option("--end-at <iso>", "End timestamp")
    .option("--action-type <type>", "Action type filter")
    .option("--model <name>", "Model filter")
    .option("--outcome <outcome>", "Outcome filter")
    .option("--charge-status <status>", "Charge status filter")
    .option("--limit <n>", "Page size", "25")
    .option("--cursor <cursor>", "Pagination cursor")
    .action(async (options: CommonOptions & any, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const range = rangeToDates(options.range);
        const data = await core.getBillingUsageLedger({
          baseUrl: context.baseUrl,
          authToken: context.token,
          startAt: options.startAt ?? range.startAt,
          endAt: options.endAt ?? range.endAt,
          actionType: options.actionType,
          modelName: options.model,
          outcome: options.outcome,
          chargeStatus: options.chargeStatus,
          limit: Number(options.limit),
          cursor: options.cursor,
        });
        const url = billingUrl(context, { ...options, tab: "usage" });
        await write("billing ledger", data, options, url);
        await maybeOpen(url, options);
      } catch (error: any) {
        console.error(`Failed to show billing ledger: ${error?.message ?? "Unknown error"}`);
        process.exit(1);
      }
    });

  for (const [name, getter, tab] of [
    ["invoices", "getSubscriptionBillingInfo", "billing"],
    ["topups", "getTopUpPacks", "billing"],
    ["notifications", "getBillingNotifications", "billing"],
  ] as const) {
    addCommon(addAuthOptions(billing.command(name).description(`Show billing ${name}`), deps.defaultBaseUrl))
      .option("--limit <n>", "Result limit", "25")
      .action(async (options: CommonOptions & { limit?: string }, command) => {
        try {
          const context = requireAuthUser(await resolveAuthContext(options, command, deps));
          const core = await import("@cloudeval/core");
          const data = await (core as any)[getter]({
            baseUrl: context.baseUrl,
            authToken: context.token,
            limit: Number(options.limit ?? 25),
          });
          const url = billingUrl(context, { ...options, tab });
          await write(`billing ${name}`, data, options, url);
          await maybeOpen(url, options);
        } catch (error: any) {
          console.error(`Failed to show billing ${name}: ${error?.message ?? "Unknown error"}`);
          process.exit(1);
        }
      });
  }
};
