import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  normalizeSeverity,
  summarizeFindings,
  type FindingSeverity,
  type IacDocumentIndex,
  type ResourceIndexItem,
} from "./iacIndex.js";

export type FindingCategory =
  | "security"
  | "cost"
  | "well_architected"
  | "policy"
  | "drift"
  | "deployment_quality";

export interface Freshness {
  source: "local" | "report" | "live" | "billing" | "unknown";
  observedAt: string;
  stale: boolean;
}

export interface EvidenceRef {
  id: string;
  source: string;
  observedAt: string;
  description?: string;
  uri?: string;
}

export interface CloudEvalFinding {
  id: string;
  ruleId: string;
  title: string;
  severity: FindingSeverity;
  category: FindingCategory;
  resource: ResourceIndexItem;
  message: string;
  recommendation?: string;
  confidence: "high" | "medium" | "low";
  fixability: "draftable" | "manual" | "not_supported";
  freshness: Freshness;
  evidenceRefs: EvidenceRef[];
}

export interface ReviewLocalRun {
  id: string;
  command: string;
  createdAt: string;
  workspace?: string;
  indexes: IacDocumentIndex[];
  findings: CloudEvalFinding[];
  summary: ReturnType<typeof summarizeFindings>;
  warnings: string[];
  freshness: Freshness;
  evidence: EvidenceRef[];
  raw?: unknown;
  cacheFile?: string;
}

export interface CiInitPlan {
  provider: "github-actions" | "azure-pipelines";
  projectId: string;
  writesFiles: boolean;
  files: Array<{ path: string; content: string }>;
}

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const arrayValue = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];

const firstString = (
  record: Record<string, unknown> | undefined,
  fields: string[],
): string | undefined => {
  for (const field of fields) {
    const value = record?.[field];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
};

const stableHash = (parts: unknown[]): string =>
  createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("|"))
    .digest("hex")
    .slice(0, 12);

const failedStatus = (value: unknown): boolean =>
  ["fail", "failed", "error", "critical", "warning"].includes(
    String(value ?? "").trim().toLowerCase(),
  );

const categoryFor = (value: unknown): FindingCategory => {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("cost") || text.includes("finops")) return "cost";
  if (text.includes("policy") || text.includes("compliance")) return "policy";
  if (text.includes("drift")) return "drift";
  if (text.includes("well") || text.includes("waf") || text.includes("architect")) {
    return "well_architected";
  }
  if (text.includes("deploy") || text.includes("quality") || text.includes("test")) {
    return "deployment_quality";
  }
  return "security";
};

const detailsFromValidationData = (value: unknown): Record<string, unknown>[] => {
  const record = recordValue(value);
  const nested = recordValue(record?.result) ?? recordValue(record?.data);
  return arrayValue(record?.details ?? nested?.details)
    .map((item) => recordValue(item))
    .filter((item): item is Record<string, unknown> => Boolean(item));
};

const fallbackResource = (indexes: IacDocumentIndex[]): ResourceIndexItem => {
  const resource = indexes.flatMap((index) => index.resources)[0];
  if (resource) {
    return resource;
  }
  const firstIndex = indexes[0];
  return {
    adapter: firstIndex?.adapter ?? "arm",
    filePath: firstIndex?.filePath ?? "",
    supportLevel: firstIndex?.supportLevel ?? "unsupported",
    range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 0 },
  };
};

const matchResource = (
  detail: Record<string, unknown>,
  indexes: IacDocumentIndex[],
): ResourceIndexItem => {
  const target = recordValue(detail.target);
  const targetName = firstString(target, ["name", "id"]);
  const targetType = firstString(target, ["type"]);
  const resources = indexes.flatMap((index) => index.resources);
  return (
    resources.find((resource) => {
      const nameMatches =
        targetName &&
        (resource.resourceName === targetName || resource.address?.endsWith(`.${targetName}`));
      const typeMatches = !targetType || resource.resourceType === targetType;
      return Boolean(nameMatches && typeMatches);
    }) ??
    resources.find((resource) => targetName && resource.address?.includes(targetName)) ??
    fallbackResource(indexes)
  );
};

const buildFinding = (
  detail: Record<string, unknown>,
  indexes: IacDocumentIndex[],
  observedAt: string,
): CloudEvalFinding | undefined => {
  if (!failedStatus(firstString(detail, ["status", "outcome", "result"]))) {
    return undefined;
  }
  const evidence = recordValue(detail.evidence);
  const resource = matchResource(detail, indexes);
  const ruleId =
    firstString(detail, ["rule_id", "ruleId", "rule_name", "ruleName", "name"]) ??
    "CLOUDEVAL-LOCAL";
  const title =
    firstString(detail, ["display_name", "displayName", "title", "name"]) ??
    ruleId;
  const message =
    firstString(detail, ["message", "description"]) ??
    firstString(evidence, ["description", "synopsis"]) ??
    title;
  const recommendation =
    firstString(detail, ["recommendation", "remediation"]) ??
    firstString(evidence, ["recommendation", "remediation"]);
  const freshness: Freshness = {
    source: "local",
    observedAt,
    stale: false,
  };
  const findingId = `ce-find-${stableHash([ruleId, resource.address, title])}`;
  return {
    id: findingId,
    ruleId,
    title,
    severity: normalizeSeverity(firstString(detail, ["severity", "level"])),
    category: categoryFor(firstString(detail, ["category", "pillar", "source"])),
    resource,
    message,
    ...(recommendation ? { recommendation } : {}),
    confidence: resource.address ? "high" : "medium",
    fixability: recommendation ? "manual" : "not_supported",
    freshness,
    evidenceRefs: [
      {
        id: `evidence-${stableHash([findingId, message])}`,
        source: firstString(detail, ["source"]) ?? "template_validation",
        observedAt,
        description: message,
        uri: firstString(evidence, [
          "documentation_url",
          "documentationUrl",
          "help_url",
          "helpUrl",
        ]),
      },
    ],
  };
};

export const ideRunCachePath = (input: {
  workspace: string;
  runId: string;
}): string =>
  path.join(input.workspace, ".cloudeval", "ide-runs", `${input.runId}.json`);

export const readIdeRunCache = async (input: {
  workspace: string;
  runId: string;
}): Promise<ReviewLocalRun> =>
  JSON.parse(await fs.readFile(ideRunCachePath(input), "utf8")) as ReviewLocalRun;

export const buildReviewLocalRun = async (input: {
  command: string;
  indexes: IacDocumentIndex[];
  validationData?: unknown;
  workspace?: string;
  warnings?: string[];
}): Promise<ReviewLocalRun> => {
  const createdAt = new Date().toISOString();
  const findings = detailsFromValidationData(input.validationData)
    .map((detail) => buildFinding(detail, input.indexes, createdAt))
    .filter((finding): finding is CloudEvalFinding => Boolean(finding));
  const runId = `ide-run-${stableHash([
    input.command,
    JSON.stringify(input.indexes),
    JSON.stringify(findings.map((finding) => finding.id)),
  ])}`;
  const freshness: Freshness = {
    source: "local",
    observedAt: createdAt,
    stale: false,
  };
  const run: ReviewLocalRun = {
    id: runId,
    command: input.command,
    createdAt,
    workspace: input.workspace,
    indexes: input.indexes,
    findings,
    summary: summarizeFindings(findings),
    warnings: input.warnings ?? [],
    freshness,
    evidence: findings.flatMap((finding) => finding.evidenceRefs),
    raw: input.validationData,
  };
  if (input.workspace) {
    const cacheFile = ideRunCachePath({ workspace: input.workspace, runId });
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    await fs.writeFile(cacheFile, `${JSON.stringify({ ...run, cacheFile }, null, 2)}\n`, "utf8");
    run.cacheFile = cacheFile;
  }
  return run;
};

export const buildFindingEvidence = async (input: {
  workspace: string;
  runId: string;
  findingId: string;
}) => {
  const run = await readIdeRunCache(input);
  const finding = run.findings.find((candidate) => candidate.id === input.findingId);
  if (!finding) {
    throw new Error(`Finding ${input.findingId} was not found in run ${input.runId}.`);
  }
  return {
    runId: run.id,
    finding,
    evidenceRefs: finding.evidenceRefs,
    freshness: finding.freshness,
    source: "run_cache",
  };
};

export const buildDraftFix = async (input: {
  workspace: string;
  runId: string;
  findingId: string;
}) => {
  const evidence = await buildFindingEvidence(input);
  return {
    runId: input.runId,
    findingId: input.findingId,
    status: "manual_review_required",
    mutatesFiles: false,
    patch: undefined as string | undefined,
    explanation:
      evidence.finding.recommendation ??
      "Cloudeval has evidence for this finding, but no safe deterministic patch is available yet.",
    evidenceRefs: evidence.evidenceRefs,
  };
};

const githubActionsWorkflow = (projectId: string): string => `name: Cloudeval review

on:
  pull_request:
    paths:
      - "**/*.json"
      - "**/*.bicep"
      - "**/*.tf"
      - "**/*.tofu"
      - ".cloudeval/**"

jobs:
  cloudeval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install -g @ganakailabs/cloudeval-cli
      - name: Cloudeval review
        env:
          CLOUDEVAL_ACCESS_KEY: \${{ secrets.CLOUDEVAL_ACCESS_KEY }}
        run: |
          cloudeval review --project ${projectId} --ignore-dirty --format json --non-interactive
`;

const azurePipelinesWorkflow = (projectId: string): string => `trigger: none

pr:
  branches:
    include:
      - "*"

pool:
  vmImage: ubuntu-latest

steps:
  - task: NodeTool@0
    inputs:
      versionSpec: "20.x"
  - script: npm install -g @ganakailabs/cloudeval-cli
    displayName: Install Cloudeval CLI
  - script: cloudeval review --project ${projectId} --ignore-dirty --format json --non-interactive
    displayName: Cloudeval review
    env:
      CLOUDEVAL_ACCESS_KEY: $(CLOUDEVAL_ACCESS_KEY)
`;

const gateConfig = (projectId: string): string => `version: 1

project: ${projectId}

ci:
  gates:
    enforcement: block_pull_request
    fail_when_high_risk_findings_exist: true
    fail_when_cloud_posture_findings_exist: false
    fail_when_validation_fails: true
  review:
    outputs:
      pdf:
        enabled: true
        report_type: all
        verbosity: evidence
        fail_on_error: false
`;

export const buildCiInitPlan = (input: {
  projectId: string;
  provider?: string;
  write?: boolean;
}): CiInitPlan => {
  const provider =
    input.provider === "azure-pipelines" ? "azure-pipelines" : "github-actions";
  return {
    provider,
    projectId: input.projectId,
    writesFiles: Boolean(input.write),
    files: [
      { path: ".cloudeval/config.yaml", content: gateConfig(input.projectId) },
      provider === "github-actions"
        ? {
            path: ".github/workflows/cloudeval-review.yml",
            content: githubActionsWorkflow(input.projectId),
          }
        : {
            path: "azure-pipelines-cloudeval.yml",
            content: azurePipelinesWorkflow(input.projectId),
          },
    ],
  };
};

export const writeCiInitPlan = async (
  plan: CiInitPlan,
  workspace = process.cwd(),
): Promise<string[]> => {
  const written: string[] = [];
  for (const file of plan.files) {
    const target = path.join(workspace, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
    written.push(target);
  }
  return written;
};

export const buildGraphNeighborhood = (input: {
  projectId: string;
  resourceId: string;
  graphData: unknown;
}) => ({
  projectId: input.projectId,
  resourceId: input.resourceId,
  focus: "impact",
  graphData: input.graphData,
});
