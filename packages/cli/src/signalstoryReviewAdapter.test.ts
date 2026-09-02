import assert from "node:assert/strict";
import test from "node:test";
import { buildSignalStoryReviewFallback } from "./signalstoryReviewAdapter.js";

test("builds deterministic review fallback without private runtime dependencies", () => {
  const fallback = buildSignalStoryReviewFallback({
    gateStatus: "FAIL",
    score: "64/100",
    rating: "FAIR",
    scoreRating: "64/100 (FAIR)",
    failedTests: 2,
    policyStatus: "GOOD",
    monthlyCost: "$120/mo",
    weakestPillar: "Reliability",
  });

  assert.match(
    String(fallback?.shortSummary),
    /Cloudeval review completed with \*\*FAIL\*\*/
  );
  assert.match(String(fallback?.shortSummary), /\*\*64\/100 \(FAIR\)\*\*/);
  assert.match(String(fallback?.markdown), /### Cloudeval review summary/);
  assert.match(String(fallback?.markdown), /\*\*Main risk\*\*/);
  assert.match(String(fallback?.markdown), /\*\*Recommended actions\*\*/);
});

test("deterministic review fallback does not mention failed validation when validation is clean", () => {
  const fallback = buildSignalStoryReviewFallback({
    gateStatus: "WARN",
    score: "91/100",
    rating: "EXCELLENT",
    scoreRating: "91/100 (EXCELLENT)",
    failedTests: 0,
    policyStatus: "GOOD",
    monthlyCost: "42 USD/mo",
    weakestPillar: "Security",
  });

  assert.match(String(fallback?.shortSummary), /validation is \*\*clean\*\*/);
  assert.doesNotMatch(String(fallback?.shortSummary), /failed validation/i);
  assert.doesNotMatch(String(fallback?.shortSummary), /failed unit tests/i);
  assert.match(
    String(fallback?.shortSummary),
    /Review the linked reports and merge according to your configured policy/,
  );
});
