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
}

export interface GetReportOptions extends ReportClientOptions {
  reportId: string;
  projectId?: string;
  view?: ReportFormatMode;
}

export interface GetCostReportOptions extends ReportClientOptions {
  projectId?: string;
  period?: string;
  view?: string;
}

export interface GetWafReportOptions extends ReportClientOptions {
  projectId?: string;
  reportId?: string;
  severity?: string;
  view?: string;
}

export interface GetReportDetailOptions extends ReportClientOptions {
  projectId: string;
  reportType: "cost" | "waf" | "architecture";
  userId?: string;
  timestamp?: string;
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

export const fetchReportResource = async (
  options: ReportClientOptions,
  path: string,
  query: Record<string, string | undefined> = {}
): Promise<unknown> => fetchJson(options, path, query);

export const listReports = async (
  options: ListReportsOptions
): Promise<ReportEnvelope[]> => {
  const kind = options.kind && options.kind !== "all" ? options.kind : undefined;
  const raw = await fetchJson(options, "/reports", {
    project_id: options.projectId,
    kind,
  });
  return normalizeReportList(raw);
};

export const getReport = async (
  options: GetReportOptions
): Promise<ReportEnvelope> => {
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
  const raw = await fetchJson(options, "/reports/cost", {
    project_id: options.projectId,
    period: options.period,
    view: options.view,
  });
  return normalizeReportEnvelope(raw);
};

export const getWafReport = async (
  options: GetWafReportOptions
): Promise<ReportEnvelope> => {
  const raw = await fetchJson(options, "/reports/waf", {
    project_id: options.projectId,
    report_id: options.reportId,
    severity: options.severity,
    view: options.view,
  });
  return normalizeReportEnvelope(raw);
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
