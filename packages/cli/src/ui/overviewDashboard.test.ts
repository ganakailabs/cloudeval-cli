import test from "node:test";
import assert from "node:assert/strict";
import {
  buildOverviewDashboardModel,
  buildTrendSummary,
  objectEntriesAsBars,
} from "./overviewDashboard.js";

test("builds overview dashboard model from frontend-aligned dashboard and reports payloads", () => {
  const dashboard = {
    total_projects: 3,
    active_projects: 2,
    average_score: 82,
    total_monthly_cost: 4200,
    currency: "USD",
    aggregated_issues: {
      total_critical: 2,
      total_high: 5,
      total_medium: 8,
      total_low: 13,
      by_pillar: {
        Security: 6,
        Reliability: 3,
      },
    },
    aggregated_pillar_scores: {
      pillar_scores: {
        Security: 72,
        Reliability: 91,
      },
    },
    aggregated_service_breakdown: {
      breakdown: {
        Compute: 2500,
        Storage: 700,
      },
    },
    project_health: {
      healthy_count: 1,
      needs_attention_count: 2,
      generating_count: 0,
      stale_count: 1,
    },
    historical_trends: [
      {
        timestamp: "2026-04-01T00:00:00Z",
        overall_score: 75,
        monthly_cost: 5000,
      },
      {
        timestamp: "2026-04-25T00:00:00Z",
        overall_score: 82,
        monthly_cost: 4200,
      },
    ],
  };
  const reportsSummary = {
    total_reports: 9,
    projects_with_reports: 2,
    signals: {
      critical_issues_total: 2,
      high_issues_total: 5,
      projects_needing_attention: 2,
    },
    status_breakdown: {
      completed: 6,
      failed: 1,
    },
    freshness_breakdown: {
      fresh: 4,
      stale: 2,
    },
    top_actions: [
      {
        label: "Fix exposed storage",
        issue_count: 3,
        priority: "urgent",
        pillar: "Security",
      },
    ],
    top_insights: ["2 critical issues across 2 projects"],
  };

  const model = buildOverviewDashboardModel({
    dashboard,
    reportsSummary,
    fallbackProjectCount: 0,
    fallbackConnectionCount: 0,
  });

  assert.equal(model.metrics.find((metric) => metric.label === "Projects")?.value, "3");
  assert.equal(model.metrics.find((metric) => metric.label === "Monthly Cost")?.value, "$4,200");
  assert.equal(model.trends.score.tone, "success");
  assert.equal(model.trends.cost.tone, "success");
  assert.deepEqual(
    model.pillarScores.map((bar) => [bar.label, bar.value]),
    [
      ["Reliability", 91],
      ["Security", 72],
    ]
  );
  assert.equal(model.topActions[0].label, "Fix exposed storage");
  assert.equal(model.topInsights[0], "2 critical issues across 2 projects");
});

test("buildTrendSummary handles direction-specific good and bad changes", () => {
  assert.equal(buildTrendSummary([70, 80], "higher-is-better").tone, "success");
  assert.equal(buildTrendSummary([80, 70], "higher-is-better").tone, "danger");
  assert.equal(buildTrendSummary([500, 400], "lower-is-better").tone, "success");
  assert.equal(buildTrendSummary([400, 500], "lower-is-better").tone, "danger");
});

test("objectEntriesAsBars sorts numeric object entries descending", () => {
  assert.deepEqual(objectEntriesAsBars({ a: 1, b: 4, c: "2" }), [
    { label: "b", value: 4, ratio: 1 },
    { label: "c", value: 2, ratio: 0.5 },
    { label: "a", value: 1, ratio: 0.25 },
  ]);
});
