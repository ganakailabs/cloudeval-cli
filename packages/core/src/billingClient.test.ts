import assert from "node:assert/strict";
import test from "node:test";
import { getCreditStatus, getBillingEntitlement } from "./billingClient";

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
