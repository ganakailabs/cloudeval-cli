export type SignalStoryReviewInput = {
  gateStatus: string;
  score: string;
  rating: string;
  scoreRating: string;
  failedTests: number;
  policyStatus: string;
  monthlyCost: string;
  weakestPillar: string;
};

const normalizePublicBrand = (text: string): string =>
  text.replace(/\bCloudEval\b/g, "Cloudeval");

const formatFindingFocus = (input: SignalStoryReviewInput): string => {
  const failedTests = Number(input.failedTests || 0);
  const testFocus =
    failedTests > 0
      ? `${failedTests} failed unit test${failedTests === 1 ? "" : "s"}`
      : "validation clean";
  const weakestPillar = input.weakestPillar || "the weakest Well-Architected pillar";
  return `${testFocus}, ${input.policyStatus || "policy status unknown"}, and ${weakestPillar}`;
};

const hasPolicyFailures = (policyStatus: string): boolean =>
  Boolean(policyStatus && !/^good$/i.test(policyStatus.trim()));

const isWeakPosture = (rating: string): boolean =>
  /^(critical|poor|fair)$/i.test(String(rating || "").trim());

export const buildSignalStoryReviewFallback = (
  input: SignalStoryReviewInput
): Record<string, unknown> | null => {
  const gateStatus = input.gateStatus || "UNKNOWN";
  const scoreRating = input.scoreRating || `${input.score || "unknown score"} (${input.rating || "unrated"})`;
  const monthlyCost = input.monthlyCost || "cost unavailable";
  const findingFocus = formatFindingFocus(input);
  const failedTests = Number(input.failedTests || 0);
  const policyFailed = hasPolicyFailures(input.policyStatus || "");
  const policyText = policyFailed
    ? `policy checks **${input.policyStatus}**`
    : "policy checks are **GOOD**";
  const validationText = failedTests > 0
    ? `validation has **${failedTests} failed unit test${failedTests === 1 ? "" : "s"}**`
    : "validation is **clean**";
  const recommendedAction = failedTests > 0
    ? "Fix the named validation failures, rerun the review, and confirm the gate clears."
    : policyFailed
      ? "Fix failed policy checks, rerun the review, and confirm the gate clears."
      : isWeakPosture(input.rating)
        ? "Remediate the lowest-scoring Well-Architected pillar, then rerun the review."
        : "Review the linked reports and merge according to your configured policy.";
  const shortSummary = normalizePublicBrand(
    `Cloudeval review completed with **${gateStatus}**. Well-Architected posture is **${scoreRating}**, ${validationText}, ${policyText}, and monthly cost is **${monthlyCost}**. ${recommendedAction}`,
  );
  const detailsMarkdown = [
    `**Main risk**\n${shortSummary}`,
    `**Why it matters**\nThe review focus is **${findingFocus}**. Architecture posture, validation health, and cost movement are the evidence signals most likely to affect merge risk.`,
    `**Recommended actions**\n${recommendedAction}`,
    "**Evidence used**\n**Gate status**, **Well-Architected score**, **validation totals**, **policy totals**, and **monthly cost**.",
  ].join("\n\n");

  return {
    enabled: true,
    status: "fallback",
    fallbackUsed: true,
    warnings: [],
    shortSummary,
    detailsMarkdown,
    markdown: `### Cloudeval review summary\n\n${shortSummary}\n\n${detailsMarkdown}`,
  };
};
