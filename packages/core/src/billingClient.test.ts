import assert from "node:assert/strict";
import test from "node:test";
import {
  createTopUpCheckoutSession,
  getCreditStatus,
  getBillingEntitlement,
} from "./billingClient";

test("getCreditStatus derives visible credit state from entitlement", () => {
  const status = getCreditStatus({
    plan: { id: "pro", name: "Pro", price_usd: 20 },
    plan_source: "subscription",
    balance: {
      credits_total: 1000,
      credits_used: 750,
      credits_remaining: 250,
      credits_total_cycle: 800,
      credits_used_cycle: 600,
      credits_remaining_cycle: 200,
      credits_total_effective: 1050,
      credits_remaining_effective: 300,
      top_up_credits_balance: 100,
    },
  } as any);

  assert.deepEqual(status, {
    planName: "Pro",
    remaining: 300,
    total: 1050,
    used: 750,
    reportedUsed: 750,
    cycleTotal: 800,
    cycleUsed: 600,
    cycleRemaining: 200,
    effectiveTotal: 1050,
    effectiveRemaining: 300,
    topUpBalance: 100,
    remainingRatio: 300 / 1050,
    isUnlimited: false,
    tone: "normal",
    messagesRemaining: null,
  });
});

test("getCreditStatus keeps entitlement total separate from reported usage", () => {
  const status = getCreditStatus(
    {
      plan: { id: "free", name: "Free", price_usd: 0 },
      plan_source: "free",
      balance: {
        credits_total: 0,
        credits_used: 0,
        credits_remaining: 0,
        credits_total_effective: 101,
        credits_remaining_effective: 101,
        top_up_credits_balance: 101,
      },
    } as any,
    { reportedUsedCredits: 24 }
  );

  assert.equal(status?.remaining, 101);
  assert.equal(status?.used, 24);
  assert.equal(status?.reportedUsed, 24);
  assert.equal(status?.total, 125);
  assert.equal(status?.remainingRatio, 101 / 125);
});

test("getCreditStatus aligns progress with remaining and reported usage", () => {
  const status = getCreditStatus(
    {
      plan: { id: "free", name: "Free", price_usd: 0 },
      plan_source: "free",
      balance: {
        credits_total: 0,
        credits_used: 0,
        credits_remaining: 0,
        credits_total_effective: 0,
        credits_remaining_effective: 540,
        top_up_credits_balance: 0,
      },
    } as any,
    { reportedUsedCredits: 2523 }
  );

  assert.equal(status?.remaining, 540);
  assert.equal(status?.reportedUsed, 2523);
  assert.equal(status?.total, 3063);
  assert.equal(status?.used, 2523);
  assert.ok(
    Math.abs((status?.remainingRatio ?? 0) - 540 / 3063) < 0.001,
    `expected remainingRatio near ${540 / 3063}, got ${status?.remainingRatio}`
  );
});

test("getCreditStatus does not show consumed credits as the credit budget", () => {
  const status = getCreditStatus(
    {
      plan: { id: "free", name: "Free", price_usd: 0 },
      plan_source: "free",
      balance: {
        credits_total: 0,
        credits_used: 0,
        credits_remaining: 0,
        credits_total_effective: 0,
        credits_remaining_effective: 0,
        top_up_credits_balance: 0,
      },
      trial_state: { credits_total: 1000, consumed: true },
      credits_exhausted: true,
    } as any,
    { reportedUsedCredits: 2063 }
  );

  assert.equal(status?.remaining, 0);
  assert.equal(status?.total, 2063);
  assert.equal(status?.used, 2063);
  assert.equal(status?.reportedUsed, 2063);
  assert.equal(status?.remainingRatio, 0);
});

test("getBillingUsageCreditsUsed reads frontend-aligned usage totals", async () => {
  const { getBillingUsageCreditsUsed } = await import("./billingClient");

  assert.equal(
    getBillingUsageCreditsUsed({
      totals: {
        credits_used: 42,
        events: 8,
      },
    }),
    42
  );
  assert.equal(getBillingUsageCreditsUsed({ total_credits: 12 }), 12);
});

test("getBillingEntitlement reads frontend-aligned endpoint", async () => {
  const calls: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({
        data: {
          plan: { id: "free", name: "Free", price_usd: 0 },
          plan_source: "trial",
          balance: { credits_total: 150, credits_used: 10, credits_remaining: 140 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const entitlement = await getBillingEntitlement({
      baseUrl: "https://api.example.test/api/v1",
      authToken: "token",
    });
    assert.equal(calls[0], "https://api.example.test/api/v1/billing/entitlement");
    assert.equal(entitlement.plan.id, "free");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("createTopUpCheckoutSession posts pack and checkout preferences", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        session_id: "cs_test",
        flow_type: "top_up",
        status: "created",
        expires_at: "2026-05-04T03:00:00",
        checkout_mode: "standard_checkout",
        launcher_url: "https://app.example.test/app/subscription/checkout-launcher?session_id=cs_test",
        resolved_currency: "USD",
        display_amount_major: 9,
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  try {
    const session = await createTopUpCheckoutSession({
      baseUrl: "https://api.example.test/api/v1",
      authToken: "token",
      packId: "starter",
      preferredCurrency: "USD",
      countryCode: "US",
      contactEmail: "user@example.test",
      returnTo: "https://app.example.test/app/subscription?tab=billing",
    });

    assert.equal(
      calls[0].url,
      "https://api.example.test/api/v1/billing/checkout/session/top-up"
    );
    assert.equal(calls[0].init?.method, "POST");
    assert.equal(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      "Bearer token"
    );
    assert.match(
      (calls[0].init?.headers as Record<string, string>)["Idempotency-Key"],
      /^[0-9a-f-]{36}$/
    );
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      pack_id: "starter",
      preferred_currency: "USD",
      country_code: "US",
      contact_email: "user@example.test",
      return_to: "https://app.example.test/app/subscription?tab=billing",
    });
    assert.equal(session.session_id, "cs_test");
    assert.equal(session.flow_type, "top_up");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
