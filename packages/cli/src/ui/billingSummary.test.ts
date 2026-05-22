import assert from "node:assert/strict";
import test from "node:test";
import { billingSummaryText, creditProgressText } from "./billingSummary";

test("creditProgressText renders a bounded progress bar", () => {
  assert.equal(creditProgressText({ remaining: 75, total: 100, width: 10 }), "[████████░░] 75%");
  assert.equal(creditProgressText({ remaining: 150, total: 100, width: 10 }), "[██████████] 100%");
  assert.equal(creditProgressText({ remaining: -5, total: 100, width: 10 }), "[░░░░░░░░░░] 0%");
});

test("billingSummaryText includes plan, credits, and progress without subscription status", () => {
  assert.equal(
    billingSummaryText({
      plan: "Free",
      remaining: 75,
      total: 100,
      status: "trial_active",
    }),
    "Plan: Free | Credits: 75/100 [████████░░] 75%"
  );
});

test("billingSummaryText separates used credits from remaining budget", () => {
  assert.equal(
    billingSummaryText({
      plan: "Free",
      remaining: 0,
      total: 1000,
      used: 1000,
      reportedUsed: 2063,
      tone: "exhausted",
    }),
    "Plan: Free | Credits: 0 left | Used: 2,063 [░░░░░░░░░░] 0%"
  );
});

test("billingSummaryText shows remaining progress when credits are left with usage", () => {
  assert.equal(
    billingSummaryText({
      plan: "Free",
      remaining: 540,
      total: 3063,
      used: 2523,
      reportedUsed: 2523,
      tone: "normal",
    }),
    "Plan: Free | Credits: 540 left | Used: 2,523 [██░░░░░░░░] 18%"
  );
});
