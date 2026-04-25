import assert from "node:assert/strict";
import test from "node:test";
import type {
  CostParsedReport,
  ReportEnvelope,
  WafParsedReport,
} from "@cloudeval/shared";
import {
  renderReportMarkdown,
  renderReportSummary,
  selectReportModePayload,
  serializeReportOutput,
} from "./reportRender";

const costReport = (): ReportEnvelope<Record<string, unknown>, CostParsedReport> => ({
  id: "rpt-cost-1",
  kind: "cost",
  projectId: "project-1",
  generatedAt: "2026-04-25T10:22:31Z",
  source: { provider: "azure" },
  raw: { provider: "azure", rows: [{ service: "Compute", pretaxCost: 48200 }] },
  parsed: {
    totalSpend: { amount: 48200, currency: "USD", changePercent: 12.4 },
    estimatedSavings: { amount: 9700, currency: "USD", percentOfSpend: 20.1 },
    serviceGroups: [
      { name: "Compute", amount: 48200, currency: "USD", changePercent: 12.4 },
    ],
    recommendations: [
      {
        id: "cost-001",
        title: "Resize underutilized compute",
        monthlySavings: 9700,
        currency: "USD",
        risk: "medium",
      },
    ],
    anomalies: [],
    budgets: [],
    trend: [],
  },
  formatted: {
    title: "Cost report",
    summary: "Spend is up.",
    sections: [{ id: "summary", title: "Summary", markdown: "Spend is up." }],
  },
});

const wafReport = (): ReportEnvelope<Record<string, unknown>, WafParsedReport> => ({
  id: "rpt-waf-1",
  kind: "waf",
  projectId: "project-1",
  generatedAt: "2026-04-25T10:22:31Z",
  source: { provider: "azure" },
  raw: { provider: "azure", ruleResults: [{ ruleId: "REL-04" }] },
  parsed: {
    score: {
      overall: 74,
      pillars: [
        { id: "reliability", label: "Reliability", score: 62, passed: 7, warned: 6, failed: 4 },
      ],
    },
    counts: {
      passed: 38,
      highRisk: 7,
      mediumRisk: 12,
      evidenceCoveragePercent: 81,
    },
    rules: [
      {
        id: "REL-04",
        pillar: "Reliability",
        title: "Database tier lacks zone redundancy",
        status: "fail",
        severity: "high",
        resource: "sql-prod-01",
        evidence: "zoneRedundant=false",
      },
    ],
  },
  formatted: {
    title: "Well-Architected Framework report",
    summary: "Overall WAF score is 74/100.",
    sections: [
      {
        id: "priority-findings",
        title: "Priority findings",
        markdown: "- REL-04: Database tier lacks zone redundancy.",
      },
    ],
  },
});

test("selectReportModePayload returns raw parsed and formatted views", () => {
  const report = wafReport();

  assert.equal((selectReportModePayload(report, "raw") as any).provider, "azure");
  assert.equal((selectReportModePayload(report, "parsed") as any).score.overall, 74);
  assert.equal(
    (selectReportModePayload(report, "formatted") as any).title,
    "Well-Architected Framework report"
  );
});

test("serializeReportOutput emits clean JSON for raw and parsed automation", () => {
  const report = costReport();

  const raw = serializeReportOutput(report, { format: "json", mode: "raw" });
  const parsed = serializeReportOutput(report, { format: "json", mode: "parsed" });

  assert.doesNotMatch(raw, /\u001b\[/);
  assert.doesNotMatch(parsed, /\u001b\[/);
  assert.equal(JSON.parse(raw).provider, "azure");
  assert.equal(JSON.parse(parsed).totalSpend.amount, 48200);
});

test("renderReportSummary includes cost and waf decision data", () => {
  const cost = renderReportSummary(costReport());
  const waf = renderReportSummary(wafReport());

  assert.match(cost, /Monthly spend\s+\$48\.2k/);
  assert.match(cost, /Estimated savings\s+\$9\.7k/);
  assert.match(waf, /WAF score\s+74\/100/);
  assert.match(waf, /High risk\s+7/);
});

test("renderReportMarkdown preserves formatted report sections", () => {
  const markdown = renderReportMarkdown(wafReport());

  assert.match(markdown, /^# Well-Architected Framework report/);
  assert.match(markdown, /## Priority findings/);
  assert.match(markdown, /REL-04/);
});
