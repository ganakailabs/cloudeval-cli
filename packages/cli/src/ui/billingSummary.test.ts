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
