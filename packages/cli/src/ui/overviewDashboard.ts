export type OverviewTone = "normal" | "success" | "warning" | "danger";

export interface OverviewMetric {
  label: string;
  value: string;
  tone?: OverviewTone;
}

export interface OverviewBar {
  label: string;
  value: number;
  ratio: number;
  tone?: OverviewTone;
}

export interface OverviewTrend {
  label: string;
  values: number[];
  current?: number;
  previous?: number;
  delta?: number;
  percent?: number;
  tone: OverviewTone;
  summary: string;
}

export interface OverviewDashboardModel {
  metrics: OverviewMetric[];
  trends: {
    score: OverviewTrend;
    cost: OverviewTrend;
    reports: OverviewTrend;
  };
  pillarScores: OverviewBar[];
  issuesByPillar: OverviewBar[];
  serviceCosts: OverviewBar[];
  projectHealth: OverviewBar[];
  reportStatus: OverviewBar[];
  reportFreshness: OverviewBar[];
  topActions: Array<{
    label: string;
    issueCount?: number;
    priority?: string;
    pillar?: string;
  }>;
  topInsights: string[];
}

type TrendDirection = "higher-is-better" | "lower-is-better";

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asNumber = (value: unknown): number | undefined => {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
};

const firstNumber = (
  value: unknown,
  keys: string[],
  fallback?: number
): number | undefined => {
  const record = toRecord(value);
  if (!record) {
    return fallback;
  }
  for (const key of keys) {
    const numberValue = asNumber(record[key]);
    if (numberValue !== undefined) {
      return numberValue;
    }
  }
  return fallback;
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

const toneFromScore = (score?: number): OverviewTone => {
  if (score === undefined) {
    return "normal";
  }
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "danger";
};

const toneFromCount = (count?: number): OverviewTone => {
  if (!count) return "success";
  if (count <= 5) return "warning";
  return "danger";
};

export const objectEntriesAsBars = (
  value: unknown,
  options: { tone?: (label: string, value: number) => OverviewTone | undefined } = {}
): OverviewBar[] => {
  const record = toRecord(value);
  if (!record) {
    return [];
  }
  const rows = Object.entries(record)
    .map(([label, raw]) => ({ label, value: asNumber(raw) }))
    .filter((row): row is { label: string; value: number } => row.value !== undefined)
    .sort((a, b) => b.value - a.value);
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  return rows.map((row) => {
    const tone = options.tone?.(row.label, row.value);
    return {
      ...row,
      ratio: row.value / max,
      ...(tone ? { tone } : {}),
    };
  });
};

export const buildTrendSummary = (
  values: number[],
  direction: TrendDirection
): OverviewTrend => {
  const cleanValues = values.filter((value) => Number.isFinite(value));
  const current = cleanValues.at(-1);
  const previous = cleanValues.length > 1 ? cleanValues[0] : undefined;
  if (current === undefined || previous === undefined) {
    return {
      label: "",
      values: cleanValues,
      current,
      previous,
      tone: "normal",
      summary: cleanValues.length ? "single point" : "no trend",
    };
  }
  const delta = current - previous;
  const percent = previous === 0 ? undefined : delta / Math.abs(previous);
  const isBetter =
    direction === "higher-is-better" ? delta > 0 : direction === "lower-is-better" ? delta < 0 : false;
  const isWorse =
    direction === "higher-is-better" ? delta < 0 : direction === "lower-is-better" ? delta > 0 : false;
  const tone: OverviewTone = isBetter ? "success" : isWorse ? "danger" : "normal";
  const signedDelta = delta > 0 ? `+${formatNumber(delta)}` : formatNumber(delta);
  const percentText =
    percent === undefined
      ? ""
      : ` (${percent > 0 ? "+" : ""}${Math.round(percent * 100)}%)`;
  return {
    label: "",
    values: cleanValues,
    current,
    previous,
    delta,
    percent,
    tone,
    summary: `${signedDelta}${percentText}`,
  };
};

const historicalValues = (
  dashboard: unknown,
  key: string,
  fallback?: number
): number[] => {
  const record = toRecord(dashboard);
  const trends = Array.isArray(record?.historical_trends)
    ? (record?.historical_trends as unknown[])
    : [];
  const values = trends
    .map((row) => firstNumber(row, [key]))
    .filter((value): value is number => value !== undefined);
  if (!values.length && fallback !== undefined) {
    return [fallback];
  }
  return values;
};

const reportActivityValues = (reportsSummary: unknown): number[] => {
  const days = firstRecord(reportsSummary, ["report_activity"]);
  const initiated = Array.isArray(days?.initiated_days)
    ? (days?.initiated_days as unknown[])
    : [];
  return initiated
    .map((row) => firstNumber(row, ["total_initiated"]))
    .filter((value): value is number => value !== undefined);
};

export const buildOverviewDashboardModel = ({
  dashboard,
  reportsSummary,
  fallbackProjectCount,
  fallbackConnectionCount,
}: {
  dashboard?: unknown;
  reportsSummary?: unknown;
  fallbackProjectCount: number;
  fallbackConnectionCount: number;
}): OverviewDashboardModel => {
  const dashboardRecord = toRecord(dashboard);
  const reportsRecord = toRecord(reportsSummary);
  const currency =
    typeof dashboardRecord?.currency === "string" && dashboardRecord.currency
      ? dashboardRecord.currency
      : "USD";
  const averageScore = firstNumber(dashboard, ["average_score"]);
  const totalMonthlyCost = firstNumber(dashboard, ["total_monthly_cost"]);
  const criticalIssues =
    firstNumber(firstRecord(dashboard, ["aggregated_issues"]), ["total_critical"]) ??
    firstNumber(firstRecord(reportsSummary, ["signals"]), ["critical_issues_total"], 0) ??
    0;
  const highIssues =
    firstNumber(firstRecord(dashboard, ["aggregated_issues"]), ["total_high"]) ??
    firstNumber(firstRecord(reportsSummary, ["signals"]), ["high_issues_total"], 0) ??
    0;
  const totalProjects =
    firstNumber(dashboard, ["total_projects"]) ??
    firstNumber(reportsSummary, ["total_projects"]) ??
    fallbackProjectCount;
  const activeProjects = firstNumber(dashboard, ["active_projects"]);
  const reportsTotal = firstNumber(reportsSummary, ["total_reports"]);
  const projectsWithReports = firstNumber(reportsSummary, ["projects_with_reports"]);
  const connectionSummary = firstRecord(dashboard, ["connection_summary"]);
  const connectionCount =
    firstNumber(connectionSummary, ["total_connections"]) ?? fallbackConnectionCount;

  const scoreTrend = {
    ...buildTrendSummary(
      historicalValues(dashboard, "overall_score", averageScore),
      "higher-is-better"
    ),
    label: "Architecture score",
  };
  const costTrend = {
    ...buildTrendSummary(
      historicalValues(dashboard, "monthly_cost", totalMonthlyCost),
      "lower-is-better"
    ),
    label: "Monthly cost",
  };
  const reportsTrend = {
    ...buildTrendSummary(reportActivityValues(reportsSummary), "higher-is-better"),
    label: "Report runs",
  };

  return {
    metrics: [
      { label: "Projects", value: String(totalProjects) },
      { label: "Active", value: activeProjects === undefined ? "-" : String(activeProjects) },
      {
        label: "Score",
        value: averageScore === undefined ? "-" : `${Math.round(averageScore)}`,
        tone: toneFromScore(averageScore),
      },
      {
        label: "Monthly Cost",
        value: formatCurrency(totalMonthlyCost, currency),
        tone: totalMonthlyCost ? "warning" : "normal",
      },
      {
        label: "Critical+High",
        value: String(criticalIssues + highIssues),
        tone: toneFromCount(criticalIssues + highIssues),
      },
      {
        label: "Reports",
        value:
          reportsTotal === undefined
            ? "-"
            : projectsWithReports === undefined
              ? String(reportsTotal)
              : `${reportsTotal} / ${projectsWithReports} projects`,
      },
      { label: "Connections", value: String(connectionCount) },
    ],
    trends: {
      score: scoreTrend,
      cost: costTrend,
      reports: reportsTrend,
    },
    pillarScores: objectEntriesAsBars(
      firstRecord(dashboard, ["aggregated_pillar_scores", "pillar_scores"]),
      { tone: (_label, value) => toneFromScore(value) }
    ),
    issuesByPillar: objectEntriesAsBars(firstRecord(dashboard, ["aggregated_issues", "by_pillar"]), {
      tone: (_label, value) => toneFromCount(value),
    }),
    serviceCosts: objectEntriesAsBars(
      firstRecord(dashboard, ["aggregated_service_breakdown", "breakdown"]),
      { tone: () => "warning" }
    ),
    projectHealth: objectEntriesAsBars(firstRecord(dashboard, ["project_health"]), {
      tone: (label) =>
        label.includes("healthy")
          ? "success"
          : label.includes("attention") || label.includes("stale")
            ? "warning"
            : "normal",
    }),
    reportStatus: objectEntriesAsBars(reportsRecord?.status_breakdown, {
      tone: (label) =>
        label === "completed"
          ? "success"
          : label === "failed"
            ? "danger"
            : label === "running"
              ? "warning"
              : "normal",
    }),
    reportFreshness: objectEntriesAsBars(reportsRecord?.freshness_breakdown, {
      tone: (label) =>
        label === "fresh"
          ? "success"
          : label === "missing" || label === "outdated"
            ? "danger"
            : label === "stale"
              ? "warning"
              : "normal",
    }),
    topActions: (Array.isArray(reportsRecord?.top_actions)
      ? reportsRecord?.top_actions
      : []
    )
      .map((action) => {
        const record = toRecord(action) ?? {};
        return {
          label: String(record.label ?? "Action"),
          issueCount: firstNumber(record, ["issue_count"]),
          priority: typeof record.priority === "string" ? record.priority : undefined,
          pillar: typeof record.pillar === "string" ? record.pillar : undefined,
        };
      })
      .filter((action) => action.label.trim())
      .slice(0, 5),
    topInsights: (Array.isArray(reportsRecord?.top_insights)
      ? reportsRecord?.top_insights
      : []
    )
      .map((insight) => String(insight))
      .filter(Boolean)
      .slice(0, 5),
  };
};
