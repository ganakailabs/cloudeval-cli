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
      : "no failing unit tests";
  const weakestPillar = input.weakestPillar || "the weakest Well-Architected pillar";
  return `${testFocus}, ${input.policyStatus || "policy status unknown"}, and ${weakestPillar}`;
};

export const buildSignalStoryReviewFallback = (
  input: SignalStoryReviewInput
): Record<string, unknown> | null => {
  const gateStatus = input.gateStatus || "UNKNOWN";
  const scoreRating = input.scoreRating || `${input.score || "unknown score"} (${input.rating || "unrated"})`;
  const monthlyCost = input.monthlyCost || "cost unavailable";
  const findingFocus = formatFindingFocus(input);
  const shortSummary = normalizePublicBrand(
    `Cloudeval review completed with **${gateStatus}**. Well-Architected posture is **${scoreRating}**, monthly cost is **${monthlyCost}**, and the review focus is **${findingFocus}**. Prioritize failed validation checks and the weakest Well-Architected pillar before merging.`,
  );
  const detailsMarkdown = [
    `**Main risk**\n${shortSummary}`,
    `**Why it matters**\nA weak **${input.weakestPillar || "Well-Architected"}** posture, failing validation, or unmanaged cost movement can turn an IaC change into production risk even when deployment syntax is valid.`,
    `**Recommended actions**\nFix the named validation failures first, remediate the lowest-scoring Well-Architected pillar, rerun the review, and use the linked Cloudeval reports for evidence.`,
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
