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
  formatErrorEnvelope,
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

type TopUpCheckoutOptions = CommonOptions & {
  currency?: string;
  countryCode?: string;
  contactEmail?: string;
  contactPhone?: string;
  contactCountryCode?: string;
  returnTo?: string;
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
    const isMachineReadable = options.format === "json" || options.format === "ndjson";
    (isMachineReadable ? process.stderr : process.stdout).write(`${url}\n`);
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

const failBillingCommand = (
  command: string,
  action: string,
  error: unknown,
  options: CommonOptions
): never => {
  const detail = error instanceof Error ? error.message : String(error || "Unknown error");
  const message = `${action}: ${detail}`;
  const envelope = formatErrorEnvelope(command, new Error(message));

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else if (options.format === "ndjson") {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    console.error(message);
  }

  process.exit(1);
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

const addTopUpCheckoutOptions = <T extends Command>(command: T): T =>
  command
    .option("--currency <currency>", "Preferred checkout currency, for example USD or INR")
    .option("--country-code <code>", "Country code used for localized payment methods")
    .option("--contact-email <email>", "Checkout prefill email")
    .option("--contact-phone <phone>", "Checkout prefill phone")
    .option("--contact-country-code <code>", "Checkout contact country code")
    .option("--return-to <url>", "Frontend return URL after checkout") as T;

const checkoutUrlFromSession = (session: any): string | undefined =>
  String(session?.checkout_url || session?.launcher_url || "").trim() || undefined;

const checkoutReturnUrl = (
  context: { baseUrl: string },
  options: TopUpCheckoutOptions
): string => options.returnTo || billingUrl(context, { ...options, tab: "billing" });

const runTopUpCheckout = async (
  commandName: string,
  packId: string,
  options: TopUpCheckoutOptions,
  command: Command,
  deps: RegisterBillingCommandOptions
) => {
  try {
    const context = requireAuthUser(await resolveAuthContext(options, command, deps));
    const core = await import("@cloudeval/core");
    const returnTo = checkoutReturnUrl(context, options);
    const session = await core.createTopUpCheckoutSession({
      baseUrl: context.baseUrl,
      authToken: context.token,
      packId,
      preferredCurrency: options.currency,
      countryCode: options.countryCode,
      contactEmail: options.contactEmail,
      contactPhone: options.contactPhone,
      contactCountryCode: options.contactCountryCode,
      returnTo,
    });
    const checkoutUrl = checkoutUrlFromSession(session);
    await write(
      commandName,
      {
        packId,
        checkoutUrl,
        session,
      },
      options,
      checkoutUrl
    );
    if (checkoutUrl) {
      await maybeOpen(checkoutUrl, options);
    }
  } catch (error: any) {
    failBillingCommand(commandName, "Failed to start top-up checkout", error, options);
  }
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
      failBillingCommand("credits", "Failed to show credits", error, options);
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
        failBillingCommand("billing summary", "Failed to show billing summary", error, options);
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
        failBillingCommand("billing plans", "Failed to show billing plans", error, options);
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
        failBillingCommand("billing usage", "Failed to show billing usage", error, options);
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
        failBillingCommand("billing ledger", "Failed to show billing ledger", error, options);
      }
    });

  for (const [name, getter, tab] of [
    ["invoices", "getSubscriptionBillingInfo", "billing"],
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
          failBillingCommand(`billing ${name}`, `Failed to show billing ${name}`, error, options);
        }
      });
  }

  const topups = billing.command("topups").description("Show billing top-ups");
  addCommon(addAuthOptions(topups, deps.defaultBaseUrl))
    .option("--limit <n>", "Result limit", "25")
    .action(async (options: CommonOptions & { limit?: string }, command) => {
      try {
        const context = requireAuthUser(await resolveAuthContext(options, command, deps));
        const core = await import("@cloudeval/core");
        const data = await core.getTopUpPacks({
          baseUrl: context.baseUrl,
          authToken: context.token,
        });
        const url = billingUrl(context, { ...options, tab: "billing" });
        await write("billing topups", data, options, url);
        await maybeOpen(url, options);
      } catch (error: any) {
        failBillingCommand("billing topups", "Failed to show billing topups", error, options);
      }
    });

  addTopUpCheckoutOptions(
    addCommon(
      addAuthOptions(
        topups.command("buy <pack-id>").description("Buy a credit top-up pack"),
        deps.defaultBaseUrl
      )
    )
  ).action((packId: string, options: TopUpCheckoutOptions, command) =>
    runTopUpCheckout("billing topups buy", packId, options, command, deps)
  );

  addTopUpCheckoutOptions(
    addCommon(
      addAuthOptions(
        billing.command("topup <pack-id>").description("Buy a credit top-up pack"),
        deps.defaultBaseUrl
      )
    )
  ).action((packId: string, options: TopUpCheckoutOptions, command) =>
    runTopUpCheckout("billing topup", packId, options, command, deps)
  );
};
