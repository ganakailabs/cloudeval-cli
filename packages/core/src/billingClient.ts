import { getCLIHeaders, normalizeApiBase } from "./auth";

export type CreditTone = "normal" | "warning" | "low" | "exhausted";
export type BillingUsageGranularity = "hour" | "day" | "month";

export interface BillingClientOptions {
  baseUrl: string;
  authToken?: string;
}

export interface BillingPlan {
  id: string;
  name: string;
  price_usd?: number;
  allowed_models?: string[];
  [key: string]: unknown;
}

export interface CreditBalance {
  credits_total: number;
  credits_used: number;
  credits_remaining: number;
  credits_total_cycle?: number;
  credits_used_cycle?: number;
  credits_remaining_cycle?: number;
  credits_total_effective?: number;
  credits_remaining_effective?: number;
  top_up_credits_balance?: number;
  [key: string]: unknown;
}

export interface BillingEntitlementSummary {
  plan: BillingPlan;
  plan_source?: string;
  balance: CreditBalance;
  credits_remaining_total?: number;
  top_up_credits_balance?: number;
  credits_exhausted?: boolean;
  credits_low?: boolean;
  effective_status?: string;
  trial_state?: {
    credits_total?: number;
    initial_credits?: number;
    consumed?: boolean;
    blocked?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CreditStatus {
  planName: string;
  remaining: number;
  total: number;
  used: number;
  cycleTotal: number;
  cycleUsed: number;
  cycleRemaining: number;
  effectiveTotal: number;
  effectiveRemaining: number;
  topUpBalance: number;
  remainingRatio: number;
  isUnlimited: boolean;
  tone: CreditTone;
  messagesRemaining: number | null;
}

const CREDIT_LOW_RATIO = 0.1;
const CREDIT_WARNING_RATIO = 0.25;
const DEFAULT_FREE_TRIAL_CREDITS_TOTAL = 150;

const fetchBillingJson = async <T>(
  options: BillingClientOptions,
  path: string,
  query: Record<string, string | number | undefined> = {}
): Promise<T> => {
  const url = new URL(`${normalizeApiBase(options.baseUrl)}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method: "GET",
    headers: getCLIHeaders(options.authToken),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Billing request failed with status ${response.status} ${response.statusText}${
        body.trim() ? `: ${body.trim()}` : ""
      }`
    );
  }
  return (await response.json()) as T;
};

const unwrapData = <T>(value: T | { data?: T }): T => {
  if (value && typeof value === "object" && "data" in value && value.data) {
    return value.data as T;
  }
  return value as T;
};

export const getBillingConfig = (options: BillingClientOptions) =>
  fetchBillingJson(options, "/billing/config");

export const getBillingEntitlement = async (
  options: BillingClientOptions
): Promise<BillingEntitlementSummary> =>
  unwrapData(await fetchBillingJson<BillingEntitlementSummary | { data?: BillingEntitlementSummary }>(
    options,
    "/billing/entitlement"
  ));

export const getSubscriptionStatus = (options: BillingClientOptions) =>
  fetchBillingJson(options, "/billing/subscription/status");

export const getSubscriptionBillingInfo = (
  options: BillingClientOptions & { limit?: number }
) =>
  fetchBillingJson(options, "/billing/subscription/billing-info", {
    limit: Math.max(1, Math.min(50, Number(options.limit ?? 20))),
  });

export const getTopUpPacks = (options: BillingClientOptions) =>
  fetchBillingJson(options, "/billing/top-up/packs");

export const getBillingNotifications = (
  options: BillingClientOptions & { limit?: number }
) =>
  fetchBillingJson(options, "/billing/notifications", {
    limit: Math.max(1, Math.min(100, Number(options.limit ?? 25))),
  });

export const getBillingUsageSummary = (
  options: BillingClientOptions & {
    startAt?: string;
    endAt?: string;
    granularity?: BillingUsageGranularity;
    actionType?: string;
    modelName?: string;
    outcome?: string;
    triggerMode?: string;
    chargeStatus?: string;
  }
) =>
  fetchBillingJson(options, "/billing/usage/summary", {
    start_at: options.startAt,
    end_at: options.endAt,
    granularity: options.granularity,
    action_type: options.actionType,
    model_name: options.modelName,
    outcome: options.outcome,
    trigger_mode: options.triggerMode,
    charge_status: options.chargeStatus,
  });

export const getBillingUsageLedger = (
  options: BillingClientOptions & {
    startAt?: string;
    endAt?: string;
    actionType?: string;
    modelName?: string;
    outcome?: string;
    triggerMode?: string;
    chargeStatus?: string;
    limit?: number;
    cursor?: string;
  }
) =>
  fetchBillingJson(options, "/billing/usage/ledger", {
    start_at: options.startAt,
    end_at: options.endAt,
    action_type: options.actionType,
    model_name: options.modelName,
    outcome: options.outcome,
    trigger_mode: options.triggerMode,
    charge_status: options.chargeStatus,
    limit: options.limit,
    cursor: options.cursor,
  });

const isFreePlan = (plan: BillingPlan | null | undefined): boolean => {
  if (!plan) {
    return false;
  }
  const id = String(plan.id || "").toLowerCase();
  const name = String(plan.name || "").toLowerCase();
  return id === "free" || name === "free" || Number(plan.price_usd ?? NaN) === 0;
};

export const getCreditStatus = (
  summary?: BillingEntitlementSummary | null,
  options?: { creditsPerEvent?: number | null }
): CreditStatus | null => {
  if (!summary) {
    return null;
  }

  const planName = summary.plan?.name || "Plan";
  const planId = String(summary.plan?.id || "").toLowerCase();
  const normalizedPlanName = String(summary.plan?.name || "").toLowerCase();
  const planSource = String(summary.plan_source || "").toLowerCase();
  const isFreeLikePlan =
    isFreePlan(summary.plan) ||
    planSource === "trial" ||
    planSource === "free" ||
    planSource === "free_blocked";
  const explicitUnlimited =
    planId.includes("enterprise") || normalizedPlanName.includes("enterprise");

  const balance = summary.balance || ({} as CreditBalance);
  const cycleTotal = Math.max(
    Number(balance.credits_total_cycle ?? balance.credits_total ?? 0),
    0
  );
  const cycleRemaining = Math.max(
    Number(balance.credits_remaining_cycle ?? balance.credits_remaining ?? 0),
    0
  );
  const cycleUsed = Math.max(
    Number.isFinite(Number(balance.credits_used_cycle ?? balance.credits_used))
      ? Number(balance.credits_used_cycle ?? balance.credits_used)
      : cycleTotal - cycleRemaining,
    0
  );
  const topUpBalance = Math.max(
    Number(balance.top_up_credits_balance ?? summary.top_up_credits_balance ?? 0),
    0
  );
  const fallbackEffectiveTotal = cycleTotal + topUpBalance;
  const fallbackEffectiveRemaining = cycleRemaining + topUpBalance;
  const reportedEffectiveTotal = Number(balance.credits_total_effective ?? NaN);
  const reportedEffectiveRemaining = Number(
    balance.credits_remaining_effective ?? summary.credits_remaining_total ?? NaN
  );
  let effectiveTotal = Number.isFinite(reportedEffectiveTotal)
    ? Math.max(reportedEffectiveTotal, fallbackEffectiveTotal, 0)
    : fallbackEffectiveTotal;
  const effectiveRemaining = Number.isFinite(reportedEffectiveRemaining)
    ? Math.max(reportedEffectiveRemaining, fallbackEffectiveRemaining, 0)
    : fallbackEffectiveRemaining;
  if (effectiveTotal <= 0) {
    effectiveTotal = fallbackEffectiveTotal;
  }
  if (effectiveRemaining > effectiveTotal) {
    effectiveTotal = effectiveRemaining;
  }

  const trialTotal = Math.max(
    Number(
      summary.trial_state?.credits_total ??
        summary.trial_state?.initial_credits ??
        (summary.plan as any)?.features?.trial_credits_total ??
        DEFAULT_FREE_TRIAL_CREDITS_TOTAL
    ),
    0
  );
  const useTrialDisplayTotal = isFreeLikePlan && effectiveTotal <= 0 && trialTotal > 0;
  const displayTotal = useTrialDisplayTotal ? trialTotal : effectiveTotal;
  const remainingCandidate =
    useTrialDisplayTotal && (summary.trial_state?.consumed || summary.trial_state?.blocked)
      ? 0
      : effectiveRemaining;
  const remaining = displayTotal > 0
    ? Math.min(Math.max(remainingCandidate, 0), displayTotal)
    : 0;
  const used = displayTotal > 0 ? Math.max(displayTotal - remaining, 0) : 0;
  const remainingRatio = displayTotal > 0 ? remaining / displayTotal : explicitUnlimited ? 1 : 0;
  const creditsPerEvent = options?.creditsPerEvent;
  const messagesRemaining =
    explicitUnlimited || !creditsPerEvent || creditsPerEvent <= 0
      ? null
      : Math.max(0, Math.floor(remaining / creditsPerEvent));
  const exhausted = summary.credits_exhausted === true || (!explicitUnlimited && remaining <= 0);
  const low = !exhausted && (summary.credits_low === true || remainingRatio <= CREDIT_LOW_RATIO);
  const warning = !exhausted && !low && remainingRatio <= CREDIT_WARNING_RATIO;
  const tone: CreditTone = exhausted ? "exhausted" : low ? "low" : warning ? "warning" : "normal";

  return {
    planName,
    remaining,
    total: displayTotal,
    used,
    cycleTotal,
    cycleUsed,
    cycleRemaining,
    effectiveTotal,
    effectiveRemaining,
    topUpBalance,
    remainingRatio,
    isUnlimited: explicitUnlimited,
    tone,
    messagesRemaining,
  };
};
