import { cloudevalReviewRulePack } from "@ganakailabs/cloudeval-signalstory-rules/review";
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
  scoreRating: string;
  failedTests: number;
  policyStatus: string;
  monthlyCost: string;
  weakestPillar: string;
};

export const renderSignalStoryPlainText = (parts: SignalStoryPart[] = []): string =>
  renderPlainText(parts);

const normalizePublicBrand = (text: string): string =>
  text.replace(/\bCloudEval\b/g, "Cloudeval");

export const buildSignalStoryReviewFallback = (
  input: SignalStoryReviewInput
): Record<string, unknown> | null => {
  const engine = createSignalStoryEngine({
    rulePacks: [cloudevalReviewRulePack],
  });
  const stories = engine.generate({ signals: input });
  const primary = stories[0];
  if (!primary) {
    return null;
  }
  const shortSummary = normalizePublicBrand(renderSignalStoryPlainText(primary.sentence));
  const detailsMarkdown = [
    `**Main risk**\n${shortSummary}`,
    `**Why it matters**\n${normalizePublicBrand(renderSignalStoryPlainText(primary.rationale ?? []))}`,
    `**Recommended actions**\n${normalizePublicBrand(primary.action?.label ?? "Rerun the review after remediation.")}`,
    "**Evidence used**\n**Gate status**, **Well-Architected score**, **validation totals**, **policy totals**, and **monthly cost**.",
  ].join("\n\n");

  return {
    enabled: true,
    status: "fallback",
    fallbackUsed: true,
    warnings: [],
    shortSummary,
    detailsMarkdown,
    markdown: normalizePublicBrand(renderGithubSummary(stories as SignalStoryStory[], {
      title: "Cloudeval review summary",
    })),
  };
};
