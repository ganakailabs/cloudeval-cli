import type { Project } from "@cloudeval/core";
import type { WorkspaceTab } from "./workspaceTabs.js";

export interface WorkspacePanelLoaderClient {
  baseUrl: string;
  authToken: string;
}

export interface WorkspacePanelLoaderDeps {
  listConnections: (client: WorkspacePanelLoaderClient & { userId: string }) => Promise<unknown>;
  fetchReportResource: (
    client: WorkspacePanelLoaderClient,
    path: string,
    query?: Record<string, string | undefined>
  ) => Promise<unknown>;
  getCostReportFull: (
    client: WorkspacePanelLoaderClient & { projectId: string; userId?: string }
  ) => Promise<unknown>;
  getWafReportFull: (
    client: WorkspacePanelLoaderClient & { projectId: string; userId?: string }
  ) => Promise<unknown>;
  getBillingEntitlement: (client: WorkspacePanelLoaderClient) => Promise<unknown>;
  getBillingUsageSummary?: (
    client: WorkspacePanelLoaderClient & Record<string, unknown>
  ) => Promise<unknown>;
  getBillingUsageLedger?: (
    client: WorkspacePanelLoaderClient & Record<string, unknown>
  ) => Promise<unknown>;
  getSubscriptionBillingInfo?: (
    client: WorkspacePanelLoaderClient & Record<string, unknown>
  ) => Promise<unknown>;
  getTopUpPacks?: (client: WorkspacePanelLoaderClient) => Promise<unknown>;
  getBillingNotifications?: (client: WorkspacePanelLoaderClient & Record<string, unknown>) => Promise<unknown>;
  getCreditStatus: (entitlement: any) => unknown;
}

export interface WorkspacePanelLoadInput {
  tab: WorkspaceTab;
  client: WorkspacePanelLoaderClient;
  currentUserId?: string;
  activeProjectId?: string;
  projects: Project[];
  selectedProject?: Project | null;
  usageRange?: { startAt: string; endAt: string };
  deps: WorkspacePanelLoaderDeps;
}

export interface WorkspacePanelLoadResult {
  data: Record<string, any>;
  warnings: string[];
}

const toRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const directArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  const record = toRecord(value);
  if (!record) {
    return [];
  }
  for (const key of ["items", "data", "rows", "results", "reports"]) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
};

const firstString = (
  value: unknown,
  keys: string[],
  fallback = ""
): string => {
  const record = toRecord(value);
  if (!record) {
    return fallback;
  }
  for (const key of keys) {
    const current = record[key];
    if (typeof current === "string" && current.trim()) {
      return current.trim();
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      return String(current);
    }
  }
  return fallback;
};

const firstNumber = (value: unknown, keys: string[]): number | undefined => {
  const record = toRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const current = record[key];
    const numberValue = typeof current === "number" ? current : Number(current);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  return undefined;
};

const increment = (target: Record<string, number>, key: string) => {
  target[key] = (target[key] ?? 0) + 1;
};

const normalizeReportType = (value: string): "cost" | "architecture" | "unit_tests" => {
  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (normalized === "waf" || normalized === "architecture") {
    return "architecture";
  }
  if (normalized === "unit_tests" || normalized === "unit_test") {
    return "unit_tests";
  }
  return "cost";
};

const latestIso = (left?: string, right?: string): string | undefined => {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
};

const hasReportsSummaryPayload = (value: unknown): boolean => {
  if (!toRecord(value)) {
    return false;
  }
  return (
    firstNumber(value, ["total_reports", "total_count"]) !== undefined ||
    directArray(toRecord(value)?.project_health).length > 0 ||
    Object.keys(toRecord(value)?.reports_by_type ?? {}).length > 0 ||
    Object.keys(toRecord(value)?.status_breakdown ?? {}).length > 0
  );
};

export const buildReportsSummaryFromHistory = ({
  reportsHistory,
  projects,
  selectedProjectId,
}: {
  reportsHistory: unknown;
  projects: Array<Pick<Project, "id" | "name">>;
  selectedProjectId?: string;
}): Record<string, any> => {
  const rows = directArray(reportsHistory);
  const historyRecord = toRecord(reportsHistory);
  const totalReports =
    firstNumber(historyRecord, ["total_count", "total"]) ?? rows.length;
  const reportsByType: Record<string, number> = {};
  const statusBreakdown: Record<string, number> = {};
  const rowsByProject = new Map<string, Record<string, any>>();

  for (const item of rows) {
    const reportType = normalizeReportType(firstString(item, ["report_type", "kind"], "cost"));
    const status = firstString(item, ["status"], "completed").toLowerCase();
    const projectId = firstString(item, ["project_id", "projectId"], "unknown-project");
    const projectName =
      firstString(item, ["project_name", "projectName"]) ||
      projects.find((project) => project.id === projectId)?.name ||
      projectId;
    const generatedAt = firstString(item, ["generated_at", "generatedAt"]);
    const metrics = toRecord((toRecord(item) ?? {}).metrics) ?? {};
    const existing = rowsByProject.get(projectId) ?? {
      project_id: projectId,
      project_name: projectName,
      cost_status: "not_started",
      architecture_status: "not_started",
      unit_tests_status: "not_started",
      freshness: "missing",
      critical_issues: 0,
      coverage_percent: 0,
    };

    increment(reportsByType, reportType);
    increment(statusBreakdown, status || "completed");

    if (reportType === "cost") {
      existing.cost_status = status || "completed";
    } else if (reportType === "architecture") {
      existing.architecture_status = status || "completed";
      existing.critical_issues = Math.max(
        existing.critical_issues,
        firstNumber(metrics, ["critical_count", "critical_issues", "high_count"]) ?? 0
      );
    } else {
      existing.unit_tests_status = status || "completed";
    }
    existing.freshness = "fresh";
    existing.last_report_at = latestIso(existing.last_report_at, generatedAt);
    existing.coverage_percent = Math.round(
      ([
        existing.cost_status,
        existing.architecture_status,
        existing.unit_tests_status,
      ].filter((value) => value !== "not_started").length /
        3) *
        100
    );
    rowsByProject.set(projectId, existing);
  }

  for (const project of projects) {
    if (!rowsByProject.has(project.id)) {
      rowsByProject.set(project.id, {
        project_id: project.id,
        project_name: project.name,
        cost_status: "not_started",
        architecture_status: "not_started",
        unit_tests_status: "not_started",
        freshness: "missing",
        critical_issues: 0,
        coverage_percent: 0,
      });
    }
  }

  const projectHealth = [...rowsByProject.values()].sort((left, right) => {
    if (left.project_id === selectedProjectId) return -1;
    if (right.project_id === selectedProjectId) return 1;
    return String(left.project_name).localeCompare(String(right.project_name));
  });

  return {
    total_projects: projects.length || rowsByProject.size,
    projects_with_reports: rowsByProject.size
      ? [...rowsByProject.values()].filter((row) => row.freshness !== "missing").length
      : 0,
    total_reports: totalReports,
    reports_by_type: reportsByType,
    status_breakdown: statusBreakdown,
    freshness_breakdown: {
      fresh: projectHealth.filter((row) => row.freshness === "fresh").length,
      missing: projectHealth.filter((row) => row.freshness === "missing").length,
    },
    signals: {
      critical_issues_total: projectHealth.reduce(
        (total, row) => total + Number(row.critical_issues ?? 0),
        0
      ),
      high_issues_total: 0,
      projects_needing_attention: projectHealth.filter((row) => Number(row.critical_issues ?? 0) > 0)
        .length,
    },
    project_health: projectHealth,
    top_actions: [],
    top_insights:
      totalReports > 0
        ? [`${totalReports} report${totalReports === 1 ? "" : "s"} loaded from report history`]
        : [],
  };
};

const captureErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "request failed";

export const loadWorkspacePanelData = async ({
  tab,
  client,
  currentUserId,
  activeProjectId,
  projects,
  selectedProject,
  usageRange,
  deps,
}: WorkspacePanelLoadInput): Promise<WorkspacePanelLoadResult> => {
  const data: Record<string, any> = {};
  const warnings: string[] = [];
  const capture = async <T>(
    key: string,
    label: string,
    loader: () => Promise<T>
  ): Promise<T | undefined> => {
    try {
      const value = await loader();
      data[key] = value;
      return value;
    } catch (error) {
      warnings.push(`${label}: ${captureErrorMessage(error)}`);
      return undefined;
    }
  };

  if (tab === "overview" || tab === "connections") {
    if (currentUserId) {
      await capture("connections", "Connections", () =>
        deps.listConnections({ ...client, userId: currentUserId })
      );
    } else {
      warnings.push("Connections: user id was not returned by auth status.");
    }
  }

  if (tab === "overview" || tab === "reports") {
    if (currentUserId) {
      await capture("dashboard", "Dashboard overview", () =>
        deps.fetchReportResource(client, `/dashboard/user/${encodeURIComponent(currentUserId)}`, {
          include_historical: "true",
          days: "30",
        })
      );
      await capture("reportsSummary", "Reports summary", () =>
        deps.fetchReportResource(client, "/reports/summary", {
          user_id: currentUserId,
        })
      );
      if (tab === "reports" || !hasReportsSummaryPayload(data.reportsSummary)) {
        await capture("reportsHistory", "Reports history", () =>
          deps.fetchReportResource(client, "/reports/history", {
            user_id: currentUserId,
            include_latest: "true",
            include_metrics: "true",
            limit: "100",
            sort_order: "desc",
          })
        );
      }
      if (!hasReportsSummaryPayload(data.reportsSummary) && data.reportsHistory) {
        data.reportsSummary = buildReportsSummaryFromHistory({
          reportsHistory: data.reportsHistory,
          projects,
          selectedProjectId: selectedProject?.id ?? activeProjectId,
        });
      }
    } else {
      warnings.push("Dashboard overview: user id was not returned by auth status.");
      warnings.push("Reports summary: user id was not returned by auth status.");
    }
  }

  if (tab === "reports") {
    if (activeProjectId) {
      await capture("costReport", "Cost report", () =>
        deps.getCostReportFull({ ...client, projectId: activeProjectId, userId: currentUserId })
      );
      await capture("wafReport", "Well-Architected report", () =>
        deps.getWafReportFull({ ...client, projectId: activeProjectId, userId: currentUserId })
      );
    } else {
      warnings.push("Reports: select a project before loading full report payloads.");
    }
  }

  if (tab === "overview" || tab === "billing") {
    await capture("entitlement", "Billing entitlement", () => deps.getBillingEntitlement(client));
    if (data.entitlement) {
      data.creditStatus = deps.getCreditStatus(data.entitlement);
    }
  }

  if (tab === "billing") {
    const range = usageRange ?? {
      startAt: new Date(Date.now() - 29 * 24 * 60 * 60 * 1000).toISOString(),
      endAt: new Date().toISOString(),
    };
    if (deps.getBillingUsageSummary) {
      await capture("usageSummary", "Billing usage summary", () =>
        deps.getBillingUsageSummary?.({
          ...client,
          startAt: range.startAt,
          endAt: range.endAt,
          granularity: "day",
        }) as Promise<unknown>
      );
    }
    if (deps.getBillingUsageLedger) {
      await capture("ledger", "Billing ledger", () =>
        deps.getBillingUsageLedger?.({
          ...client,
          startAt: range.startAt,
          endAt: range.endAt,
          limit: 12,
        }) as Promise<unknown>
      );
    }
    if (deps.getSubscriptionBillingInfo) {
      await capture("billingInfo", "Billing info", () =>
        deps.getSubscriptionBillingInfo?.({ ...client, limit: 12 }) as Promise<unknown>
      );
    }
    if (deps.getTopUpPacks) {
      await capture("topups", "Top-ups", () => deps.getTopUpPacks?.(client) as Promise<unknown>);
    }
    if (deps.getBillingNotifications) {
      await capture("notifications", "Billing notifications", () =>
        deps.getBillingNotifications?.({ ...client, limit: 8 }) as Promise<unknown>
      );
    }
  }

  return { data, warnings };
};
