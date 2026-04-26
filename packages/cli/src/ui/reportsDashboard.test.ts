import test from "node:test";
import assert from "node:assert/strict";
import { buildReportsDashboardModel } from "./reportsDashboard.js";

test("builds reports home metrics and project drilldown from frontend-aligned payloads", () => {
  const dashboard = {
    average_score: 82,
    total_monthly_cost: 4200,
    currency: "USD",
    aggregated_cost_opportunities: {
      total_monthly_savings: 1200,
      currency: "USD",
    },
  };
  const reportsSummary = {
    total_projects: 3,
    projects_with_reports: 2,
    total_reports: 9,
    reports_by_type: {
      cost: 3,
      architecture: 4,
      unit_tests: 2,
    },
    signals: {
      critical_issues_total: 2,
      high_issues_total: 5,
      projects_needing_attention: 2,
    },
    status_breakdown: {
      completed: 6,
      failed: 1,
      running: 1,
      not_started: 1,
    },
    freshness_breakdown: {
      fresh: 4,
      stale: 2,
      missing: 1,
    },
    project_health: [
      {
        project_id: "project-1",
        project_name: "Playground",
        cost_status: "completed",
        architecture_status: "completed",
        unit_tests_status: "not_started",
        freshness: "fresh",
        last_report_at: "2026-04-26T12:00:00Z",
        critical_issues: 1,
        coverage_percent: 67,
      },
    ],
    top_actions: [
      {
        label: "Resolve public storage",
        issue_count: 3,
        priority: "urgent",
        pillar: "Security",
      },
    ],
    top_insights: ["2 critical issues across 2 projects"],
    report_activity: {
      initiated_days: [
        { date: "2026-04-25", total_initiated: 2 },
        { date: "2026-04-26", total_initiated: 5 },
      ],
    },
  };

  const model = buildReportsDashboardModel({
    dashboard,
    reportsSummary,
    selectedProject: { id: "project-1", name: "Playground" },
    costReport: {
      dashboard: {
        total_monthly_cost: 310,
        currency: "USD",
      },
      opportunity_summary: {
        total_monthly_savings: 75,
      },
      recommendations: [{ id: "resize" }, { id: "commitment" }],
    },
    wafReport: {
      dashboard: {
        overall_score: 72,
        pillar_scores: {
          Security: 66,
          Reliability: 91,
        },
      },
      processed: {
        critical_count: 1,
        high_count: 3,
      },
    },
  });

  assert.equal(model.metrics.find((metric) => metric.label === "Total Reports")?.value, "9");
  assert.equal(model.metrics.find((metric) => metric.label === "Average Score")?.value, "82/100");
  assert.equal(model.metrics.find((metric) => metric.label === "Monthly Cost")?.value, "$4,200");
  assert.equal(
    model.metrics.find((metric) => metric.label === "Savings Opportunity")?.value,
    "$1,200"
  );
  assert.equal(model.coverageLabel, "2 of 3 projects have reports");
  assert.deepEqual(
    model.reportTypeBars.map((bar) => [bar.label, bar.value]),
    [
      ["architecture", 4],
      ["cost", 3],
      ["unit_tests", 2],
    ]
  );
  assert.equal(model.activityTrend.summary, "+3 runs");
  assert.equal(model.projectRows[0]?.projectName, "Playground");
  assert.equal(model.projectRows[0]?.isSelected, true);
  assert.equal(model.selectedProjectSummary.projectName, "Playground");
  assert.equal(
    model.selectedProjectSummary.metrics.find((metric) => metric.label === "WAF Score")?.value,
    "72/100"
  );
  assert.equal(
    model.selectedProjectSummary.metrics.find((metric) => metric.label === "Monthly Cost")?.value,
    "$310"
  );
  assert.equal(
    model.selectedProjectSummary.metrics.find((metric) => metric.label === "Critical+High")?.value,
    "4"
  );
  assert.equal(model.selectedProjectSummary.pillarScores[0]?.label, "Reliability");
  assert.equal(model.topActions[0]?.label, "Resolve public storage");
  assert.equal(model.topInsights[0], "2 critical issues across 2 projects");
});
