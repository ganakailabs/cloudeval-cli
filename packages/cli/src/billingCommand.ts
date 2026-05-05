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
  formatTextTable,
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

const money = (amount: unknown, currency = "USD"): string => {
  if (typeof amount !== "number") {
    return "-";
  }
  const prefix = currency === "USD" ? "$" : `${currency} `;
  return `${prefix}${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;
};

const planPrice = (plan: Record<string, any>): string => {
  if (plan.billing_interval === "custom") {
    return "custom";
  }
  const price = money(plan.price_usd, "USD");
  return plan.billing_interval ? `${price}/${plan.billing_interval}` : price;
};

const extractEntitlement = (data: any) => data?.entitlement?.data ?? data?.entitlement ?? data?.data ?? data;

const renderCreditSummary = (data: any): string => {
  const entitlement = extractEntitlement(data);
  const status = data?.creditStatus ?? data?.status ?? {};
  const plan = entitlement?.plan ?? status?.plan ?? {};
  const balance = entitlement?.balance ?? {};
  const rows = [
    { field: "Plan", value: status.planName ?? plan.name ?? plan.id },
    { field: "Plan source", value: entitlement?.plan_source ?? entitlement?.planSource ?? "-" },
    { field: "Credits used", value: status.used ?? balance.credits_used ?? balance.credits_used_cycle },
    { field: "Credits remaining", value: status.remaining ?? balance.credits_remaining ?? balance.credits_remaining_effective },
    { field: "Credits total", value: status.total ?? balance.credits_total ?? balance.credits_total_effective },
    { field: "Top-up balance", value: status.topUpBalance ?? entitlement?.top_up_credits_balance },
    { field: "Next reset", value: entitlement?.next_reset_at ?? data?.subscriptionStatus?.next_reset_at },
  ];
  return formatTextTable(rows, [
    { key: "field", header: "Field" },
    { key: "value", header: "Value", maxWidth: 40 },
  ]);
};

const renderPlans = (data: any): string =>
  formatTextTable(
    (data?.plans ?? []).map((plan: Record<string, any>) => ({
      id: plan.id,
      name: plan.name,
      price: planPrice(plan),
      credits: plan.credits_per_period || "-",
      interval: plan.credits_period ?? plan.billing_interval ?? "-",
      available: plan.available === false ? "no" : "yes",
    })),
    [
      { key: "id", header: "ID", maxWidth: 18 },
      { key: "name", header: "Name", maxWidth: 24 },
      { key: "price", header: "Price", maxWidth: 18 },
      { key: "credits", header: "Credits", align: "right" },
      { key: "interval", header: "Interval", maxWidth: 12 },
      { key: "available", header: "Available", width: 9 },
    ],
    { emptyMessage: "No billing plans found." }
  );

const objectRows = (value: Record<string, unknown> | undefined, keyLabel: string, valueLabel: string) =>
  Object.entries(value ?? {}).map(([key, amount]) => ({
    [keyLabel]: key,
    [valueLabel]: amount,
  }));

const renderUsage = (data: any): string => {
  const totals = data?.totals ?? data;
  const sections = [
    formatTextTable(
      [
        { field: "Range start", value: data?.range_start ?? data?.start_at },
        { field: "Range end", value: data?.range_end ?? data?.end_at },
        { field: "Granularity", value: data?.granularity },
        { field: "Credits used", value: totals?.credits_used ?? totals?.total_credits },
        { field: "Events", value: totals?.events ?? totals?.total_events },
        { field: "Input tokens", value: totals?.input_tokens },
        { field: "Output tokens", value: totals?.output_tokens },
      ],
      [
        { key: "field", header: "Field" },
        { key: "value", header: "Value", maxWidth: 40 },
      ]
    ).trimEnd(),
  ];

  const byAction = objectRows(data?.by_action_type, "Action", "Credits");
  if (byAction.length) {
    sections.push(
      `By action\n${formatTextTable(byAction, [
        { key: "Action", header: "Action", maxWidth: 32 },
        { key: "Credits", header: "Credits", align: "right" },
      ]).trimEnd()}`
    );
  }

  const buckets = Array.isArray(data?.buckets) ? data.buckets : [];
  if (buckets.length) {
    sections.push(
      `Buckets\n${formatTextTable(
        buckets.map((bucket: Record<string, any>) => ({
          start: bucket.bucket_start ?? bucket.start,
          end: bucket.bucket_end ?? bucket.end,
          credits: bucket.credits_used ?? bucket.total_credits,
          events: bucket.events ?? bucket.total_events,
          input: bucket.input_tokens,
          output: bucket.output_tokens,
        })),
        [
          { key: "start", header: "Start", maxWidth: 19 },
          { key: "end", header: "End", maxWidth: 19 },
          { key: "credits", header: "Credits", align: "right" },
          { key: "events", header: "Events", align: "right" },
          { key: "input", header: "Input", align: "right" },
          { key: "output", header: "Output", align: "right" },
        ]
      ).trimEnd()}`
    );
  }

  return `${sections.join("\n\n")}\n`;
};

const renderLedger = (data: any): string =>
  formatTextTable(
    (data?.items ?? []).map((item: Record<string, any>) => ({
      id: item.id,
      action: item.action_type ?? item.operation_type ?? item.action,
      outcome: item.outcome,
      credits: item.charged_credits ?? item.credits ?? item.total_credits,
      charge: item.charge_status,
      model: item.model_name,
      time: item.event_time ?? item.created_at ?? item.recorded_at,
    })),
    [
      { key: "id", header: "ID", maxWidth: 28 },
      { key: "action", header: "Action", maxWidth: 24 },
      { key: "outcome", header: "Outcome", maxWidth: 10 },
      { key: "credits", header: "Credits", align: "right" },
      { key: "charge", header: "Charge", maxWidth: 12 },
      { key: "model", header: "Model", maxWidth: 18 },
      { key: "time", header: "Time", maxWidth: 19 },
    ],
    { emptyMessage: "No billing ledger events found." }
  );

const renderTopUps = (data: any): string =>
  formatTextTable(
    (data?.packs ?? data?.items ?? []).map((pack: Record<string, any>) => ({
      id: pack.id,
      name: pack.name,
      credits: pack.credits,
      price: money(pack.display_price_major ?? pack.price_usd, pack.display_currency ?? "USD"),
      currency: pack.display_currency ?? "USD",
      available: pack.available === false ? "no" : "yes",
    })),
    [
      { key: "id", header: "ID", maxWidth: 18 },
      { key: "name", header: "Name", maxWidth: 24 },
      { key: "credits", header: "Credits", align: "right" },
      { key: "price", header: "Price", maxWidth: 12 },
      { key: "currency", header: "Currency", width: 8 },
      { key: "available", header: "Available", width: 9 },
    ],
    { emptyMessage: "No top-up packs found." }
  );

const renderInvoices = (data: any): string =>
  formatTextTable(
    (data?.invoices ?? data?.items ?? []).map((invoice: Record<string, any>) => ({
      id: invoice.id,
      status: invoice.status,
      amount: invoice.amount_due ?? invoice.amount_paid ?? invoice.amount,
      currency: invoice.currency,
      due: invoice.due_date ?? invoice.created_at,
    })),
    [
      { key: "id", header: "ID", maxWidth: 28 },
      { key: "status", header: "Status", maxWidth: 12 },
      { key: "amount", header: "Amount", align: "right" },
      { key: "currency", header: "Currency", maxWidth: 8 },
      { key: "due", header: "Due", maxWidth: 19 },
    ],
    { emptyMessage: "No invoices found." }
  );

const renderNotifications = (data: any): string =>
  formatTextTable(
    (data?.notifications ?? data?.items ?? []).map((notification: Record<string, any>) => ({
      id: notification.id,
      type: notification.type,
      severity: notification.severity ?? notification.level,
      message: notification.message ?? notification.title,
      created: notification.created_at,
    })),
    [
      { key: "id", header: "ID", maxWidth: 28 },
      { key: "type", header: "Type", maxWidth: 20 },
      { key: "severity", header: "Severity", maxWidth: 10 },
      { key: "message", header: "Message", maxWidth: 48 },
      { key: "created", header: "Created", maxWidth: 19 },
    ],
    { emptyMessage: "No billing notifications found." }
  );

const renderBillingText = (command: string, data: unknown): string | undefined => {
  const record = data as Record<string, any>;
  switch (command) {
    case "credits":
    case "billing summary":
      return renderCreditSummary(record);
    case "billing plans":
      return renderPlans(record);
    case "billing usage":
      return renderUsage(record);
    case "billing ledger":
      return renderLedger(record);
    case "billing topups":
      return renderTopUps(record);
    case "billing invoices":
      return renderInvoices(record);
    case "billing notifications":
      return renderNotifications(record);
    default:
      return undefined;
  }
};

const write = async (
  command: string,
  data: unknown,
  options: CommonOptions,
  frontendUrl?: string
) => {
  if ((options.format ?? "text") === "text") {
    const text = renderBillingText(command, data);
    if (text) {
      if (options.output) {
        const fs = await import("node:fs/promises");
        await fs.writeFile(options.output, text, "utf8");
        return;
      }
      process.stdout.write(text);
      return;
    }
  }
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
