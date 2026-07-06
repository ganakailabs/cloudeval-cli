import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { IacDocumentIndex } from "./iacIndex";
import {
  buildCiInitPlan,
  buildDraftFix,
  buildFindingEvidence,
  buildGraphNeighborhood,
  buildReviewLocalRun,
  readIdeRunCache,
} from "./ideContracts";

const index: IacDocumentIndex = {
  adapter: "arm",
  filePath: "/workspace/main.json",
  supportLevel: "full",
  resources: [
    {
      adapter: "arm",
      filePath: "/workspace/main.json",
      supportLevel: "full",
      range: { startLine: 4, startCharacter: 4, endLine: 10, endCharacter: 5 },
      address: "Microsoft.Storage/storageAccounts.stg",
      resourceType: "Microsoft.Storage/storageAccounts",
      resourceName: "stg",
    },
  ],
};

test("buildReviewLocalRun normalizes validation details into deterministic IDE findings", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-ide-run-"));
  const run = await buildReviewLocalRun({
    command: "review local",
    workspace: cacheDir,
    indexes: [index],
    validationData: {
      details: [
        {
          rule_id: "AZ-STG-001",
          display_name: "Storage account allows public access",
          status: "Fail",
          severity: "critical",
          category: "Security",
          target: {
            name: "stg",
            type: "Microsoft.Storage/storageAccounts",
          },
          evidence: {
            description: "Public network access is enabled.",
            recommendation: "Disable public access unless explicitly required.",
            documentation_url: "https://example.test/rules/AZ-STG-001",
          },
        },
        {
          rule_id: "AZ-STG-002",
          display_name: "Storage account has tags",
          status: "Pass",
          severity: "low",
        },
      ],
    },
    warnings: [],
  });

  assert.equal(run.findings.length, 1);
  assert.equal(run.findings[0].id, "ce-find-5a2cbaf53f68");
  assert.equal(run.findings[0].ruleId, "AZ-STG-001");
  assert.equal(run.findings[0].resource.resourceName, "stg");
  assert.equal(run.summary.statusText, "1 critical");
  assert.equal(run.cacheFile?.endsWith(`${run.id}.json`), true);

  const cached = await readIdeRunCache({ runId: run.id, workspace: cacheDir });
  assert.equal(cached.findings[0].id, run.findings[0].id);
});

test("buildFindingEvidence and buildDraftFix are evidence-backed and non-mutating", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "cloudeval-ide-evidence-"));
  const run = await buildReviewLocalRun({
    command: "review local",
    workspace: cacheDir,
    indexes: [index],
    validationData: {
      details: [
        {
          rule_id: "AZ-STG-001",
          display_name: "Storage account allows public access",
          status: "Fail",
          severity: "high",
          target: { name: "stg", type: "Microsoft.Storage/storageAccounts" },
          evidence: {
            description: "Public network access is enabled.",
            recommendation: "Disable public access unless explicitly required.",
          },
        },
      ],
    },
    warnings: [],
  });
  const evidence = await buildFindingEvidence({
    runId: run.id,
    findingId: run.findings[0].id,
    workspace: cacheDir,
  });
  const draft = await buildDraftFix({
    runId: run.id,
    findingId: run.findings[0].id,
    workspace: cacheDir,
  });

  assert.equal(evidence.finding.id, run.findings[0].id);
  assert.equal(evidence.evidenceRefs.length, 1);
  assert.equal(draft.status, "manual_review_required");
  assert.equal(draft.mutatesFiles, false);
  assert.equal(draft.patch, undefined);
});

test("buildCiInitPlan generates review workflow and gate config without writing by default", async () => {
  const plan = buildCiInitPlan({
    projectId: "project-1",
    provider: "github-actions",
  });

  assert.equal(plan.provider, "github-actions");
  assert.equal(plan.files.length, 2);
  assert.equal(plan.files[0].path, ".cloudeval/config.yaml");
  assert.match(plan.files[1].content, /cloudeval review/);
  assert.equal(plan.writesFiles, false);
});

test("buildGraphNeighborhood wraps graph insight payload for scoped architecture view", () => {
  const data = buildGraphNeighborhood({
    projectId: "project-1",
    resourceId: "resource-1",
    graphData: { insights: [{ id: "risk-1" }], nodes: [{ id: "resource-1" }] },
  });

  assert.equal(data.projectId, "project-1");
  assert.equal(data.resourceId, "resource-1");
  assert.deepEqual(data.graphData, { insights: [{ id: "risk-1" }], nodes: [{ id: "resource-1" }] });
});
