import {
  createSignalStoryEngine,
  renderPlainText,
  type SignalStoryPart,
  type SignalStoryStory,
} from "signalstory/core";
import { renderGithubSummary } from "signalstory/markdown";

export type SignalStoryReviewInput = {
  gateStatus: string;
  score: string;
  rating: string;
  failedTests: number;
  policyStatus: string;
  monthlyCost: string;
  weakestPillar: string;
};

export const renderSignalStoryPlainText = (parts: SignalStoryPart[] = []): string =>
  renderPlainText(parts);

const REVIEW_FALLBACK_RULE_PACK = {
  id: "cloudeval-review-fallback",
  rules: [
    {
      id: "review-fallback",
      when: { signal: "gateStatus", exists: true },
      story: {
        id: "review-fallback",
        severity: "high",
        icon: "git-pull-request",
        priority: 100,
        sentence: [
          { text: "CloudEval review completed with " },
          { path: "gateStatus", marks: ["bold"] },
          { text: ". Well-Architected posture is " },
          { path: "score", marks: ["bold"] },
          { text: " (" },
          { path: "rating", marks: ["bold"] },
          { text: "), validation has " },
          { path: "failedTests", suffix: " failed unit tests", marks: ["bold"] },
          { text: ", policy checks are " },
          { path: "policyStatus", marks: ["bold"] },
          { text: ", and monthly cost is " },
          { path: "monthlyCost", marks: ["bold"] },
          { text: ". Prioritize " },
          { text: "failed validation checks", marks: ["bold"] },
          { text: " and " },
          { path: "weakestPillar", marks: ["bold"] },
          { text: " first." },
        ],
        rationale: [
          {
            text: "Failed validation, weak architecture pillars, and cost over budget are the highest-signal remediation inputs before merge.",
          },
        ],
        action: { label: "Fix failed validation checks and rerun the review." },
      },
    },
  ],
};

export const buildSignalStoryReviewFallback = (
  input: SignalStoryReviewInput
): Record<string, unknown> | null => {
  const engine = createSignalStoryEngine({
    rulePacks: [REVIEW_FALLBACK_RULE_PACK],
  });
  const stories = engine.generate({ signals: input });
  const primary = stories[0];
  if (!primary) {
    return null;
  }
  const shortSummary = renderSignalStoryPlainText(primary.sentence);
  const detailsMarkdown = [
    `**Main risk**\n${renderSignalStoryPlainText(primary.sentence)}`,
    `**Why it matters**\n${renderSignalStoryPlainText(primary.rationale ?? [])}`,
    `**Recommended actions**\n${primary.action?.label ?? "Rerun the review after remediation."}`,
    "**Evidence used**\n**Gate status**, **Well-Architected score**, **validation totals**, **policy totals**, and **monthly cost**.",
  ].join("\n\n");

  return {
    enabled: true,
    status: "fallback",
    fallbackUsed: true,
    warnings: [],
    shortSummary,
    detailsMarkdown,
    markdown: renderGithubSummary(stories as SignalStoryStory[], {
      title: "CloudEval review summary",
    }),
  };
};
