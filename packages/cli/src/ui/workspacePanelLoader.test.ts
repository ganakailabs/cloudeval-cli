import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReportsSummaryFromHistory,
  loadWorkspacePanelData,
} from "./workspacePanelLoader.js";

const projects = [
  { id: "project-main", name: "Playground", user_id: "user-1", cloud_provider: "azure" },
  { id: "project-empty", name: "Empty", user_id: "user-1", cloud_provider: "aws" },
];

const reportsHistory = {
  items: [
    {
      report_id: "cost-current",
      project_id: "project-main",
      project_name: "Playground",
      report_type: "cost",
      generated_at: "2026-04-26T00:00:00.000Z",
      status: "completed",
      metrics: { monthly_cost: 42, currency: "USD", monthly_savings: 7 },
    },
    {
      report_id: "waf-current",
      project_id: "project-main",
      project_name: "Playground",
      report_type: "architecture",
      generated_at: "2026-04-26T00:00:01.000Z",
      status: "completed",
      metrics: { overall_score: 91, high_count: 1 },
    },
  ],
  total_count: 2,
};

test("buildReportsSummaryFromHistory derives report dashboard fields from history rows", () => {
  const summary = buildReportsSummaryFromHistory({
    reportsHistory,
    projects,
    selectedProjectId: "project-main",
  });

  assert.equal(summary.total_projects, 2);
  assert.equal(summary.projects_with_reports, 1);
  assert.equal(summary.total_reports, 2);
  assert.deepEqual(summary.reports_by_type, { architecture: 1, cost: 1 });
  assert.deepEqual(summary.status_breakdown, { completed: 2 });
  assert.equal(summary.project_health[0]?.project_id, "project-main");
  assert.equal(summary.project_health[0]?.cost_status, "completed");
  assert.equal(summary.project_health[0]?.architecture_status, "completed");
  assert.equal(summary.project_health[0]?.coverage_percent, 67);
});

test("loadWorkspacePanelData falls back to report history when summary endpoints fail", async () => {
  const requestedPaths: string[] = [];
  const loaded = await loadWorkspacePanelData({
    tab: "overview",
    client: { baseUrl: "https://example.test/api/v1", authToken: "token" },
    currentUserId: "user-1",
    activeProjectId: "project-main",
    projects,
    selectedProject: projects[0],
    deps: {
      listConnections: async () => [],
      fetchReportResource: async (_client, resourcePath) => {
        requestedPaths.push(resourcePath);
        if (resourcePath === "/reports/history") {
          return reportsHistory;
        }
        throw new Error("temporarily unavailable");
      },
      getCostReportFull: async () => ({}),
      getWafReportFull: async () => ({}),
      getBillingEntitlement: async () => ({ plan: { id: "free" }, credits: { remaining: 10 } }),
      getCreditStatus: () => ({ tone: "normal", remaining: 10 }),
    },
  });

  assert(requestedPaths.includes(`/dashboard/user/user-1`));
  assert(requestedPaths.includes("/reports/summary"));
  assert(requestedPaths.includes("/reports/history"));
  assert.equal(loaded.data.reportsSummary.total_reports, 2);
  assert.equal(loaded.data.reportsHistory, reportsHistory);
  assert.deepEqual(loaded.warnings, [
    "Dashboard overview: temporarily unavailable",
    "Reports summary: temporarily unavailable",
  ]);
});

test("loadWorkspacePanelData replaces empty report summaries with history-derived data", async () => {
  const loaded = await loadWorkspacePanelData({
    tab: "overview",
    client: { baseUrl: "https://example.test/api/v1", authToken: "token" },
    currentUserId: "user-1",
    activeProjectId: "project-main",
    projects,
    selectedProject: projects[0],
    deps: {
      listConnections: async () => [],
      fetchReportResource: async (_client, resourcePath) => {
        if (resourcePath === "/reports/summary") {
          return {};
        }
        if (resourcePath === "/reports/history") {
          return reportsHistory;
        }
        return { total_projects: 2 };
      },
      getCostReportFull: async () => ({}),
      getWafReportFull: async () => ({}),
      getBillingEntitlement: async () => ({ plan: { id: "free" }, credits: { remaining: 10 } }),
      getCreditStatus: () => ({ tone: "normal", remaining: 10 }),
    },
  });

  assert.equal(loaded.data.reportsSummary.total_reports, 2);
  assert.deepEqual(loaded.warnings, []);
});
