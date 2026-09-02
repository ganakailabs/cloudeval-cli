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
