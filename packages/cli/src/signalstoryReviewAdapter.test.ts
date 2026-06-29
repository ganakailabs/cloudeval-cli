import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSignalStoryReviewFallback,
  renderSignalStoryPlainText,
} from "./signalstoryReviewAdapter.js";

test("builds deterministic review fallback from installed SignalStory runtime", () => {
  const fallback = buildSignalStoryReviewFallback({
    gateStatus: "FAIL",
    score: "64/100",
    rating: "FAIR",
    failedTests: 2,
    policyStatus: "GOOD",
    monthlyCost: "$120/mo",
    weakestPillar: "Reliability",
  });

  assert.match(
    String(fallback?.shortSummary),
    /CloudEval review completed with FAIL/
  );
  assert.match(String(fallback?.markdown), /### CloudEval review summary/);
  assert.match(String(fallback?.markdown), /\*\*FAIL\*\*/);
});
