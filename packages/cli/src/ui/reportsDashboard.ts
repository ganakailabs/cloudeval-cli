import {
  buildTrendSummary,
  objectEntriesAsBars,
  type OverviewBar,
  type OverviewMetric,
  type OverviewTone,
  type OverviewTrend,
} from "./overviewDashboard.js";

export interface ReportsProjectHealthRow {
  projectId: string;
  projectName: string;
  costStatus: string;
  architectureStatus: string;
  unitTestsStatus: string;
  freshness: string;
  lastReportAt?: string;
  criticalIssues: number;
  coveragePercent: number;
  isSelected: boolean;
}

export interface SelectedProjectReportSummary {
  projectId?: string;
  projectName: string;
  metrics: OverviewMetric[];
  pillarScores: OverviewBar[];
  lastReportAt?: string;
  reportStatuses?: {
    cost?: string;
    architecture?: string;
    unitTests?: string;
  };
}

export interface ReportsDashboardModel {
  metrics: OverviewMetric[];
  coverageRatio?: number;
  coverageLabel: string;
  reportTypeBars: OverviewBar[];
  statusBars: OverviewBar[];
  freshnessBars: OverviewBar[];
  activityTrend: OverviewTrend;
  projectRows: ReportsProjectHealthRow[];
  selectedProjectSummary: SelectedProjectReportSummary;
  topActions: Array<{
    label: string;
    issueCount?: number;
    priority?: string;
    pillar?: string;
  }>;
  topInsights: string[];
}

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined => {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
};

const firstNumber = (value: unknown, keys: string[]): number | undefined => {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const numberValue = asNumber(record[key]);
    if (numberValue !== undefined) {
      return numberValue;
    }
  }
  return undefined;
};

const firstString = (value: unknown, keys: string[]): string | undefined => {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const current = record[key];
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
  }
  return undefined;
};

const firstRecord = (
  value: unknown,
  path: string[]
): Record<string, unknown> | undefined => {
  let current: unknown = value;
  for (const key of path) {
    const record = toRecord(current);
    if (!record) {
      return undefined;
    }
    current = record[key];
  }
  return toRecord(current);
};

const firstArray = (value: unknown, path: string[]): unknown[] => {
  let current: unknown = value;
  for (const key of path) {
    const record = toRecord(current);
    if (!record) {
      return [];
    }
    current = record[key];
  }
  return Array.isArray(current) ? current : [];
};

const formatNumber = (value: number | undefined): string =>
  value === undefined
    ? "-"
    : new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);

const formatCurrency = (value: number | undefined, currency = "USD"): string => {
  if (value === undefined) {
    return "-";
  }
  const symbol = currency.toUpperCase() === "USD" ? "$" : `${currency.toUpperCase()} `;
  return `${symbol}${new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 0,
  }).format(value)}`;
};

const scoreOutOfTotal = (value: number | undefined): string =>
  value === undefined ? "-" : `${Math.round(value)}/100`;

const toneFromScore = (score?: number): OverviewTone => {
  if (score === undefined) return "normal";
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "danger";
};

const toneFromCount = (count?: number): OverviewTone => {
  if (!count) return "success";
  if (count <= 5) return "warning";
  return "danger";
};

const toneFromStatus = (status: string): OverviewTone => {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "fresh") return "success";
  if (normalized === "running" || normalized === "partial" || normalized === "stale") {
    return "warning";
  }
  if (normalized === "failed" || normalized === "outdated" || normalized === "missing") {
    return "danger";
  }
  return "normal";
};

const statusBars = (value: unknown): OverviewBar[] =>
  objectEntriesAsBars(value, { tone: (label) => toneFromStatus(label) });

const reportActivityValues = (reportsSummary: unknown): number[] =>
  firstArray(reportsSummary, ["report_activity", "initiated_days"])
    .map((row) => firstNumber(row, ["total_initiated"]))
    .filter((value): value is number => value !== undefined);

const extractOverallScore = (report: unknown): number | undefined =>
  firstNumber(firstRecord(report, ["parsed", "score"]), ["overall"]) ??
  firstNumber(firstRecord(report, ["dashboard"]), ["overall_score", "score"]) ??
  firstNumber(firstRecord(report, ["processed"]), ["overall_score", "score"]) ??
  firstNumber(report, ["overall_score", "score"]);

const extractPillarScores = (report: unknown): OverviewBar[] => {
  const pillarArray = firstArray(report, ["parsed", "score", "pillars"]);
  if (pillarArray.length) {
    const rows = pillarArray
      .map((item) => {
        const record = toRecord(item);
        if (!record) return undefined;
        const label = firstString(record, ["label", "id", "pillar"]);
        const value = firstNumber(record, ["score", "value"]);
        return label && value !== undefined ? { [label]: value } : undefined;
      })
      .filter(Boolean)
      .reduce<Record<string, number>>((acc, row) => ({ ...acc, ...row }), {});
    return objectEntriesAsBars(rows, { tone: (_label, value) => toneFromScore(value) });
  }

  const scores =
    firstRecord(report, ["dashboard", "pillar_scores"]) ??
    firstRecord(report, ["processed", "pillar_scores"]) ??
    firstRecord(report, ["pillar_scores"]);

  return objectEntriesAsBars(scores, { tone: (_label, value) => toneFromScore(value) });
};

const extractMonthlyCost = (report: unknown): number | undefined =>
  firstNumber(firstRecord(report, ["parsed", "totalSpend"]), ["amount"]) ??
  firstNumber(firstRecord(report, ["dashboard"]), [
    "total_monthly_cost",
    "monthly_cost",
    "monthly",
  ]) ??
  firstNumber(firstRecord(report, ["processed"]), [
    "total_monthly_cost",
    "monthly_cost",
    "monthly",
  ]) ??
  firstNumber(report, ["total_monthly_cost", "monthly_cost", "monthly"]);

const extractMonthlySavings = (report: unknown): number | undefined =>
  firstNumber(firstRecord(report, ["parsed", "estimatedSavings"]), ["amount"]) ??
  firstNumber(firstRecord(report, ["opportunity_summary"]), ["total_monthly_savings"]) ??
  firstNumber(firstRecord(report, ["dashboard", "opportunity_summary"]), [
    "total_monthly_savings",
  ]) ??
  firstNumber(firstRecord(report, ["processed", "opportunity_summary"]), [
    "total_monthly_savings",
  ]) ??
  firstNumber(firstRecord(report, ["dashboard"]), [
    "total_monthly_savings",
    "monthly_savings",
  ]) ??
  firstNumber(firstRecord(report, ["processed"]), [
    "total_monthly_savings",
    "monthly_savings",
  ]) ??
  firstNumber(report, ["total_monthly_savings", "monthly_savings"]);

const extractCurrency = (...values: unknown[]): string => {
  for (const value of values) {
    const currency =
      firstString(value, ["currency"]) ??
      firstString(firstRecord(value, ["parsed", "totalSpend"]), ["currency"]) ??
      firstString(firstRecord(value, ["dashboard"]), ["currency"]) ??
      firstString(firstRecord(value, ["processed"]), ["currency"]);
    if (currency) {
      return currency;
    }
  }
  return "USD";
};

const extractRecommendationCount = (report: unknown): number | undefined => {
  for (const path of [
    ["parsed", "recommendations"],
    ["recommendations"],
    ["top_opportunities"],
    ["opportunities"],
  ]) {
    const values = firstArray(report, path);
    if (values.length) {
      return values.length;
    }
  }
  return undefined;
};

const extractCriticalHighCount = (report: unknown): number | undefined => {
  const critical =
    firstNumber(firstRecord(report, ["parsed", "counts"]), ["critical", "criticalRisk"]) ??
    firstNumber(firstRecord(report, ["dashboard"]), ["critical_count", "critical_issues"]) ??
    firstNumber(firstRecord(report, ["processed"]), ["critical_count", "critical_issues"]) ??
    firstNumber(report, ["critical_count", "critical_issues"]);
  const high =
    firstNumber(firstRecord(report, ["parsed", "counts"]), ["high", "highRisk"]) ??
    firstNumber(firstRecord(report, ["dashboard"]), ["high_count", "high_issues"]) ??
    firstNumber(firstRecord(report, ["processed"]), ["high_count", "high_issues"]) ??
    firstNumber(report, ["high_count", "high_issues"]);

  if (critical === undefined && high === undefined) {
    return undefined;
  }
  return (critical ?? 0) + (high ?? 0);
};

const projectHealthRows = (
  reportsSummary: unknown,
  selectedProjectId?: string
): ReportsProjectHealthRow[] =>
  firstArray(reportsSummary, ["project_health"]).map((item) => {
    const record = toRecord(item) ?? {};
    const projectId = String(record.project_id ?? "");
    return {
      projectId,
      projectName: String(record.project_name ?? (projectId || "Unknown project")),
      costStatus: String(record.cost_status ?? "not_started"),
      architectureStatus: String(record.architecture_status ?? "not_started"),
      unitTestsStatus: String(record.unit_tests_status ?? "not_started"),
      freshness: String(record.freshness ?? "missing"),
      lastReportAt: firstString(record, ["last_report_at"]),
      criticalIssues: firstNumber(record, ["critical_issues"]) ?? 0,
      coveragePercent: firstNumber(record, ["coverage_percent"]) ?? 0,
      isSelected: Boolean(selectedProjectId && projectId === selectedProjectId),
    };
  });

export const buildReportsDashboardModel = ({
  dashboard,
  reportsSummary,
  selectedProject,
  costReport,
  wafReport,
}: {
  dashboard?: unknown;
  reportsSummary?: unknown;
  selectedProject?: { id?: string; name?: string } | null;
  costReport?: unknown;
  wafReport?: unknown;
}): ReportsDashboardModel => {
  const summarySignals = firstRecord(reportsSummary, ["signals"]);
  const costOpportunities = firstRecord(dashboard, ["aggregated_cost_opportunities"]);
  const currency = extractCurrency(dashboard, costReport, costOpportunities);
  const totalProjects = firstNumber(reportsSummary, ["total_projects"]) ?? 0;
  const projectsWithReports = firstNumber(reportsSummary, ["projects_with_reports"]) ?? 0;
  const coverageRatio =
    totalProjects > 0 ? Math.max(0, Math.min(1, projectsWithReports / totalProjects)) : undefined;
  const totalReports = firstNumber(reportsSummary, ["total_reports"]);
  const averageScore =
    firstNumber(dashboard, ["average_score"]) ??
    firstNumber(firstRecord(dashboard, ["aggregated_pillar_scores"]), ["overall_average"]);
  const totalMonthlyCost =
    firstNumber(dashboard, ["total_monthly_cost"]) ??
    firstNumber(firstRecord(dashboard, ["aggregated_service_breakdown"]), [
      "total_monthly_cost",
    ]);
  const criticalHigh =
    (firstNumber(summarySignals, ["critical_issues_total"]) ??
      firstNumber(firstRecord(dashboard, ["aggregated_issues"]), ["total_critical"]) ??
      0) +
    (firstNumber(summarySignals, ["high_issues_total"]) ??
      firstNumber(firstRecord(dashboard, ["aggregated_issues"]), ["total_high"]) ??
      0);
  const savingsOpportunity = firstNumber(costOpportunities, ["total_monthly_savings"]);
  const needsAttention = firstNumber(summarySignals, ["projects_needing_attention"]);

  const selectedProjectId = selectedProject?.id;
  const rows = projectHealthRows(reportsSummary, selectedProjectId);
  const selectedHealth = rows.find((row) => row.isSelected);
  const selectedProjectName =
    selectedProject?.name ?? selectedHealth?.projectName ?? "Select a project";
  const selectedWafScore = extractOverallScore(wafReport);
  const selectedMonthlyCost = extractMonthlyCost(costReport);
  const selectedSavings = extractMonthlySavings(costReport);
  const selectedCriticalHigh =
    extractCriticalHighCount(wafReport) ?? selectedHealth?.criticalIssues;
  const recommendationCount = extractRecommendationCount(costReport);

  return {
    metrics: [
      { label: "Total Reports", value: formatNumber(totalReports) },
      {
        label: "Average Score",
        value: scoreOutOfTotal(averageScore),
        tone: toneFromScore(averageScore),
      },
      {
        label: "Monthly Cost",
        value: formatCurrency(totalMonthlyCost, currency),
        tone: totalMonthlyCost ? "warning" : "normal",
      },
      {
        label: "Critical+High",
        value: formatNumber(criticalHigh),
        tone: toneFromCount(criticalHigh),
      },
      {
        label: "Savings Opportunity",
        value: formatCurrency(savingsOpportunity, currency),
        tone: savingsOpportunity ? "success" : "normal",
      },
      {
        label: "Needs Attention",
        value: formatNumber(needsAttention),
        tone: toneFromCount(needsAttention),
      },
    ],
    coverageRatio,
    coverageLabel: `${projectsWithReports} of ${totalProjects} projects have reports`,
    reportTypeBars: statusBars(firstRecord(reportsSummary, ["reports_by_type"])),
    statusBars: statusBars(firstRecord(reportsSummary, ["status_breakdown"])),
    freshnessBars: statusBars(firstRecord(reportsSummary, ["freshness_breakdown"])),
    activityTrend: {
      ...buildTrendSummary(reportActivityValues(reportsSummary), "higher-is-better"),
      label: "Report activity",
      summary: (() => {
        const trend = buildTrendSummary(
          reportActivityValues(reportsSummary),
          "higher-is-better"
        );
        if (trend.current === undefined) return "no activity";
        if (trend.delta === undefined) return `${formatNumber(trend.current)} current`;
        if (trend.delta > 0) return `+${formatNumber(trend.delta)} runs`;
        if (trend.delta < 0) return `${formatNumber(trend.delta)} runs`;
        return "unchanged";
      })(),
    },
    projectRows: rows,
    selectedProjectSummary: {
      projectId: selectedProjectId,
      projectName: selectedProjectName,
      lastReportAt: selectedHealth?.lastReportAt,
      reportStatuses: selectedHealth
        ? {
            cost: selectedHealth.costStatus,
            architecture: selectedHealth.architectureStatus,
            unitTests: selectedHealth.unitTestsStatus,
          }
        : undefined,
      metrics: [
        {
          label: "WAF Score",
          value: scoreOutOfTotal(selectedWafScore),
          tone: toneFromScore(selectedWafScore),
        },
        {
          label: "Monthly Cost",
          value: formatCurrency(selectedMonthlyCost, currency),
          tone: selectedMonthlyCost ? "warning" : "normal",
        },
        {
          label: "Savings",
          value: formatCurrency(selectedSavings, currency),
          tone: selectedSavings ? "success" : "normal",
        },
        {
          label: "Critical+High",
          value: formatNumber(selectedCriticalHigh),
          tone: toneFromCount(selectedCriticalHigh),
        },
        {
          label: "Recommendations",
          value: formatNumber(recommendationCount),
        },
      ],
      pillarScores: extractPillarScores(wafReport),
    },
    topActions: firstArray(reportsSummary, ["top_actions"])
      .map((action) => {
        const record = toRecord(action) ?? {};
        return {
          label: String(record.label ?? "Action"),
          issueCount: firstNumber(record, ["issue_count"]),
          priority: firstString(record, ["priority"]),
          pillar: firstString(record, ["pillar"]),
        };
      })
      .filter((action) => action.label.trim())
      .slice(0, 20),
    topInsights: firstArray(reportsSummary, ["top_insights"])
      .map((insight) => String(insight))
      .filter(Boolean)
      .slice(0, 20),
  };
};
