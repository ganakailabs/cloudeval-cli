import type { ReviewFinding } from "./reviewFindings.js";

type SarifLevel = "error" | "warning" | "note";

const sarifLevel = (finding: ReviewFinding): SarifLevel => {
  if (finding.level === "failure") return "error";
  if (finding.level === "warning") return "warning";
  return "note";
};

const ruleId = (finding: ReviewFinding): string =>
  String(finding.id || `${finding.kind}:${finding.title}`)
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);

const uniqueRules = (findings: ReviewFinding[]) => {
  const rules = new Map<string, any>();
  for (const finding of findings) {
    const id = ruleId(finding);
    if (rules.has(id)) continue;
    rules.set(id, {
      id,
      name: finding.title,
      shortDescription: { text: finding.title },
      fullDescription: { text: finding.message },
      properties: {
        category: finding.kind,
        ...(finding.severity ? { severity: finding.severity } : {}),
      },
    });
  }
  return [...rules.values()];
};

export const buildReviewSarifLog = ({
  findings,
  category = "cloudeval-iac",
}: {
  findings: ReviewFinding[];
  category?: string;
}) => {
  const locatedFindings = findings.filter((finding) => finding.path);
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Cloudeval",
            informationUri: "https://cloudeval.ai",
            rules: uniqueRules(locatedFindings),
          },
        },
        automationDetails: {
          id: category,
        },
        results: locatedFindings.map((finding) => ({
          ruleId: ruleId(finding),
          level: sarifLevel(finding),
          message: {
            text: finding.message,
          },
          locations: [
            {
              physicalLocation: {
                artifactLocation: {
                  uri: finding.path,
                  uriBaseId: "%SRCROOT%",
                },
                region: {
                  startLine: Math.max(1, Math.floor(finding.startLine ?? 1)),
                  endLine: Math.max(1, Math.floor(finding.endLine ?? finding.startLine ?? 1)),
                },
              },
            },
          ],
          properties: {
            kind: finding.kind,
            title: finding.title,
            ...(finding.severity ? { severity: finding.severity } : {}),
          },
        })),
      },
    ],
  };
};
