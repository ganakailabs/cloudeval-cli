import {
  normalizeReportEnvelope,
  normalizeReportList,
  type ReportEnvelope,
  type ReportKind,
  type ReportFormatMode,
} from "@cloudeval/shared";
import { getCLIHeaders, normalizeApiBase } from "./auth";

export interface ReportClientOptions {
  baseUrl: string;
  authToken?: string;
}

export interface ListReportsOptions extends ReportClientOptions {
  projectId?: string;
  kind?: ReportKind | "all";
  userId?: string;
}

export interface GetReportOptions extends ReportClientOptions {
  reportId: string;
  projectId?: string;
  view?: ReportFormatMode;
  userId?: string;
}

export interface GetCostReportOptions extends ReportClientOptions {
  projectId?: string;
  period?: string;
  view?: string;
  userId?: string;
}

export interface GetWafReportOptions extends ReportClientOptions {
  projectId?: string;
  reportId?: string;
  severity?: string;
  view?: string;
  userId?: string;
}

export interface GetReportDetailOptions extends ReportClientOptions {
  projectId: string;
  reportType: "cost" | "waf" | "architecture";
  userId?: string;
  timestamp?: string;
}

export type ReportRunType = "cost" | "waf" | "architecture" | "unit-tests" | "all";

export interface RunReportOptions extends ReportClientOptions {
  projectId: string;
  userId?: string;
  type: ReportRunType;
  region?: string;
  currency?: string;
  includeTimeSeries?: boolean;
  saveReport?: boolean;
}

export interface ReportJobStatusOptions extends ReportClientOptions {
  jobId: string;
  userId?: string;
}

const appendQuery = (
  url: URL,
  values: Record<string, string | undefined>
): URL => {
  for (const [key, value] of Object.entries(values)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }
  return url;
};

const compactErrorBody = async (response: Response): Promise<string | undefined> => {
  const body = await response.text().catch(() => "");
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 1000 ? `${trimmed.slice(0, 1000)}...` : trimmed;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringOr = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value : fallback;

const numberOr = (value: unknown, fallback = 0): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const arrayOrEmpty = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const reportTypeToKind = (value: unknown): ReportKind =>
  value === "architecture" || value === "waf" ? "waf" : "cost";

const backendReportType = (kind: ReportKind | "all" | undefined): string | undefined => {
  if (!kind || kind === "all") return undefined;
  return kind === "waf" ? "architecture" : kind;
};

const requireProjectId = (projectId: string | undefined): string => {
  if (!projectId) {
    throw new Error("Project ID is required for report requests.");
  }
  return projectId;
};

const requireUserId = (userId: string | undefined): string => {
  if (!userId) {
    throw new Error("Authenticated user ID is required for report requests.");
  }
  return userId;
};

const normalizeCostParsed = (report: Record<string, unknown>, metrics: Record<string, unknown> = {}) => {
  const parsed = isObject(report.parsed) ? report.parsed : undefined;
  if (parsed && isObject(parsed.totalSpend) && isObject(parsed.estimatedSavings)) {
    return parsed;
  }

  const processed = isObject(report.processed) ? report.processed : {};
  const dashboard = isObject(report.dashboard) ? report.dashboard : {};
  const source = { ...metrics, ...dashboard, ...processed };
  const currency = stringOr(source.currency, "USD");
  const monthly = numberOr(
    source.total_monthly_cost ?? source.monthly_cost ?? source.monthly,
    0
  );
  const savings = numberOr(
    source.total_monthly_savings ??
      (isObject(source.opportunity_summary)
        ? source.opportunity_summary.total_monthly_savings
        : undefined) ??
      source.monthly_savings,
    0
  );

  return {
    totalSpend: {
      amount: monthly,
      currency,
      changePercent: numberOr(source.change_percent, 0),
    },
    estimatedSavings: {
      amount: savings,
      currency,
      percentOfSpend: monthly > 0 ? (savings / monthly) * 100 : 0,
    },
    serviceGroups: arrayOrEmpty(
      source.service_family_breakdown ?? source.serviceGroups
    ).map((item, index) => {
      const row = isObject(item) ? item : {};
      return {
        name: stringOr(row.name ?? row.service ?? row.family, `Service ${index + 1}`),
        amount: numberOr(row.amount ?? row.monthly_cost ?? row.cost, 0),
        currency: stringOr(row.currency, currency),
        changePercent: numberOr(row.change_percent ?? row.changePercent, 0),
      };
    }),
    recommendations: arrayOrEmpty(
      source.recommendations ?? source.top_opportunities ?? source.opportunities
    ).map((item, index) => {
      const row = isObject(item) ? item : {};
      return {
        id: stringOr(row.id ?? row.resource_id, `recommendation-${index + 1}`),
        title: stringOr(row.title ?? row.recommendation ?? row.description, "Cost recommendation"),
        monthlySavings: numberOr(row.monthlySavings ?? row.monthly_savings ?? row.savings, 0),
        currency: stringOr(row.currency, currency),
        risk: stringOr(row.risk, "medium"),
      };
    }),
    anomalies: arrayOrEmpty(source.anomalies),
    budgets: arrayOrEmpty(source.budgets),
    trend: arrayOrEmpty(source.trend ?? source.time_series),
  };
};

const normalizeWafParsed = (report: Record<string, unknown>, metrics: Record<string, unknown> = {}) => {
  const parsed = isObject(report.parsed) ? report.parsed : undefined;
  if (parsed && isObject(parsed.score) && isObject(parsed.counts)) {
    return parsed;
  }

  const processed = isObject(report.processed) ? report.processed : {};
  const source = { ...metrics, ...processed };
  const pillarScores = isObject(source.pillar_scores) ? source.pillar_scores : {};
  const rules = arrayOrEmpty(report.all_rules ?? source.rules).map((item, index) => {
    const row = isObject(item) ? item : {};
    const outcome = stringOr(row.status ?? row.outcome, "pass").toLowerCase();
    return {
      id: stringOr(row.id ?? row.rule_id ?? row.name, `rule-${index + 1}`),
      pillar: stringOr(row.pillar, "Uncategorized"),
      title: stringOr(row.title ?? row.description, "Architecture rule"),
      status: outcome === "fail" || outcome === "error" ? "fail" : outcome === "warn" ? "warn" : "pass",
      severity: stringOr(row.severity, "medium").toLowerCase(),
      resource: typeof row.resource === "string" ? row.resource : undefined,
      evidence: typeof row.evidence === "string" ? row.evidence : undefined,
      recommendation:
        typeof row.recommendation === "string" ? row.recommendation : undefined,
    };
  });

  const failedRules = rules.filter((rule) => rule.status === "fail");
  const mediumRules = rules.filter((rule) => rule.severity === "medium");
  const highRules = rules.filter(
    (rule) => rule.severity === "high" || rule.severity === "critical"
  );

  return {
    score: {
      overall: numberOr(source.overall_score, 0),
      pillars: Object.entries(pillarScores).map(([id, score]) => ({
        id,
        label: id,
        score: numberOr(score, 0),
        passed: 0,
        warned: 0,
        failed: 0,
      })),
    },
    counts: {
      passed: rules.length - failedRules.length,
      highRisk: numberOr(source.high_count, highRules.length),
      mediumRisk: numberOr(source.medium_count, mediumRules.length),
      evidenceCoveragePercent: numberOr(source.evidence_coverage_percent, 0),
    },
    rules,
  };
};

const normalizeBackendReportDetail = (
  input: unknown,
  fallback: { projectId: string; reportType: "cost" | "architecture" | "waf" }
): ReportEnvelope => {
  if (!isObject(input)) {
    return normalizeReportEnvelope(input);
  }
  const report = isObject(input.report) ? input.report : input;
  const reportType = input.report_type ?? report.kind ?? fallback.reportType;
  const kind = reportTypeToKind(reportType);
  const projectId = stringOr(input.project_id ?? report.project_id, fallback.projectId);
  const generatedAt = stringOr(
    input.timestamp ??
      report.generated_at ??
      (isObject(report.metadata) ? report.metadata.generated_at : undefined),
    new Date(0).toISOString()
  );
  const parsed = kind === "waf" ? normalizeWafParsed(report) : normalizeCostParsed(report);
  return {
    id: stringOr(report.id, `${kind}:latest:${projectId}`),
    kind,
    projectId,
    generatedAt,
    source: { provider: "azure" },
    raw: report,
    parsed,
    formatted: isObject(report.formatted)
      ? normalizeReportEnvelope({ ...report, kind, project_id: projectId }).formatted
      : undefined,
  };
};

const normalizeBackendHistoryItem = (input: unknown): ReportEnvelope => {
  if (!isObject(input)) {
    return normalizeReportEnvelope(input);
  }
  const kind = reportTypeToKind(input.report_type);
  const projectId = stringOr(input.project_id, "unknown-project");
  const generatedAt = stringOr(input.generated_at, new Date(0).toISOString());
  const metrics = isObject(input.metrics) ? input.metrics : {};
  return {
    id: stringOr(input.report_id ?? input.id, `${kind}:${generatedAt}`),
    kind,
    projectId,
    generatedAt,
    source: { provider: "azure" },
    raw: input,
    parsed: kind === "waf" ? normalizeWafParsed({}, metrics) : normalizeCostParsed({}, metrics),
    formatted: {
      title: `${kind === "waf" ? "Well-Architected Framework" : "Cost"} report`,
      summary: stringOr(input.status, "Report available"),
      sections: [],
    },
  };
};

const normalizeBackendHistory = (input: unknown): ReportEnvelope[] => {
  const items = isObject(input) && Array.isArray(input.items) ? input.items : input;
  if (!Array.isArray(items)) {
    return normalizeReportList(input);
  }
  return items.map((item) => normalizeBackendHistoryItem(item));
};

const fetchJson = async (
  options: ReportClientOptions,
  path: string,
  query: Record<string, string | undefined> = {}
): Promise<unknown> => {
  const apiBase = normalizeApiBase(options.baseUrl);
  const url = appendQuery(new URL(`${apiBase}${path}`), query);
  const response = await fetch(url, {
    method: "GET",
    headers: getCLIHeaders(options.authToken),
  });

  if (!response.ok) {
    const body = await compactErrorBody(response);
    throw new Error(
      `Report request failed with status ${response.status} ${response.statusText}${
        body ? `: ${body}` : ""
      }`
    );
  }

  return response.json();
};

const postJson = async (
  options: ReportClientOptions,
  path: string,
  query: Record<string, string | undefined> = {},
  body?: unknown
): Promise<unknown> => {
  const apiBase = normalizeApiBase(options.baseUrl);
  const url = appendQuery(new URL(`${apiBase}${path}`), query);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...getCLIHeaders(options.authToken),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const bodyText = await compactErrorBody(response);
    throw new Error(
      `Report request failed with status ${response.status} ${response.statusText}${
        bodyText ? `: ${bodyText}` : ""
      }`
    );
  }

  return response.json();
};

export const fetchReportResource = async (
  options: ReportClientOptions,
  path: string,
  query: Record<string, string | undefined> = {}
): Promise<unknown> => fetchJson(options, path, query);

export const listReports = async (
  options: ListReportsOptions
): Promise<ReportEnvelope[]> => {
  const raw = await fetchJson(options, "/reports/history", {
    user_id: requireUserId(options.userId),
    project_ids: requireProjectId(options.projectId),
    report_type: backendReportType(options.kind),
  });
  return normalizeBackendHistory(raw).filter((report) => {
    if (!options.kind || options.kind === "all") return true;
    return report.kind === options.kind;
  });
};

export const getReport = async (
  options: GetReportOptions
): Promise<ReportEnvelope> => {
  if (options.reportId.startsWith("latest:") || options.reportId.startsWith("history:")) {
    const reports = await listReports({
      baseUrl: options.baseUrl,
      authToken: options.authToken,
      projectId: options.projectId,
      userId: options.userId,
      kind: "all",
    });
    const found = reports.find((report) => report.id === options.reportId);
    if (found) {
      const reportType = found.kind === "waf" ? "architecture" : "cost";
      return normalizeBackendReportDetail(
        await fetchJson(
          options,
          `/reports/detail/${encodeURIComponent(found.projectId)}/${reportType}`,
          {
            user_id: requireUserId(options.userId),
            timestamp: found.raw && isObject(found.raw) && !found.raw.is_latest
              ? found.generatedAt
              : undefined,
          }
        ),
        { projectId: found.projectId, reportType }
      );
    }
  }

  const raw = await fetchJson(
    options,
    `/reports/${encodeURIComponent(options.reportId)}`,
    { project_id: options.projectId, view: options.view }
  );
  return normalizeReportEnvelope(raw);
};

export const getCostReport = async (
  options: GetCostReportOptions
): Promise<ReportEnvelope> => {
  const projectId = requireProjectId(options.projectId);
  const raw = await fetchJson(
    options,
    `/reports/detail/${encodeURIComponent(projectId)}/cost`,
    { user_id: requireUserId(options.userId) }
  );
  return normalizeBackendReportDetail(raw, { projectId, reportType: "cost" });
};

export const getWafReport = async (
  options: GetWafReportOptions
): Promise<ReportEnvelope> => {
  const projectId = requireProjectId(options.projectId);
  const raw = await fetchJson(
    options,
    `/reports/detail/${encodeURIComponent(projectId)}/architecture`,
    { user_id: requireUserId(options.userId) }
  );
  const report = normalizeBackendReportDetail(raw, { projectId, reportType: "architecture" });
  if (options.severity && isObject(report.parsed) && Array.isArray(report.parsed.rules)) {
    return {
      ...report,
      parsed: {
        ...report.parsed,
        rules: report.parsed.rules.filter(
          (rule: unknown) =>
            isObject(rule) &&
            String(rule.severity).toLowerCase() === options.severity?.toLowerCase()
        ),
      },
    };
  }
  return report;
};

export const getReportDetail = async (
  options: GetReportDetailOptions
): Promise<unknown> =>
  fetchJson(
    options,
    `/reports/detail/${encodeURIComponent(options.projectId)}/${encodeURIComponent(
      options.reportType
    )}`,
    {
      user_id: options.userId,
      timestamp: options.timestamp,
    }
  );

export const getCostReportFull = async (
  options: ReportClientOptions & { projectId: string; userId?: string }
): Promise<unknown> =>
  fetchJson(options, `/cost-reports/${encodeURIComponent(options.projectId)}/full`, {
    user_id: options.userId,
  });

export const getWafReportFull = async (
  options: ReportClientOptions & { projectId: string; userId?: string }
): Promise<unknown> =>
  fetchJson(
    options,
    `/well-architected-reports/${encodeURIComponent(options.projectId)}/full`,
    {
      user_id: options.userId,
    }
  );

export const getCostReportHistory = async (
  options: ReportClientOptions & { projectId: string; userId?: string; timestamp?: string }
): Promise<unknown> =>
  options.timestamp
    ? fetchJson(
        options,
        `/cost-reports/${encodeURIComponent(options.projectId)}/historical/${encodeURIComponent(
          options.timestamp
        )}`,
        { user_id: options.userId }
      )
    : fetchJson(options, `/cost-reports/${encodeURIComponent(options.projectId)}/historical`, {
        user_id: options.userId,
      });

export const getWafReportHistory = async (
  options: ReportClientOptions & { projectId: string; userId?: string; timestamp?: string }
): Promise<unknown> =>
  options.timestamp
    ? fetchJson(
        options,
        `/well-architected-reports/${encodeURIComponent(
          options.projectId
        )}/history/${encodeURIComponent(options.timestamp)}`,
        { user_id: options.userId }
      )
    : fetchJson(
        options,
        `/well-architected-reports/${encodeURIComponent(options.projectId)}/history`,
        { user_id: options.userId }
      );

const reportRunTypes = (
  type: ReportRunType
): Array<Exclude<ReportRunType, "all" | "architecture">> => {
  if (type === "all") return ["cost", "waf", "unit-tests"];
  if (type === "architecture") return ["waf"];
  return [type];
};

const boolQuery = (value: boolean | undefined): string | undefined =>
  value === undefined ? undefined : String(Boolean(value));

export const runReports = async (options: RunReportOptions): Promise<unknown[]> => {
  const projectId = requireProjectId(options.projectId);
  const userId = requireUserId(options.userId);
  const results: unknown[] = [];

  for (const type of reportRunTypes(options.type)) {
    if (type === "cost") {
      results.push(
        await postJson(options, `/cost-reports/${encodeURIComponent(projectId)}/regenerate`, {
          user_id: userId,
          region: options.region,
          currency: options.currency,
          include_time_series: boolQuery(options.includeTimeSeries),
          save_report: boolQuery(options.saveReport),
        })
      );
      continue;
    }

    if (type === "waf") {
      results.push(
        await postJson(
          options,
          `/well-architected-reports/${encodeURIComponent(projectId)}/regenerate`,
          {
            user_id: userId,
            save_report: boolQuery(options.saveReport),
          }
        )
      );
      continue;
    }

    results.push(
      await postJson(options, `/reports/${encodeURIComponent(projectId)}/unit-tests/regenerate`, {
        user_id: userId,
      })
    );
  }

  return results;
};

export const getReportJobStatus = async (
  options: ReportJobStatusOptions
): Promise<unknown> =>
  fetchJson(options, `/jobs/${encodeURIComponent(options.jobId)}`, {
    user_id: requireUserId(options.userId),
  });
